import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EMBEDDING_LIMITS, EmbeddingError, normalizeEmbedding, type EmbeddingAdapter } from './embeddings.ts';

type Collection = 'knowledge' | 'memory';
export interface VectorSource { id: string; text: string }
export interface RankedSource { id: string; score: number; text?: string }
interface IndexEntry { collection: Collection; sourceId: string; part: number; hash: string; vector: number[] }
interface IndexPart extends Omit<IndexEntry, 'vector'> { key: string; text: string }
export interface IndexStatus { total: number; indexed: number; pending: number }
export interface IndexResult extends IndexStatus { enabled: boolean; added: number; error?: string }
export interface RetrievalMetadata { method: 'bm25' | 'keyword' | 'hybrid' | 'vector'; fallbackReason?: string; index?: IndexStatus }
export type SearchMode = 'hybrid' | 'vector' | 'keyword';

export function searchMode(value: unknown): SearchMode {
  if (value == null || value === '') return 'hybrid';
  if (value === 'hybrid' || value === 'vector' || value === 'keyword') return value;
  throw Object.assign(new Error('mode must be hybrid, vector or keyword'), { code: 'VALIDATION_ERROR' });
}

function partsFor(collection: Collection, sources: VectorSource[]): IndexPart[] {
  return sources.flatMap(({ id, text }) => {
    const parts: IndexPart[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + EMBEDDING_LIMITS.inputChars);
      if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1;
      const partText = text.slice(start, end);
      const part = parts.length;
      if (partText.trim()) parts.push({ key: `${collection}:${id}:${part}`, collection, sourceId: id, part,
        text: partText, hash: createHash('sha256').update(partText).digest('hex') });
      if (end === text.length) break;
      start = end - EMBEDDING_LIMITS.overlapChars;
      if (/[\uDC00-\uDFFF]/u.test(text[start])) start += 1;
    }
    return parts;
  });
}

