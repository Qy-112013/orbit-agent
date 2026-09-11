import { EVENT, type AgentTurnMessage, type ProviderInput, type ProviderResult, type ToolCall } from './types.ts';
import type { ProviderAdapter } from './contracts.ts';
import { validateToolInput, type ToolRegistry } from './tools.ts';
import type { ToolDefinition } from './types.ts';
import { referencedCitations, toolCitations } from './context-format.ts';

export interface LoopLimits { maxSteps: number; maxToolCalls: number; maxResultChars: number }
export const DEFAULT_LOOP_LIMITS: Readonly<LoopLimits> = Object.freeze({ maxSteps: 5, maxToolCalls: 8, maxResultChars: 8_000 });
type EventSink = (type: string, payload: Record<string, unknown>) => Promise<unknown>;
export interface RunTool extends ToolDefinition { execute(input: Record<string, unknown>): Promise<unknown> }

function loopError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function validateCalls(calls: ToolCall[], seen: Set<string>) {
  const batch = new Set<string>();
  for (const call of calls) {
    if (!call || typeof call.id !== 'string' || !call.id.trim() || call.id.length > 200
      || typeof call.name !== 'string' || !call.name.trim() || call.name.length > 100
      || typeof call.arguments !== 'string' || call.arguments.length > 16_000
      || seen.has(call.id) || batch.has(call.id)) {
      throw loopError('INVALID_TOOL_CALL', '模型返回了无效、过长或重复的工具调用。');
    }
    batch.add(call.id);
  }
}

function boundedResult(serialized: string, limit: number) {
  if (serialized.length <= limit) return { content: serialized, truncated: false };
  // JSON escaping can double the preview size. Keep the wrapper valid JSON
  // and reserve room for it instead of cutting through an encoded string.
  const preview = serialized.slice(0, Math.floor((limit - 40) / 2));
  return { content: JSON.stringify({ truncated: true, preview }), truncated: true };
}

/**
 * Bounded model/tool execution beneath multi-agent orchestration.
 * Design references and the pinned Pi revision are in docs/ORIGIN-NOTES.md.
 * Only explicitly read-only tools are available to autonomous model calls.
 */
export class AgentLoop {
  readonly limits: LoopLimits;
  private provider: ProviderAdapter;
  private tools: ToolRegistry;
  private toolsEnabled: boolean;

