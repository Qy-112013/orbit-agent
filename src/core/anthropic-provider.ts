import Anthropic from '@anthropic-ai/sdk';
import { EVIDENCE_INSTRUCTIONS, formatReferenceContext, referencedCitations } from './context-format.ts';
import { toProviderSchema } from './structured-output.ts';
import type { ProviderAdapter } from './contracts.ts';
import type { AgentTurnMessage, ProviderInput, ProviderResult, ProviderUsage, ToolCall } from './types.ts';

export const ANTHROPIC_DEFAULTS = Object.freeze({ model: 'claude-opus-5', effort: 'high', maxTokens: 16_000, timeoutMs: 300_000, maxRetries: 2 });
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Block = Record<string, any>;
type ApiMessage = { role: 'user' | 'assistant'; content: string | Block[] };

export function anthropicUsage(usage: any): ProviderUsage | null {
  if (!usage) return null;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return { promptTokens: (usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens, completionTokens: usage.output_tokens ?? 0, cacheReadTokens, cacheWriteTokens };
}

function transcriptMessages(transcript: AgentTurnMessage[]): ApiMessage[] {
  const messages: ApiMessage[] = [];
  for (const message of transcript) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const previous = messages.at(-1);
      // All results of one assistant turn belong in a single user message.
      if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    const content = Array.isArray(message.providerState) ? message.providerState as Block[] : [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments || '{}') })),
    ];
    messages.push({ role: 'assistant', content });
  }
  return messages;
}

/** Native Messages API adapter: adaptive thinking, prompt caching, structured output and SDK retries. */
export class AnthropicProvider implements ProviderAdapter {
  readonly id = 'anthropic';
  private client: Anthropic;
  private model: string;
  private effort: string;
  private maxTokens: number;

  constructor({ apiKey, model = ANTHROPIC_DEFAULTS.model, effort = ANTHROPIC_DEFAULTS.effort, maxTokens = ANTHROPIC_DEFAULTS.maxTokens,
    timeoutMs = ANTHROPIC_DEFAULTS.timeoutMs, maxRetries = ANTHROPIC_DEFAULTS.maxRetries, baseUrl, fetch }: {
    apiKey: string; model?: string; effort?: string; maxTokens?: number; timeoutMs?: number; maxRetries?: number; baseUrl?: string; fetch?: typeof globalThis.fetch;
  }) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries, ...(baseUrl ? { baseURL: baseUrl } : {}), ...(fetch ? { fetch } : {}) });
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
  }

  async complete({ agent, content, context, tools = [], transcript = [], responseSchema }: ProviderInput): Promise<ProviderResult> {
    const system = [
      agent?.systemPrompt ?? 'You are a helpful assistant.',
      ...(context.skills ?? []).map((skill) => `Skill: ${skill.name}\n${skill.content}`),
      EVIDENCE_INSTRUCTIONS,
    ].join('\n\n');
    const reference = formatReferenceContext(context);
    // Stable prefix first (tools, system, history); per-turn reference context goes last.
    const messages: ApiMessage[] = [
      ...(context.recentMessages ?? []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: `${message.agentId ? '[' + message.agentId + '] ' : message.role === 'system' ? '[Thread note] ' : ''}${message.content}`,
      })),
      { role: 'user', content: reference ? `Reference context:\n${reference}\n\n${content}` : content },
      ...transcriptMessages(transcript),
    ];
    if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: '[Earlier conversation continues]' });
    const request: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort, ...(responseSchema ? { format: { type: 'json_schema', schema: toProviderSchema(responseSchema.schema) } } : {}) },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      ...(tools.length ? { tools: [...tools].sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
    };
    const response: any = await this.client.beta.messages.create(request as any);
    if (response.stop_reason === 'refusal') {
      throw new Error(`anthropic refused the request${response.stop_details?.category ? ' (' + response.stop_details.category + ')' : ''}`);
    }
    const blocks: Block[] = response.content ?? [];
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
    const toolCalls: ToolCall[] = blocks.filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }));
    if (!text && !toolCalls.length) throw new Error(`anthropic returned an empty message (stop_reason: ${response.stop_reason})`);
    return {
      content: text,
      ...(toolCalls.length ? { toolCalls, providerState: blocks } : {}),
      citations: referencedCitations(text, context?.citations ?? []),
      provider: 'anthropic',
      model: response.model ?? this.model,
      usage: anthropicUsage(response.usage),
    };
  }
}
