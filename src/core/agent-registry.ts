import { asNonEmptyString, type Agent } from './types.ts';

/**
 * Agent identity is deliberately data-driven.  The upstream roster/config
 * system supports many provider-specific profiles; Orbit keeps the useful
 * part: a stable id, a role, a prompt and a provider hint.
 */
export const DEFAULT_AGENTS = Object.freeze([
  {
    id: 'atlas',
    name: 'Atlas',
    role: '架构师',
    emoji: 'A',
    color: '#8b7cff',
    provider: 'auto',
    description: '拆解问题、设计边界、给出可执行方案',
    systemPrompt:
      '你是 Atlas，一名务实的 AI 架构师。先澄清目标与约束，再给出分层方案、关键取舍和下一步。不要编造不存在的事实。',
    aliases: ['architect', '架构师', 'atlas'],
  },
  {
    id: 'forge',
    name: 'Forge',
    role: '执行工程师',
    emoji: 'F',
    color: '#f59e70',
    provider: 'auto',
    description: '把方案落成代码、命令或操作步骤',
    systemPrompt:
      '你是 Forge，一名偏执行的工程师。输出清晰的实现步骤、接口契约和可验证结果；遇到风险要明确指出。',
    aliases: ['builder', 'engineer', 'forge', '工程师'],
  },
  {
    id: 'lens',
    name: 'Lens',
    role: '独立审查员',
    emoji: 'L',
    color: '#55c2a4',
    provider: 'auto',
    description: '从正确性、安全性和可维护性角度挑错',
    systemPrompt:
      '你是 Lens，一名独立 reviewer。优先寻找具体风险、边界条件和可复现的验证方式，结论按严重程度排序。',
    aliases: ['reviewer', 'review', 'lens', '审查员'],
  },
]);

export class AgentRegistry {
  private agents: Map<string, Agent>;
  private aliases: Map<string, string>;

  constructor(agents: readonly Agent[] = DEFAULT_AGENTS) {
    this.agents = new Map<string, Agent>();
    this.aliases = new Map<string, string>();
    for (const agent of agents) this.register(agent);
  }

  register(input: Partial<Agent> & { id: string }): Agent {
    const agent = {
      ...input,
      id: asNonEmptyString(input.id, 'agent.id').toLowerCase(),
      name: asNonEmptyString(input.name ?? input.id, 'agent.name'),
      role: asNonEmptyString(input.role ?? 'Agent', 'agent.role'),
      aliases: [...new Set([input.id, ...(Array.isArray(input.aliases) ? input.aliases : [])].map((item) => String(item).toLowerCase()))],
    };
    this.agents.set(agent.id, agent);
    for (const alias of agent.aliases) this.aliases.set(alias, agent.id);
    return agent;
  }

  get(idOrAlias: unknown): Agent | null {
    if (!idOrAlias) return null;
    const key = String(idOrAlias).replace(/^@/, '').trim().toLowerCase();
    const id = this.aliases.get(key) ?? key;
    return this.agents.get(id) ?? null;
  }

  list(): Agent[] {
    return [...this.agents.values()].map((agent) => ({ ...agent, aliases: [...agent.aliases] }));
  }

  default(): Agent | null {
    return this.agents.values().next().value ?? null;
  }
}
