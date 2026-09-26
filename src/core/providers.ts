import { setTimeout as delay } from 'node:timers/promises';
import { EVIDENCE_INSTRUCTIONS, formatReferenceContext, formatSummary, referencedCitations } from './context-format.ts';

function lastUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function contextHint(context) {
  const memoryLine = context?.memories?.length
    ? `检索到 ${context.memories.length} 条相关记忆：${context.memories
        .slice(0, 3)
        .map((memory) => `「${memory.text.slice(0, 80)}」[${memory.citation ?? 'memory:' + memory.id}]`)
        .join('、')}`
    : '当前没有命中的长期记忆。';
  const turnCount = context?.recentMessages?.length ?? 0;
  return `${memoryLine} 当前线程提供了 ${turnCount} 条最近消息${context.summary ? '及历史摘录' : ''}作为上下文。`;
}

function recentConversation(context) {
  return (context?.recentMessages ?? [])
    .slice(-8)
    .map((message) => `${message.role}: ${String(message.content).slice(0, 1200)}`)
    .join('\n');
}

import type { Agent, ProviderContext, ProviderInput, ProviderResult } from './types.ts';
import type { ProviderAdapter } from './contracts.ts';
import { createCliProvider, defaultCliCwd, type CliProvider } from './cli-provider.ts';
import { AnthropicProvider } from './anthropic-provider.ts';
import { fetchWithRetry } from './retry.ts';
import { toProviderSchema } from './structured-output.ts';
import type { ProviderUsage } from './types.ts';

export function openAIUsage(usage: any): ProviderUsage | null {
  if (!usage) return null;
  return { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: 0 };
}

/** Deterministic offline provider; makes the project demoable without secrets. */
export class LocalProvider implements ProviderAdapter {
  readonly id = 'local';
  private latencyMs: number;

  constructor({ latencyMs = 90 }: { latencyMs?: number } = {}) {
    this.latencyMs = latencyMs;
  }

