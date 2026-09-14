import { createHash } from 'node:crypto';
import { id } from './ids.ts';
import { asNonEmptyString, nowIso, type Citation, type KnowledgeChunk, type KnowledgeDocument, type KnowledgeHit } from './types.ts';
import type { JsonStore } from './store.ts';
import { fuseRanks, searchMode, type RetrievalMetadata, type SearchMode, type VectorIndex } from './vector-index.ts';

export const KNOWLEDGE_LIMITS = Object.freeze({ documentChars: 200_000, chunkChars: 1_200, overlapChars: 160, documents: 100, totalChars: 5_000_000 });
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'is', 'in', 'it', 'this', 'that', '的', '了', '是', '和', '我们', '你们', '一个', '如何', '什么']);

/** English words and Chinese bigrams for BM25 and the offline fallback. */
function tokenize(text: string): string[] {
  const result = (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter((word) => !STOP.has(word));
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1 && !STOP.has(run)) result.push(run);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const word = chars[index] + chars[index + 1];
      if (!STOP.has(word)) result.push(word);
    }
  }
  return result;
}

export function chunkDocument(documentId: string, content: string): KnowledgeChunk[] {
  const newlines: number[] = [];
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') newlines.push(index);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (newlines[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + KNOWLEDGE_LIMITS.chunkChars);
    if (end < content.length) {
      const boundary = content.lastIndexOf('\n', end - 1) + 1;
      if (boundary > start + KNOWLEDGE_LIMITS.chunkChars * 0.6) end = boundary;
      if (content.charCodeAt(end) >= 0xdc00 && content.charCodeAt(end) <= 0xdfff) end -= 1;
    }
    const text = content.slice(start, end);
    if (text.trim()) chunks.push({ id: id('chunk'), documentId, index: chunks.length, text,
      startOffset: start, endOffset: end, startLine: lineAt(start), endLine: lineAt(end - 1) });
    if (end === content.length) break;
    start = Math.max(start + 1, end - KNOWLEDGE_LIMITS.overlapChars);
    if (content.charCodeAt(start) >= 0xdc00 && content.charCodeAt(start) <= 0xdfff) start += 1;
  }
  return chunks;
}

function citationFor(document: KnowledgeDocument, chunk: KnowledgeChunk): Citation {
  return { id: `knowledge:${chunk.id}`, documentId: document.id, chunkId: chunk.id, title: document.title,
    source: document.source, text: chunk.text, startLine: chunk.startLine, endLine: chunk.endLine };
}

type KnowledgeStore = Pick<JsonStore, 'listKnowledgeDocuments' | 'listKnowledgeChunks' | 'saveKnowledgeDocument' | 'deleteKnowledgeDocument'>;

export class KnowledgeService {
  private store: KnowledgeStore;
  private vectors?: VectorIndex;
  constructor(store: KnowledgeStore, vectors?: VectorIndex) { this.store = store; this.vectors = vectors; }

  private vectorSources(threadId?: string, documentId?: string) {
    const documents = new Map(this.store.listKnowledgeDocuments({ threadId }).filter((document) => !documentId || document.id === documentId).map((document) => [document.id, document]));
    return this.store.listKnowledgeChunks([...documents.keys()]).map((chunk) => ({ id: chunk.id, text: `${documents.get(chunk.documentId)!.title}\n${chunk.text}` }));
  }

  indexStatus({ threadId }: { threadId?: string } = {}) { return this.vectors?.status('knowledge', this.vectorSources(threadId)) ?? null; }

  async reindex({ threadId }: { threadId?: string } = {}) { return this.vectors?.index('knowledge', () => this.vectorSources(threadId)) ?? null; }

  async importDocument(input: { title: string; content: string; source?: string; threadId?: string | null }) {
    const title = asNonEmptyString(input.title, 'title');
    asNonEmptyString(input.content, 'content');
    if (title.length > 200 || input.content.length > KNOWLEDGE_LIMITS.documentChars) {
      throw Object.assign(new Error('标题最多 200 字符，单个文档最多 20 万字符。'), { code: 'VALIDATION_ERROR' });
    }
    const source = input.source === undefined ? 'pasted-text' : asNonEmptyString(input.source, 'source');
    if (source.length > 1000) throw Object.assign(new Error('source is too long'), { code: 'VALIDATION_ERROR' });
    const threadId = input.threadId == null ? undefined : asNonEmptyString(input.threadId, 'threadId');
    const content = input.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const documentId = id('doc');
    const chunks = chunkDocument(documentId, content);
    const document: KnowledgeDocument = { id: documentId, title, content, source, ...(threadId ? { threadId } : {}),
      contentHash: createHash('sha256').update(content).digest('hex'), chunkCount: chunks.length, createdAt: nowIso(), updatedAt: nowIso() };
    const saved = await this.store.saveKnowledgeDocument(document, chunks);
    const indexing = this.vectors?.enabled ? await this.vectors.index('knowledge', () => this.vectorSources(saved.document.threadId, saved.document.id)) : undefined;
    const { content: omitted, ...metadata } = saved.document;
    return { document: metadata, duplicate: saved.duplicate, ...(indexing ? { indexing } : {}) };
  }

  list({ threadId }: { threadId?: string } = {}) {
    return this.store.listKnowledgeDocuments({ threadId }).map(({ content, ...metadata }) => ({ ...metadata, characterCount: content.length }));
  }

