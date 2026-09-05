import { setTimeout as delay } from 'node:timers/promises';

function lastUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function contextHint(context) {
  const memoryLine = context?.memories?.length
    ? `检索到 ${context.memories.length} 条相关记忆：${context.memories
        .slice(0, 3)
        .map((memory) => `「${memory.text.slice(0, 80)}」`)
        .join('、')}`
    : '当前没有命中的长期记忆。';
  const turnCount = context?.recentMessages?.length ?? 0;
  return `${memoryLine} 当前线程提供了 ${turnCount} 条最近消息作为上下文。`;
}

function recentConversation(context) {
  return (context?.recentMessages ?? [])
    .slice(-8)
    .map((message) => `${message.role}: ${String(message.content).slice(0, 1200)}`)
    .join('\n');
}

import type { Agent, ProviderContext, ProviderResult } from './types.ts';
import type { ProviderAdapter } from './contracts.ts';
import { createCliProvider, defaultCliCwd, type CliProvider } from './cli-provider.ts';

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
    return {
      content: `${body}\n\n> ${contextHint(context)}\n\n（当前使用 LocalProvider；配置 OpenAI 兼容接口后可切换真实模型。）`,
      citations: context?.citations?.slice(0, 4) ?? [],
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

  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', timeoutMs = 45_000 }: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async complete({ agent, content, context }: { agent: Agent; content: string; context: ProviderContext }): Promise<ProviderResult> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const messages = [
      { role: 'system', content: agent?.systemPrompt ?? 'You are a helpful assistant.' },
      {
        role: 'user',
        content: [
          content,
          recentConversation(context) ? `\n\nRecent thread context:\n${recentConversation(context)}` : '',
          context?.memories?.length
            ? `\nRelevant memory:\n${context.memories.map((memory) => `- ${memory.text}`).join('\n')}`
            : '',
        ].join(''),
      },
    ];
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `provider returned HTTP ${response.status}`);
      const contentValue = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(contentValue)
        ? contentValue.map((part) => part?.text ?? '').join('')
        : String(contentValue ?? '');
      if (!text.trim()) throw new Error('provider returned an empty message');
      return {
        content: text.trim(),
        citations: context?.citations?.slice(0, 8) ?? [],
        provider: 'openai-compatible',
        model: payload?.model ?? this.model,
        usage: payload?.usage ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
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

  async complete(input: { agent: Agent; content: string; context: ProviderContext }): Promise<ProviderResult> {
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

  async complete(input: { agent: Agent; content: string; context: ProviderContext }): Promise<ProviderResult> {
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
    if (!apiKey && !baseUrl && !model) continue;
    if (!apiKey) continue;
    registry.register(agent.id, new FallbackProvider(new OpenAICompatibleProvider({
      apiKey,
      baseUrl: baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: model || env.OPENAI_MODEL || 'gpt-4o-mini',
    })));
  }
  return registry;
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): FallbackProvider {
  const local = new LocalProvider();
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FallbackProvider(null, local);
  return new FallbackProvider(
    new OpenAICompatibleProvider({
      apiKey,
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
    }),
    local,
  );
}

export { lastUserMessage };
