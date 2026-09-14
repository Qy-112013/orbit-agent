import { EmbeddingError, type EmbeddingAdapter } from '../src/core/embeddings.ts';

/** Deterministic vectors test retrieval behavior without claiming model-quality evaluation. */
export function embeddingFixture({ profile = 'fixture-v1', dimensions = 3, vectorFor = (text: string) =>
  /bicycle|cycling|两轮|骑行/i.test(text) ? [1, 0, 0] : /physician|看病|医疗/i.test(text) ? [0, 1, 0] : [0, 0, 1] } = {}) {
  const fixture = {
    profile, model: profile, dimensions, timeoutMs: 2000, calls: [] as string[][], fail: false,
    async embed(inputs: string[]): Promise<number[][]> {
      fixture.calls.push([...inputs]);
      if (fixture.fail) throw new EmbeddingError('EMBEDDING_HTTP_ERROR', 'Embedding endpoint returned HTTP 503.');
      return inputs.map(vectorFor);
    },
  } satisfies EmbeddingAdapter & { calls: string[][]; fail: boolean };
  return fixture;
}
