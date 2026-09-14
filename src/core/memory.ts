import type { Memory, ProviderContext } from './types.ts';
import type { StoragePort } from './contracts.ts';
import { CONTEXT_LIMITS, conversationContext } from './conversation.ts';
import { fuseRanks, searchMode, type RetrievalMetadata, type SearchMode, type VectorIndex } from './vector-index.ts';

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
  private store: Pick<StoragePort, 'addMemory' | 'listMemories' | 'getThread' | 'touchThread'>;
  private vectors?: VectorIndex;

  constructor(store: Pick<StoragePort, 'addMemory' | 'listMemories' | 'getThread' | 'touchThread'>, vectors?: VectorIndex) {
    this.store = store;
    this.vectors = vectors;
  }

  private accessibleMemories(threadId?: string): Memory[] {
    return this.store.listMemories({ threadId, limit: 1000 }).filter((memory) => !memory.threadId || memory.threadId === threadId);
  }

  private vectorSources(threadId?: string, memoryId?: string) {
    return this.accessibleMemories(threadId).filter((memory) => !memoryId || memory.id === memoryId).map(({ id, text }) => ({ id, text }));
  }

  indexStatus({ threadId }: { threadId?: string } = {}) { return this.vectors?.status('memory', this.vectorSources(threadId)) ?? null; }

  async reindex({ threadId }: { threadId?: string } = {}) { return this.vectors?.index('memory', () => this.vectorSources(threadId)) ?? null; }

  async remember(text: string, options: { source?: string; threadId?: string | null; importance?: number; tags?: string[] } = {}): Promise<Memory> {
    const memory = await this.store.addMemory({
      text,
      source: options.source ?? 'explicit',
      threadId: options.threadId ?? null,
      importance: options.importance ?? 0.7,
      tags: options.tags ?? [],
    });
    if (this.vectors?.enabled) {
      await this.vectors.pruneMemories(() => this.store.listMemories({ limit: 1000 }).map((item) => item.id));
      await this.vectors.index('memory', () => this.vectorSources(memory.threadId, memory.id));
    }
    return memory;
  }

  async search(query: string, options: { threadId?: string; limit?: number; mode?: SearchMode } = {}): Promise<Memory[]> {
    return (await this.searchWithMetadata(query, options)).hits;
  }

  async searchWithMetadata(query: string, { threadId, limit = 6, mode = 'hybrid' }: { threadId?: string; limit?: number; mode?: SearchMode } = {}): Promise<RetrievalMetadata & { hits: Memory[] }> {
    const text = String(query ?? '').trim().slice(0, 2000);
    const selectedMode = searchMode(mode);
    if (!text) return { hits: [], method: 'keyword' };
    const count = Math.max(1, Math.min(20, Math.floor(limit) || 6));
    const memories = this.accessibleMemories(threadId);
    const lexical = memories
      .map((memory) => ({ id: memory.id, score: rank(text, memory.text, memory.importance, memory.createdAt) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const semantic = selectedMode !== 'keyword' && this.vectors?.enabled
      ? await this.vectors.rank(text, 'memory', () => this.vectorSources(threadId)) : null;
    const method = semantic?.available ? (selectedMode === 'vector' ? 'vector' : 'hybrid') : 'keyword';
    const ranking = method === 'hybrid' ? fuseRanks(lexical, semantic!.scores, count)
      : method === 'vector' ? semantic!.scores.slice(0, count) : lexical.slice(0, count);
    const current = new Map(this.accessibleMemories(threadId).map((memory) => [memory.id, memory]));
    const lexicalScores = new Map(lexical.map((hit) => [hit.id, hit.score]));
    const semanticHits = new Map(semantic?.scores.map((hit) => [hit.id, hit]) ?? []);
    const fallbackReason = semantic?.error ?? (selectedMode === 'vector' && !this.vectors?.enabled ? 'Embedding is not configured; using keywords.' : undefined);
    const hits = ranking.flatMap(({ id, score }) => {
      const memory = current.get(id);
      if (!memory) return [];
      const match = semanticHits.get(id);
      return [{ ...memory, score: Number(score.toFixed(4)), citation: `memory:${id}`,
        ...(lexicalScores.has(id) ? { lexicalScore: Number(lexicalScores.get(id)!.toFixed(4)) } : {}),
        ...(match ? { vectorScore: Number(match.score.toFixed(4)), ...(match.text !== memory.text ? { excerpt: match.text } : {}) } : {}) }];
    });
    return { hits, method, ...(semantic ? { index: semantic.index } : {}), ...(fallbackReason ? { fallbackReason } : {}) };
  }

  async prepareContext(threadId: string, query: string, options: { messageLimit?: number; memoryLimit?: number; excludeMessageId?: string } = {}): Promise<ProviderContext> {
    const previous = this.store.getThread(threadId)?.summary;
    const context = await this.buildContext(threadId, query, options);
    if (context.summary && context.summary.throughSequence !== previous?.throughSequence) {
      await this.store.touchThread(threadId, { summary: context.summary });
    }
    return context;
  }

  async buildContext(threadId: string, query: string, { messageLimit = 12, memoryLimit = 6, excludeMessageId }: { messageLimit?: number; memoryLimit?: number; excludeMessageId?: string } = {}): Promise<ProviderContext> {
    const thread = this.store.getThread(threadId);
    if (!thread) return { recentMessages: [], memories: [], citations: [] };
    const { recentMessages, summary } = conversationContext(thread, { messageLimit, excludeMessageId });
    let remaining = CONTEXT_LIMITS.memoryChars;
    const { hits, ...retrieval } = await this.searchWithMetadata(query, { threadId, limit: memoryLimit });
    const memories = hits.flatMap((memory) => {
      if (remaining <= 0) return [];
      const text = (memory.excerpt ?? memory.text).slice(0, Math.min(2000, remaining));
      remaining -= text.length;
      return [{ ...memory, text }];
    });
    return {
      recentMessages,
      memories,
      retrieval: { memory: retrieval },
      ...(summary ? { summary } : {}),
      contextChars: recentMessages.reduce((sum, message) => sum + message.content.length, 0) + (summary?.text.length ?? 0) + CONTEXT_LIMITS.memoryChars - remaining,
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