  async complete({ agent, content, context }: { agent: Agent; content: string; context: ProviderContext }): Promise<ProviderResult> {
    if (this.latencyMs > 0) await delay(this.latencyMs);
    const prompt = String(content ?? '').trim();
    const role = agent?.role ?? 'Agent';
    if (context.workflow?.kind === 'planning') {
      return { content: JSON.stringify({ steps: [{ id: 'collect', title: '收集与目标相关的证据', owner: context.workflow.participants[0], dependsOn: [], acceptance: '提供可核对的来源和结论' }] }),
        provider: 'local', model: 'deterministic-v1', metadata: { demo: true } };
    }
    if (context.workflow?.kind === 'review') {
      return { content: JSON.stringify({ verdict: 'blocked', feedback: '本地演示模型不能验证任务是否完成，请配置真实 Provider。' }), provider: 'local', model: 'deterministic-v1', metadata: { demo: true } };
    }
    let body;
    if (/架构|设计|拆解|方案|architecture|design/i.test(prompt)) {
      body = [
        '我会先把问题拆成目标、边界和可验证的交付物：',
        '1. 明确输入、输出与失败路径；',
        '2. 把领域逻辑与存储/模型适配隔离；',
        '3. 为关键状态转移补一条可重复的测试。',
      ].join('\n');
    } else if (/审查|review|风险|安全|bug|漏洞/i.test(prompt)) {
      body = [
        '审查结论（本地演示）：',
        '- 先验证边界输入、重复请求和错误恢复；',
        '- 将外部模型返回视为不可信数据，限制长度并记录 provider；',
        '- 给每次执行保留 route/context/agent 轨迹，便于复盘。',
      ].join('\n');
    } else {
      body = [
        `收到。我以「${role}」视角处理这个请求。`,
        `建议先产出一个最小闭环，再逐步扩展：${prompt.slice(0, 220)}`,
        '下一步：确认验收标准，并把结果拆成可以单独验证的小任务。',
      ].join('\n');
    }
    const evidence = (context.knowledge ?? []).slice(0, 2).map((hit) => `检索原文「${hit.text.slice(0, 240)}」[${hit.citation.id}]`).join('\n\n');
    const answer = `${body}\n\n> ${contextHint(context)}${evidence ? '\n\n' + evidence : ''}\n\n（当前使用 LocalProvider；上述为演示回答和检索片段，配置真实模型后可进行分析。）`;
    return {
      content: answer,
      citations: referencedCitations(answer, context?.citations ?? []),
      provider: 'local',
      model: 'deterministic-v1',
      usage: { promptTokens: Math.ceil(prompt.length / 4), completionTokens: Math.ceil(body.length / 4) },
    };
  }
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id = 'openai-compatible';
  private apiKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxRetries: number;
  private stream: boolean;
  private sleep?: (ms: number) => Promise<unknown>;

  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', timeoutMs = 45_000, maxRetries = 2, stream = true, sleep }: {
    apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number; maxRetries?: number; stream?: boolean; sleep?: (ms: number) => Promise<unknown>;
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.stream = stream;
    this.sleep = sleep;
  }

  async complete({ agent, content, context, tools = [], transcript = [], responseSchema, onDelta }: ProviderInput): Promise<ProviderResult> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const reference = formatReferenceContext(context, { includeSummary: false });
    const summary = formatSummary(context.summary);
    // Stable prefix first (system, summary, history) so automatic prefix caching can hit; per-turn reference context goes last.
    const messages = [
      { role: 'system', content: [
        agent?.systemPrompt ?? 'You are a helpful assistant.',
        ...(context.skills ?? []).map((skill) => `Skill: ${skill.name}\n${skill.content}`),
        EVIDENCE_INSTRUCTIONS,
      ].join('\n\n') },
      ...(summary ? [{ role: 'user', content: summary }] : []),
      ...(context.recentMessages ?? []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: `${message.agentId ? '[' + message.agentId + '] ' : message.role === 'system' ? '[Thread note] ' : ''}${message.content}`,
      })),
      { role: 'user', content: reference ? `Reference context:\n${reference}\n\n${content}` : content },
      ...transcript.map((message) => message.role === 'tool'
        ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
        : { role: 'assistant', content: message.content || null,
          ...(typeof message.reasoningContent === 'string' ? { reasoning_content: message.reasoningContent } : {}),
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }),
    ];
    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    // Headers must arrive within timeoutMs (retryable); afterwards the body must keep making progress.
    const idle = new AbortController();
    const { response, attempts } = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.2,
        ...(this.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(sortedTools.length ? { tools: sortedTools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: 'auto' } : {}),
        ...(responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: responseSchema.name, schema: toProviderSchema(responseSchema.schema), strict: true } } } : {}),
      }),
    }, { timeoutMs: this.timeoutMs, timeoutScope: 'headers', signal: idle.signal, maxRetries: this.maxRetries, ...(this.sleep ? { sleep: this.sleep } : {}) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error(`provider stream idle for ${this.timeoutMs}ms`)), this.timeoutMs);
    };
    let payload: any;
    try {
      touch();
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.error?.message || `provider returned HTTP ${response.status}`);
      }
      // Servers that ignore `stream` answer with plain JSON.
      payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
        ? await readChatStream(response, { onDelta, touch })
        : await response.json().catch(() => ({}));
    } catch (error) {
      throw idle.signal.aborted ? idle.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
    const contentValue = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(contentValue)
      ? contentValue.map((part) => part?.text ?? '').join('')
      : String(contentValue ?? '');
    const rawCalls = payload?.choices?.[0]?.message?.tool_calls ?? [];
    if (!Array.isArray(rawCalls)) throw new Error('provider returned invalid tool calls');
    const toolCalls = rawCalls.map((call) => {
      if (call?.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') {
        throw new Error('provider returned an invalid function call');
      }
      return { id: call.id, name: call.function.name, arguments: call.function.arguments };
    });
    if (!text.trim() && !toolCalls.length) throw new Error('provider returned an empty message');
    return {
      content: text.trim(),
      ...(typeof payload?.choices?.[0]?.message?.reasoning_content === 'string'
        ? { reasoningContent: payload.choices[0].message.reasoning_content } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      citations: referencedCitations(text, context?.citations ?? []),
      provider: 'openai-compatible',
      model: payload?.model ?? this.model,
      usage: openAIUsage(payload?.usage),
      metadata: { attempts },
    };
  }
}

