import { createHash } from 'node:crypto';
import { asNonEmptyString } from './types.ts';

export const EMBEDDING_LIMITS = Object.freeze({ batchSize: 32, timeoutMs: 15_000, dimensions: 16_384, inputChars: 2_000, overlapChars: 160, indexItems: 256, queryCache: 64 });

export interface EmbeddingAdapter {
  /** Stable identity of the endpoint, model and requested dimensions; never include credentials. */
  readonly profile: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly timeoutMs?: number;
  readonly batchSize?: number;
  embed(inputs: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'EmbeddingError'; this.code = code; }
}

function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${field} must be an integer between ${min} and ${max}`), { code: 'VALIDATION_ERROR' });
  }
  return value;
}

/** Validate and normalize once so cosine search is a bounded dot product. */
export function normalizeEmbedding(value: unknown, dimensions?: number): number[] {
  if (!Array.isArray(value) || !value.length || value.length > EMBEDDING_LIMITS.dimensions
    || value.some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding response contains an invalid vector.');
  }
  if (dimensions !== undefined && value.length !== dimensions) {
    throw new EmbeddingError('EMBEDDING_DIMENSION_MISMATCH', 'Embedding dimensions changed or do not match the requested dimensions.');
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding response contains a zero or invalid vector.');
  return value.map((component) => component / norm);
}

/** https://developers.openai.com/api/reference/resources/embeddings/methods/create */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingAdapter {
  readonly model: string;
  readonly profile: string;
  readonly timeoutMs: number;
  readonly batchSize: number;
  private endpoint: string;
  private apiKey?: string;
  private requestedDimensions?: number;
  private observedDimensions?: number;

  constructor({ model, apiKey, baseUrl = 'https://api.openai.com/v1', dimensions, timeoutMs = EMBEDDING_LIMITS.timeoutMs, batchSize = EMBEDDING_LIMITS.batchSize }: {
    model: string; apiKey?: string; baseUrl?: string; dimensions?: number; timeoutMs?: number; batchSize?: number;
  }) {
    this.model = asNonEmptyString(model, 'embedding.model');
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw Object.assign(new Error('embedding.baseUrl must be an HTTP(S) URL'), { code: 'VALIDATION_ERROR' }); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw Object.assign(new Error('embedding.baseUrl must be an HTTP(S) URL without credentials, query or fragment'), { code: 'VALIDATION_ERROR' });
    }
    const base = url.href.replace(/\/+$/, '');
    this.endpoint = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
    this.apiKey = apiKey?.trim() || undefined;
    this.requestedDimensions = dimensions === undefined ? undefined : integer(dimensions, 'embedding.dimensions', 1, EMBEDDING_LIMITS.dimensions);
    this.timeoutMs = integer(timeoutMs, 'embedding.timeoutMs', 1, 120_000);
    this.batchSize = integer(batchSize, 'embedding.batchSize', 1, 128);
    this.profile = createHash('sha256').update(JSON.stringify(['openai-compatible-v1', this.endpoint, this.model, this.requestedDimensions ?? null])).digest('hex');
  }

  get dimensions(): number | undefined { return this.requestedDimensions ?? this.observedDimensions; }

  async embed(inputs: string[], { signal }: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (!Array.isArray(inputs) || inputs.some((text) => typeof text !== 'string' || !text.trim() || text.length > EMBEDDING_LIMITS.inputChars)) {
      throw new EmbeddingError('EMBEDDING_INVALID_INPUT', `Embedding inputs must be non-empty strings of at most ${EMBEDDING_LIMITS.inputChars} characters.`);
    }
    const vectors: number[][] = [];
    let expected = this.dimensions;
    try {
      for (let offset = 0; offset < inputs.length;) {
        let end = offset;
        let bytes = 0;
        // UTF-8 bytes conservatively bound token counts across languages. Stay
        // below the API's 300,000-token aggregate request limit even for CJK.
        while (end < inputs.length && end - offset < this.batchSize) {
          const nextBytes = Buffer.byteLength(inputs[end], 'utf8');
          if (end > offset && bytes + nextBytes > 240_000) break;
          bytes += nextBytes;
          end += 1;
        }
        const batch = inputs.slice(offset, end);
        offset = end;
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.model, input: batch, encoding_format: 'float',
            ...(this.requestedDimensions === undefined ? {} : { dimensions: this.requestedDimensions }) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          // Remote error bodies can echo request text or credentials. Only expose the status.
          throw new EmbeddingError('EMBEDDING_HTTP_ERROR', `Embedding endpoint returned HTTP ${response.status}.`);
        }
        const payload = await response.json();
        if (!Array.isArray(payload?.data) || payload.data.length !== batch.length) {
          throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding response count does not match its inputs.');
        }
        const ordered: number[][] = new Array(batch.length);
        for (const item of payload.data) {
          if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= batch.length || ordered[item.index]) {
            throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE', 'Embedding response contains missing, duplicate or invalid indexes.');
          }
          const vector = normalizeEmbedding(item.embedding, expected);
          expected ??= vector.length;
          ordered[item.index] = vector;
        }
        vectors.push(...ordered);
      }
      this.observedDimensions = expected;
      return vectors;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new EmbeddingError('EMBEDDING_TIMEOUT', 'Embedding request timed out or was cancelled.');
      }
      throw new EmbeddingError('EMBEDDING_UNAVAILABLE', 'Embedding request failed or returned invalid JSON.');
    }
  }
}

/** Embeddings are opt-in and deliberately independent of chat/CLI credentials. */
export function createEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingAdapter | null {
  const model = env.ORBIT_EMBEDDING_MODEL?.trim();
  if (!model) return null;
  return new OpenAICompatibleEmbeddingProvider({
    model,
    apiKey: env.ORBIT_EMBEDDING_API_KEY,
    baseUrl: env.ORBIT_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1',
    ...(env.ORBIT_EMBEDDING_DIMENSIONS?.trim() ? { dimensions: Number(env.ORBIT_EMBEDDING_DIMENSIONS) } : {}),
    ...(env.ORBIT_EMBEDDING_TIMEOUT_MS?.trim() ? { timeoutMs: Number(env.ORBIT_EMBEDDING_TIMEOUT_MS) } : {}),
    ...(env.ORBIT_EMBEDDING_BATCH_SIZE?.trim() ? { batchSize: Number(env.ORBIT_EMBEDDING_BATCH_SIZE) } : {}),
  });
}