/** Reciprocal-rank fusion avoids comparing BM25 weights with cosine similarity. */
export function fuseRanks(lexical: RankedSource[], semantic: RankedSource[], limit: number): RankedSource[] {
  const scores = new Map<string, number>();
  for (const ranking of [lexical, semantic]) {
    ranking.slice(0, Math.max(40, limit * 4)).forEach(({ id }, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score: score * 61 / 2 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** A disposable, persistent exact-cosine index for the bounded local workspace. */
export class VectorIndex {
  readonly enabled: boolean;
  private filePath: string;
  private provider: EmbeddingAdapter | null;
  private profile: string;
  private entries = new Map<string, IndexEntry>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private queries = new Map<string, number[]>();
  private queryRequests = new Map<string, Promise<number[]>>();
  private minScore: number;
  private lastError: { message: string; at: string } | null = null;
  private dirty = false;

  constructor(filePath: string, provider: EmbeddingAdapter | null, { minScore = 0.3 }: { minScore?: number } = {}) {
    if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
      throw Object.assign(new Error('ORBIT_EMBEDDING_MIN_SCORE must be between -1 and 1'), { code: 'VALIDATION_ERROR' });
    }
    this.filePath = resolve(filePath);
    this.provider = provider;
    this.enabled = Boolean(provider);
    this.minScore = minScore;
    this.profile = createHash('sha256').update(`parts-v1:${EMBEDDING_LIMITS.inputChars}:${EMBEDDING_LIMITS.overlapChars}:${provider?.profile ?? 'disabled'}`).digest('hex');
  }

  async init(): Promise<this> {
    if (!this.provider) return this;
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (saved.version !== 1 || saved.profile !== this.profile || !Array.isArray(saved.entries)) return this;
      for (const entry of saved.entries) {
        if (!['knowledge', 'memory'].includes(entry?.collection) || typeof entry.sourceId !== 'string'
          || !Number.isInteger(entry.part) || entry.part < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)) continue;
        try {
          const vector = normalizeEmbedding(entry.vector, this.provider.dimensions);
          this.entries.set(`${entry.collection}:${entry.sourceId}:${entry.part}`, { collection: entry.collection, sourceId: entry.sourceId, part: entry.part, hash: entry.hash, vector });
        } catch { /* Invalid cached vectors are rebuilt from source text on demand. */ }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.recordError(new EmbeddingError('EMBEDDING_INDEX_READ_FAILED', 'Vector cache could not be read; it will be rebuilt from source text.'));
    }
    return this;
  }

  describe() {
    return { enabled: this.enabled, provider: this.enabled ? 'openai-compatible' : null, model: this.provider?.model ?? null,
      dimensions: this.provider?.dimensions ?? this.entries.values().next().value?.vector.length ?? null,
      storage: 'local-json', metric: 'cosine', minScore: this.minScore, cachedVectors: this.entries.size,
      indexBatchLimit: EMBEDDING_LIMITS.indexItems, lastError: this.lastError };
  }

  private recordError(error: unknown): string {
    const message = error instanceof EmbeddingError ? error.message : 'Vector indexing failed; keyword retrieval is still available.';
    this.lastError = { message, at: new Date().toISOString() };
    return message;
  }

  private matches(part: IndexPart, dimensions = this.provider?.dimensions): boolean {
    const entry = this.entries.get(part.key);
    return Boolean(entry && entry.hash === part.hash && (dimensions === undefined || entry.vector.length === dimensions));
  }

  status(collection: Collection, sources: VectorSource[]): IndexStatus {
    const parts = partsFor(collection, sources);
    const indexed = parts.filter((part) => this.matches(part)).length;
    return { total: parts.length, indexed, pending: parts.length - indexed };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, profile: this.profile, entries: [...this.entries.values()] }) + '\n', 'utf8');
      await rename(temporary, this.filePath);
      this.dirty = false;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async index(collection: Collection, sources: () => VectorSource[], { signal, dimensions }: { signal?: AbortSignal; dimensions?: number } = {}): Promise<IndexResult> {
    if (!this.provider) return { ...this.status(collection, sources()), enabled: false, added: 0 };
    return this.enqueue(async () => {
      const provider = this.provider!;
      const deadline = signal ?? AbortSignal.timeout(provider.timeoutMs ?? EMBEDDING_LIMITS.timeoutMs);
      const missing = partsFor(collection, sources()).filter((part) => !this.matches(part, dimensions)).slice(0, EMBEDDING_LIMITS.indexItems);
      let added = 0;
      let error: string | undefined;
      const batchSize = Math.max(1, Math.min(128, Math.floor(provider.batchSize ?? EMBEDDING_LIMITS.batchSize) || EMBEDDING_LIMITS.batchSize));
      try {
        for (let offset = 0; offset < missing.length; offset += batchSize) {
          deadline.throwIfAborted();
          const batch = missing.slice(offset, offset + batchSize);
          const result = await provider.embed(batch.map((part) => part.text), { signal: deadline });
          if (result.length !== batch.length) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding response count does not match its inputs.');
          let expected = dimensions ?? provider.dimensions;
          const vectors = result.map((value) => { const vector = normalizeEmbedding(value, expected); expected ??= vector.length; return vector; });
          // Re-read live sources after network I/O: a deleted document must not be resurrected.
          const live = new Map(partsFor(collection, sources()).map((part) => [part.key, part.hash]));
          batch.forEach(({ key, text, ...part }, index) => {
            if (live.get(key) === part.hash) { this.entries.set(key, { ...part, vector: vectors[index] }); added += 1; this.dirty = true; }
          });
        }
      } catch (cause) {
        error = this.recordError(deadline.aborted ? new EmbeddingError('EMBEDDING_TIMEOUT', 'Embedding indexing timed out; retry to continue building the index.') : cause);
      }
      if (this.dirty) {
        try { await this.persist(); } catch { error = this.recordError(new EmbeddingError('EMBEDDING_INDEX_WRITE_FAILED', 'Vector cache could not be saved to disk.')); }
      }
      if (!error) this.lastError = null;
      return { ...this.status(collection, sources()), enabled: true, added, ...(error ? { error } : {}) };
    });
  }

  private async queryVector(query: string): Promise<number[]> {
    const key = createHash('sha256').update(query).digest('hex');
    const cached = this.queries.get(key);
    if (cached) { this.queries.delete(key); this.queries.set(key, cached); return cached; }
    const pending = this.queryRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
      const vectors = await this.provider!.embed([query]);
      if (vectors.length !== 1) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding query response must contain exactly one vector.');
      const vector = normalizeEmbedding(vectors[0], this.provider!.dimensions);
      this.queries.set(key, vector);
      if (this.queries.size > EMBEDDING_LIMITS.queryCache) this.queries.delete(this.queries.keys().next().value!);
      return vector;
    })();
    this.queryRequests.set(key, request);
    try { return await request; } finally { this.queryRequests.delete(key); }
  }

  async rank(query: string, collection: Collection, sources: () => VectorSource[]): Promise<{ scores: RankedSource[]; available: boolean; index: IndexStatus; error?: string }> {
    const before = this.status(collection, sources());
    if (!this.provider || !before.total) return { scores: [], available: this.enabled, index: before };
    try {
      const signal = AbortSignal.timeout(this.provider.timeoutMs ?? EMBEDDING_LIMITS.timeoutMs);
      const queryVector = await this.queryVector(query);
      const result = await this.index(collection, sources, { signal, dimensions: queryVector.length });
      if (result.error) return { scores: [], available: false, index: result, error: result.error };
      const scores = new Map<string, RankedSource>();
      for (const part of partsFor(collection, sources())) {
        if (!this.matches(part, queryVector.length)) continue;
        const vector = this.entries.get(part.key)!.vector;
        const score = Math.max(-1, Math.min(1, vector.reduce((sum, value, index) => sum + value * queryVector[index], 0)));
        if (score >= this.minScore && (!scores.has(part.sourceId) || score > scores.get(part.sourceId)!.score)) scores.set(part.sourceId, { id: part.sourceId, score, text: part.text });
      }
      return { scores: [...scores.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)), available: true, index: this.status(collection, sources()) };
    } catch (cause) { return { scores: [], available: false, index: this.status(collection, sources()), error: this.recordError(cause) }; }
  }

  /** Serialize removals with indexing, including imports that are still in flight. */
  async remove(collection: Collection, sourceIds: string[]): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      const ids = new Set(sourceIds);
      let changed = false;
      for (const [key, entry] of this.entries) if (entry.collection === collection && ids.has(entry.sourceId)) { this.entries.delete(key); changed = true; }
      if (changed) this.dirty = true;
      if (this.dirty) { try { await this.persist(); } catch { this.recordError(new EmbeddingError('EMBEDDING_INDEX_WRITE_FAILED', 'Vector cache cleanup could not be saved to disk.')); } }
    });
  }

  async pruneMemories(liveIds: () => string[]): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      const ids = new Set(liveIds());
      let changed = false;
      for (const [key, entry] of this.entries) if (entry.collection === 'memory' && !ids.has(entry.sourceId)) { this.entries.delete(key); changed = true; }
      if (changed) this.dirty = true;
      if (this.dirty) { try { await this.persist(); } catch { this.recordError(new EmbeddingError('EMBEDDING_INDEX_WRITE_FAILED', 'Vector cache cleanup could not be saved to disk.')); } }
    });
  }
}