  constructor({ provider, tools, limits = {}, toolsEnabled = true }: {
    provider: ProviderAdapter; tools: ToolRegistry; limits?: Partial<LoopLimits>; toolsEnabled?: boolean;
  }) {
    this.provider = provider;
    this.tools = tools;
    this.toolsEnabled = toolsEnabled;
    this.limits = { ...DEFAULT_LOOP_LIMITS, ...limits };
    for (const [key, maximum] of Object.entries({ maxSteps: 20, maxToolCalls: 32, maxResultChars: 32_000 })) {
      const value = this.limits[key as keyof LoopLimits];
      const minimum = key === 'maxResultChars' ? 128 : 1;
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}`);
      }
    }
  }

  describe() {
    return {
      ...this.limits, toolsEnabled: this.toolsEnabled,
      allowedTools: this.definitions().map((tool) => tool.name), toolPolicy: 'read-only',
    };
  }

  private definitions() {
    return this.toolsEnabled ? this.tools.list().filter((tool) => tool.readOnly === true) : [];
  }

  async run(input: ProviderInput, execution: { threadId: string; runId: string }, emit: EventSink, runTools: RunTool[] = []): Promise<ProviderResult> {
    const extensions = this.toolsEnabled ? runTools : [];
    const definitions = [...this.definitions(), ...extensions.map(({ execute, ...definition }) => definition)];
    const allowed = new Set(definitions.map((tool) => tool.name));
    // Each run owns its transcript, including concurrent agents.
    const transcript: AgentTurnMessage[] = [];
    const seen = new Set<string>();
    const sources = [...input.context.citations];
    let toolCalls = 0;
    let toolFailures = 0;
    let degraded = false;
    const publish: EventSink = (type, payload) => emit(type, { ...payload, ...execution, agentId: input.agent.id });

    for (let step = 1; step <= this.limits.maxSteps; step += 1) {
      const startedAt = Date.now();
      await publish(EVENT.AGENT_STEP_STARTED, { step });
      const result = await this.provider.complete({ ...input, tools: definitions, transcript: structuredClone(transcript) });
      if (result.toolCalls !== undefined && !Array.isArray(result.toolCalls)) {
        throw loopError('INVALID_TOOL_CALL', '模型的 toolCalls 必须是数组。');
      }
      const calls = result.toolCalls ?? [];
      await publish(EVENT.AGENT_STEP_COMPLETED, {
        step, provider: result.provider, model: result.model, toolCount: calls.length,
        latencyMs: Date.now() - startedAt, usage: result.usage ?? null,
      });
      if (result.metadata?.fallbackFrom) {
        degraded = true;
        await publish(EVENT.PROVIDER_FALLBACK, {
          step, from: result.metadata.fallbackFrom, provider: result.provider,
          error: String(result.metadata.fallbackError ?? '').slice(0, 500),
        });
      }
      if (calls.length === 0) {
        if (typeof result.content !== 'string' || !result.content.trim()) {
          throw loopError('EMPTY_AGENT_RESULT', '模型未返回最终回答或工具调用。');
        }
        return {
          ...result,
          citations: referencedCitations(result.content, sources),
          metadata: { ...result.metadata, agentLoop: { steps: step, toolCalls, toolFailures, degraded } },
        };
      }
      // Preflight the whole batch. Do not execute tools on the last step
      // when there is no remaining model call to consume their results.
      if (step === this.limits.maxSteps) {
        throw loopError('AGENT_STEP_LIMIT', `已达到 ${this.limits.maxSteps} 次模型调用上限，本轮已停止。`);
      }
      if (toolCalls + calls.length > this.limits.maxToolCalls) {
        throw loopError('AGENT_TOOL_LIMIT', `工具请求将超过 ${this.limits.maxToolCalls} 次上限，本轮已停止。`);
      }
      validateCalls(calls, seen);
      transcript.push({
        role: 'assistant', content: typeof result.content === 'string' ? result.content : '', toolCalls: structuredClone(calls),
        ...(typeof result.reasoningContent === 'string' ? { reasoningContent: result.reasoningContent } : {}),
      });
      for (const call of calls) {
        seen.add(call.id);
        toolCalls += 1;
        const toolStartedAt = Date.now();
        const event = { step, toolCallId: call.id, tool: call.name };
        await publish(EVENT.TOOL_STARTED, event);
        let serialized: string;
        let failure: { code: string; message: string } | undefined;
        try {
          if (!allowed.has(call.name)) throw loopError('TOOL_NOT_ALLOWED', `工具 ${call.name} 不在本轮只读工具列表中。`);
          let argumentsValue: unknown;
          try { argumentsValue = JSON.parse(call.arguments); }
          catch { throw loopError('INVALID_TOOL_ARGUMENTS', '工具参数必须是有效的 JSON 对象。'); }
          if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
            throw loopError('INVALID_TOOL_ARGUMENTS', '工具参数必须是 JSON 对象。');
          }
          const extension = extensions.find((tool) => tool.name === call.name);
          if (extension) validateToolInput(extension.inputSchema, argumentsValue);
          const value = extension
            ? await extension.execute(argumentsValue as Record<string, unknown>)
            : await this.tools.execute(call.name, argumentsValue, { ...execution, agentId: input.agent.id, maxResultChars: this.limits.maxResultChars });
          serialized = JSON.stringify(value ?? null);
          if (typeof serialized !== 'string') throw loopError('INVALID_TOOL_RESULT', '工具必须返回 JSON 数据。');
        } catch (error) {
          toolFailures += 1;
          failure = { code: String(error?.code ?? 'TOOL_ERROR'), message: String(error?.message ?? error).slice(0, 500) };
          serialized = JSON.stringify({ error: failure });
        }
        const output = boundedResult(serialized, this.limits.maxResultChars);
        if (!failure && !output.truncated) sources.push(...toolCitations(JSON.parse(output.content)));
        // A persistence failure propagates; it is not another tool failure.
        await publish(failure ? EVENT.TOOL_FAILED : EVENT.TOOL_COMPLETED, {
          ...event, latencyMs: Date.now() - toolStartedAt, resultChars: output.content.length, truncated: output.truncated,
          ...(failure ? { code: failure.code, error: failure.message } : {}),
        });
        transcript.push({ role: 'tool', toolCallId: call.id, content: output.content });
      }
    }
    throw loopError('AGENT_STEP_LIMIT', '已达到模型调用上限。');
  }
}
