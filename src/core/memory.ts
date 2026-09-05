import type { Memory, ProviderContext } from './types.ts';

const STOP_WORDS = new Set([
  '的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '请', '帮', '一下',
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'it', 'this', 'that',
]);

function terms(input: unknown): Set<string> {
  const text = String(input ?? '').toLowerCase();
  const result = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    if (!STOP_WORDS.has(word)) result.add(word);
  }
  // A tiny, dependency-free CJK tokenizer: single characters plus adjacent
  // bigrams. It is intentionally transparent and works well for short notes.
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = [...run];
    for (let index = 0; index < chars.length; index += 1) {
      if (!STOP_WORDS.has(chars[index])) result.add(chars[index]);
      if (index + 1 < chars.length) result.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return result;
}

function recencyBoost(createdAt: string): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(createdAt ?? '')) / 86_400_000);
  if (!Number.isFinite(ageDays)) return 0;
  return Math.exp(-ageDays / 45) * 0.12;
}

function rank(query: string, text: string, importance: number, createdAt: string): number {
  const q = terms(query);
  if (q.size === 0) return 0;
  const candidate = terms(text);
  let overlap = 0;
  for (const token of q) if (candidate.has(token)) overlap += 1;
  if (overlap === 0) return 0;
  return overlap / q.size + Number(importance || 0) * 0.18 + recencyBoost(createdAt);
}

export class MemoryService {
  private store: { addMemory(input: Record<string, unknown>): Promise<Memory>; listMemories(input?: Record<string, unknown>): Memory[]; getThread(id: string): { messages: Array<Record<string, unknown>> } | null };

  constructor(store: { addMemory(input: Record<string, unknown>): Promise<Memory>; listMemories(input?: Record<string, unknown>): Memory[]; getThread(id: string): { messages: Array<Record<string, unknown>> } | null }) {
    this.store = store;
  }

  async remember(text: string, options: { source?: string; threadId?: string | null; importance?: number; tags?: string[] } = {}): Promise<Memory> {
    return this.store.addMemory({
      text,
      source: options.source ?? 'explicit',
      threadId: options.threadId ?? null,
      importance: options.importance ?? 0.7,
      tags: options.tags ?? [],
    });
  }

  search(query: string, { threadId, limit = 6 }: { threadId?: string; limit?: number } = {}): Memory[] {
    const memories = this.store.listMemories({ threadId, limit: 1000 });
    return memories
      .map((memory) => ({ memory, score: rank(query, memory.text, memory.importance, memory.createdAt) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 6)))
      .map(({ memory, score }) => ({ ...memory, score: Number(score.toFixed(4)), citation: `memory:${memory.id}` }));
  }

  buildContext(threadId: string, query: string, { messageLimit = 12, memoryLimit = 6 }: { messageLimit?: number; memoryLimit?: number } = {}): ProviderContext {
    const thread = this.store.getThread(threadId);
    if (!thread) return { recentMessages: [], memories: [], citations: [] };
    const recentMessages = thread.messages.slice(-messageLimit).map((message) => ({
      id: message.id,
      role: message.role,
      agentId: message.agentId ?? null,
      content: message.content.slice(0, 6000),
      createdAt: message.createdAt,
    }));
    const memories = this.search(query, { threadId, limit: memoryLimit });
    return {
      recentMessages,
      memories,
      citations: memories.map((memory) => ({ id: memory.citation, text: memory.text, source: memory.source })),
    };
  }

  /** Extract an explicit `remember:` command from a user message. */
  parseRememberCommand(content: unknown): string | null {
    const match = String(content ?? '').match(/^\s*(?:remember|记住)\s*[:：]\s*(.+)$/isu);
    return match?.[1]?.trim() || null;
  }
}

export { terms };