/** Folds chat-completion SSE chunks into the non-streaming response shape. */
export async function readChatStream(response: Response, { onDelta, touch }: { onDelta?: (text: string) => void; touch?: () => void } = {}): Promise<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  let buffer = '';
  let text = '';
  let reasoning: string | undefined;
  let model: string | undefined;
  let usage: unknown;
  for (let done = false; !done;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    touch?.();
    buffer += decoder.decode(chunk.value, { stream: true });
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; break; }
      const event = JSON.parse(data);
      if (event?.error) throw new Error(event.error.message || 'provider stream returned an error');
      model ??= event.model;
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (typeof delta.reasoning_content === 'string') reasoning = (reasoning ?? '') + delta.reasoning_content;
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const entry = calls.get(call.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (call.id) entry.id = call.id;
        if (call.function?.name && !entry.function.name) entry.function.name = call.function.name;
        if (call.function?.arguments) entry.function.arguments += call.function.arguments;
        calls.set(call.index, entry);
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return { model, usage, choices: [{ message: { content: text, tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) } }] };
}

export class FallbackProvider implements ProviderAdapter {
  readonly id: string;
  public lastError: string | null = null;
  private primary: ProviderAdapter | null;
  private fallback: LocalProvider;

  constructor(primary: ProviderAdapter | null, fallback: LocalProvider = new LocalProvider()) {
    this.primary = primary;
    this.fallback = fallback;
    this.id = primary?.id ? `${primary.id}-with-local-fallback` : 'fallback';
  }

  async complete(input: ProviderInput): Promise<ProviderResult> {
    if (!this.primary) return this.fallback.complete(input);
    try {
      const result = await this.primary.complete(input);
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      const fallbackResult = await this.fallback.complete(input);
      return {
        ...fallbackResult,
        metadata: {
          ...(fallbackResult.metadata ?? {}),
          fallbackFrom: this.primary.id ?? this.primary.constructor.name,
          fallbackError: this.lastError,
        },
      };
    }
  }
}

/** Routes each Agent to a named adapter while keeping one provider contract. */
export class ProviderRegistry implements ProviderAdapter {
  readonly id = 'registry';
  private providers = new Map<string, ProviderAdapter>();
  private defaultId: string;

  constructor(defaultId = 'default') {
    this.defaultId = defaultId;
  }

  register(name: string, provider: ProviderAdapter): this {
    this.providers.set(name.trim().toLowerCase(), provider);
    return this;
  }

  resolve(agent: Agent): { id: string; provider: ProviderAdapter } {
    const requested = String(agent?.provider ?? '').trim().toLowerCase();
    const id = this.providers.has(agent.id) ? agent.id : requested && requested !== 'auto' && this.providers.has(requested) ? requested : this.defaultId;
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`provider is not registered: ${id}`);
    return { id, provider };
  }

  list(): Array<{ id: string; adapter: string; default: boolean }> {
    return [...this.providers.entries()].map(([id, provider]) => ({ id, adapter: provider.id ?? provider.constructor.name, default: id === this.defaultId }));
  }

  async complete(input: ProviderInput): Promise<ProviderResult> {
    const selected = this.resolve(input.agent);
    const result = await selected.provider.complete(input);
    return { ...result, provider: result.provider ?? selected.id };
  }
}

