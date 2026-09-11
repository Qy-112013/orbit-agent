import { STRATEGY, type Strategy } from './types.ts';
import type { Agent } from './types.ts';

const MENTION_RE = /@([\p{L}\p{N}_-]+)/gu;
const CONTROL_RE = /(^|\s)#(parallel|serial|discuss|plan)\b/iu;
const CONTROL_RE_GLOBAL = /(^|\s)#(parallel|serial|discuss|plan)\b/giu;
const ALL_ALIASES = new Set(['all', 'team', '全体', '所有人']);

function isMentionBoundary(content: string, index: number): boolean {
  const before = content[index - 1] ?? '';
  // Do not treat e-mail addresses, URLs or identifiers such as foo@bar as a
  // route instruction.
  return !/[\p{L}\p{N}_.-]/u.test(before);
}

/** Parse @mentions and choose a deterministic execution strategy. */
export interface RouteDecision {
  targets: string[];
  strategy: Strategy;
  mentions: Array<Record<string, string>>;
  unknown: string[];
  broadcast: boolean;
  cleanContent: string;
  reason: 'explicit_mention' | 'active_agent_fallback';
}

export function createRouter(registry: { get(value: unknown): Agent | null; list(): Agent[]; default(): Agent | null }) {
  return {
    route(content: unknown, thread: { activeAgentId?: string | null } = {}): RouteDecision {
      const text = String(content ?? '').trim();
      const mentions = [];
      const unknown = [];
      let broadcast = false;

      for (const match of text.matchAll(MENTION_RE)) {
        const index = match.index ?? 0;
        if (!isMentionBoundary(text, index)) continue;
        const token = match[1];
        const normalized = token.toLowerCase();
        if (ALL_ALIASES.has(normalized)) {
          broadcast = true;
          mentions.push({ token, kind: 'broadcast' });
          continue;
        }
        const agent = registry.get(token);
        if (!agent) {
          unknown.push(token);
          continue;
        }
        if (!mentions.some((item) => item.agentId === agent.id)) {
          mentions.push({ token, kind: 'agent', agentId: agent.id, name: agent.name });
        }
      }

      const targets = broadcast
        ? registry.list().map((agent) => agent.id)
        : mentions.filter((item) => item.agentId).map((item) => item.agentId);
      const fallback = thread.activeAgentId && registry.get(thread.activeAgentId)?.id;
      if (targets.length === 0) targets.push(fallback ?? registry.default()?.id);

      const explicit = text.match(CONTROL_RE)?.[2]?.toLowerCase() ?? null;
      const strategy = explicit === STRATEGY.PLAN ? STRATEGY.PLAN : explicit === STRATEGY.DISCUSS ? STRATEGY.DISCUSS : explicit === STRATEGY.SERIAL
        ? STRATEGY.SERIAL
        : explicit === STRATEGY.PARALLEL || broadcast || targets.length > 1
          ? STRATEGY.PARALLEL
          : STRATEGY.SERIAL;

      const cleanContent = text
        .replace(MENTION_RE, (full, token, offset) => {
          if (!isMentionBoundary(text, Number(offset))) return full;
          if (ALL_ALIASES.has(String(token).toLowerCase()) || registry.get(token)) return '';
          return full;
        })
        .replace(CONTROL_RE_GLOBAL, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || text;

      return {
        targets: targets.filter(Boolean),
        strategy,
        mentions,
        unknown,
        broadcast,
        cleanContent,
        reason: mentions.length > 0 ? 'explicit_mention' : 'active_agent_fallback',
      };
    },
  };
}