  getDocument(documentId: string, { threadId }: { threadId?: string } = {}) {
    const document = this.store.listKnowledgeDocuments({ threadId }).find((item) => item.id === documentId);
    if (!document) throw Object.assign(new Error('document not found'), { code: 'NOT_FOUND' });
    return { ...document, chunks: this.store.listKnowledgeChunks([documentId]) };
  }

  readChunk(chunkId: string, { threadId }: { threadId?: string } = {}): KnowledgeHit {
    const documents = this.store.listKnowledgeDocuments({ threadId });
    const chunk = this.store.listKnowledgeChunks(documents.map((document) => document.id)).find((item) => item.id === chunkId);
    if (!chunk) throw Object.assign(new Error('knowledge chunk not found'), { code: 'NOT_FOUND' });
    const document = documents.find((item) => item.id === chunk.documentId)!;
    return { ...chunk, title: document.title, source: document.source, score: 0, citation: citationFor(document, chunk) };
  }

  async deleteDocument(documentId: string, options: { threadId?: string } = {}) {
    const chunkIds = this.getDocument(documentId, options).chunks.map((chunk) => chunk.id);
    await this.store.deleteKnowledgeDocument(documentId, options);
    await this.vectors?.remove('knowledge', chunkIds);
  }

  async search(query: string, options: { threadId?: string; limit?: number; mode?: SearchMode } = {}): Promise<KnowledgeHit[]> {
    return (await this.searchWithMetadata(query, options)).hits;
  }

  async searchWithMetadata(query: string, { threadId, limit = 5, mode = 'hybrid' }: { threadId?: string; limit?: number; mode?: SearchMode } = {}): Promise<RetrievalMetadata & { hits: KnowledgeHit[] }> {
    const text = asNonEmptyString(query, 'query').slice(0, 2000);
    const selectedMode = searchMode(mode);
    const count = Math.max(1, Math.min(8, Math.floor(limit) || 5));
    const lexical = this.lexicalSearch(text, { threadId, limit: 40 });
    const semantic = selectedMode !== 'keyword' && this.vectors?.enabled
      ? await this.vectors.rank(text, 'knowledge', () => this.vectorSources(threadId)) : null;
    const method = semantic?.available ? (selectedMode === 'vector' ? 'vector' : 'hybrid') : 'bm25';
    const ranking = method === 'hybrid' ? fuseRanks(lexical, semantic!.scores, count)
      : method === 'vector' ? semantic!.scores.slice(0, count) : lexical.slice(0, count);
    const documents = new Map(this.store.listKnowledgeDocuments({ threadId }).map((document) => [document.id, document]));
    const chunks = new Map(this.store.listKnowledgeChunks([...documents.keys()]).map((chunk) => [chunk.id, chunk]));
    const lexicalScores = new Map(lexical.map((hit) => [hit.id, hit.score]));
    const vectorScores = new Map(semantic?.scores.map((hit) => [hit.id, hit.score]) ?? []);
    const fallbackReason = semantic?.error ?? (selectedMode === 'vector' && !this.vectors?.enabled ? 'Embedding is not configured; using BM25.' : undefined);
    const hits = ranking.flatMap(({ id, score }) => {
      const chunk = chunks.get(id);
      if (!chunk) return [];
      const document = documents.get(chunk.documentId)!;
      return [{ ...chunk, title: document.title, source: document.source, score: Number(score.toFixed(4)),
        ...(lexicalScores.has(id) ? { lexicalScore: lexicalScores.get(id) } : {}),
        ...(vectorScores.has(id) ? { vectorScore: Number(vectorScores.get(id)!.toFixed(4)) } : {}), citation: citationFor(document, chunk) }];
    });
    return { hits, method, ...(semantic ? { index: semantic.index } : {}), ...(fallbackReason ? { fallbackReason } : {}) };
  }

  private lexicalSearch(query: string, { threadId, limit = 5 }: { threadId?: string; limit?: number } = {}): KnowledgeHit[] {
    const words = [...new Set(tokenize(asNonEmptyString(query, 'query').slice(0, 2000)))].slice(0, 128);
    if (!words.length) return [];
    const documents = new Map(this.store.listKnowledgeDocuments({ threadId }).map((document) => [document.id, document]));
    const chunks = this.store.listKnowledgeChunks([...documents.keys()]);
    if (!chunks.length) return [];
    const counts = new Map<string, number>();
    const rows = chunks.map((chunk) => {
      const tokens = tokenize(`${documents.get(chunk.documentId)!.title}\n${chunk.text}`);
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const word of words) if (frequencies.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
      return { chunk, length: Math.max(1, tokens.length), frequencies };
    });
    const averageLength = rows.reduce((sum, row) => sum + row.length, 0) / rows.length;
    return rows.map(({ chunk, length, frequencies }) => {
      let score = 0;
      for (const word of words) {
        const tf = frequencies.get(word) ?? 0;
        if (!tf) continue;
        const df = counts.get(word) ?? 0;
        const inverseFrequency = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
        score += inverseFrequency * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / averageLength));
      }
      return { chunk, score };
    }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, limit).map(({ chunk, score }) => {
        const document = documents.get(chunk.documentId)!;
        return { ...chunk, title: document.title, source: document.source, score: Number(score.toFixed(4)), citation: citationFor(document, chunk) };
      });
  }
}