export function createProviderRegistryFromEnv(env: NodeJS.ProcessEnv = process.env, agents: Agent[] = [], workspaceRoot?: string): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('default', createProviderFromEnv(env));
  const cliProviders = new Map<string, CliProvider>();
  const getCli = (name: string, prefix: string): CliProvider => {
    const key = name.trim().toLowerCase() === 'claude' ? 'claude-code' : name.trim().toLowerCase();
    const commandEnv = key === 'codex' ? 'ORBIT_CODEX_COMMAND' : key === 'claude-code' ? 'ORBIT_CLAUDE_COMMAND' : 'ORBIT_PI_COMMAND';
    const command = env[`${prefix}CLI_COMMAND`]?.trim() || env[commandEnv]?.trim();
    const cwd = env[`${prefix}CLI_CWD`]?.trim() || env.ORBIT_WORKSPACE_ROOT?.trim() || workspaceRoot || defaultCliCwd();
    const timeoutMs = Number(env[`${prefix}CLI_TIMEOUT_MS`] || env.ORBIT_CLI_TIMEOUT_MS) || 120_000;
    const cacheKey = `${key}|${command ?? ''}|${cwd}|${timeoutMs}`;
    const existing = cliProviders.get(cacheKey);
    if (existing) return existing;
    const provider = createCliProvider(key, {
      ...(command ? { command } : {}),
      cwd,
      workspaceRoot: env.ORBIT_WORKSPACE_ROOT?.trim() || workspaceRoot,
      timeoutMs,
      env: { ORBIT_AGENT_ID: prefix.replace(/^ORBIT_|_$/g, '').toLowerCase() },
    });
    cliProviders.set(cacheKey, provider);
    return provider;
  };
  const registerCli = (name: string, agent: Agent, prefix: string): void => {
    const provider = getCli(name, prefix);
    const key = name.trim().toLowerCase() === 'claude' ? 'claude-code' : name.trim().toLowerCase();
    registry.register(key, new FallbackProvider(provider));
    registry.register(agent.id, new FallbackProvider(provider));
  };
  for (const agent of agents) {
    const prefix = `ORBIT_${agent.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_`;
    const configuredProvider = (env[`${prefix}PROVIDER`] || env[`${prefix}CLI_PROVIDER`] || '').trim().toLowerCase();
    if (configuredProvider === 'codex' || configuredProvider === 'claude' || configuredProvider === 'claude-code' || configuredProvider === 'pi') {
      registerCli(configuredProvider, agent, prefix);
      continue;
    }
    const apiKey = env[`${prefix}API_KEY`]?.trim();
    const baseUrl = env[`${prefix}BASE_URL`]?.trim();
    const model = env[`${prefix}MODEL`]?.trim();
    if (configuredProvider === 'anthropic') {
      const anthropicKey = apiKey || env.ANTHROPIC_API_KEY?.trim();
      if (anthropicKey) registry.register(agent.id, new FallbackProvider(anthropicFromEnv(env, anthropicKey, model, baseUrl)));
      continue;
    }
    if (!apiKey && !baseUrl && !model) continue;
    if (!apiKey) continue;
    registry.register(agent.id, new FallbackProvider(new OpenAICompatibleProvider({
      apiKey,
      baseUrl: baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: model || env.OPENAI_MODEL || 'gpt-4o-mini',
      stream: env.OPENAI_STREAM !== '0',
    })));
  }
  return registry;
}

function anthropicFromEnv(env: NodeJS.ProcessEnv, apiKey: string, model?: string, baseUrl?: string): AnthropicProvider {
  const timeoutMs = Number(env.ANTHROPIC_TIMEOUT_MS);
  const maxTokens = Number(env.ANTHROPIC_MAX_TOKENS);
  const configuredModel = model || env.ANTHROPIC_MODEL?.trim();
  const configuredBaseUrl = baseUrl || env.ANTHROPIC_BASE_URL?.trim();
  return new AnthropicProvider({
    apiKey,
    ...(configuredModel ? { model: configuredModel } : {}),
    ...(env.ANTHROPIC_EFFORT?.trim() ? { effort: env.ANTHROPIC_EFFORT.trim() } : {}),
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
  });
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): FallbackProvider {
  const local = new LocalProvider();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const preferred = env.ORBIT_DEFAULT_PROVIDER?.trim().toLowerCase();
  if (anthropicKey && (preferred === 'anthropic' || (!preferred && !env.OPENAI_API_KEY?.trim()))) {
    return new FallbackProvider(anthropicFromEnv(env, anthropicKey), local);
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FallbackProvider(null, local);
  return new FallbackProvider(
    new OpenAICompatibleProvider({
      apiKey,
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      stream: env.OPENAI_STREAM !== '0',
    }),
    local,
  );
}

export { lastUserMessage };
