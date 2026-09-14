import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEmbeddingProviderFromEnv, EMBEDDING_LIMITS, OpenAICompatibleEmbeddingProvider } from '../src/core/embeddings.ts';

test('embedding configuration is opt-in, independent of chat credentials and validates numeric settings', async (t) => {
  assert.equal(createEmbeddingProviderFromEnv({ OPENAI_API_KEY: 'chat-secret', OPENAI_MODEL: 'chat-model' }), null);
  assert.equal(createEmbeddingProviderFromEnv({ ORBIT_EMBEDDING_MODEL: ' ' }), null);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  const provider = createEmbeddingProviderFromEnv({ ORBIT_EMBEDDING_MODEL: 'local-embed', ORBIT_EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1/', OPENAI_API_KEY: 'chat-secret' });
  await provider.embed(['hello']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { model: 'local-embed', input: ['hello'], encoding_format: 'float' });
  for (const [key, value] of [['ORBIT_EMBEDDING_DIMENSIONS', 'NaN'], ['ORBIT_EMBEDDING_DIMENSIONS', '0'], ['ORBIT_EMBEDDING_BATCH_SIZE', '129'], ['ORBIT_EMBEDDING_TIMEOUT_MS', '-1']]) {
    assert.throws(() => createEmbeddingProviderFromEnv({ ORBIT_EMBEDDING_MODEL: 'fixture', [key]: value }), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => new OpenAICompatibleEmbeddingProvider({ model: 'fixture', baseUrl: 'https://secret@example.com/v1' }), { code: 'VALIDATION_ERROR' });
});

test('embedding transport batches input, restores response index order and requests float vectors', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: index ? [0, 5, 0] : [3, 0, 0] })).reverse() });
  });
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'fixture-model', apiKey: 'fixture-secret', baseUrl: 'http://127.0.0.1:9000/v1/embeddings/', batchSize: 2, dimensions: 3 });
  assert.deepEqual(await provider.embed(['one', 'two', 'three']), [[1, 0, 0], [0, 1, 0], [1, 0, 0]]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.body.input), [['one', 'two'], ['three']]);
  assert.equal(calls[0].url, 'http://127.0.0.1:9000/v1/embeddings');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].body.dimensions, 3);
  assert.equal(calls[0].body.encoding_format, 'float');
  assert.equal(provider.dimensions, 3);
});

test('cache profiles include the endpoint, model and dimensions but exclude the API key', () => {
  const config = { model: 'fixture', baseUrl: 'https://example.com/v1', dimensions: 3 };
  const original = new OpenAICompatibleEmbeddingProvider({ ...config, apiKey: 'secret-a' });
  assert.equal(original.profile, new OpenAICompatibleEmbeddingProvider({ ...config, apiKey: 'secret-b' }).profile);
  assert.notEqual(original.profile, new OpenAICompatibleEmbeddingProvider({ ...config, model: 'other' }).profile);
  assert.notEqual(original.profile, new OpenAICompatibleEmbeddingProvider({ ...config, dimensions: 4 }).profile);
  assert.notEqual(original.profile, new OpenAICompatibleEmbeddingProvider({ ...config, baseUrl: 'https://other.example.com/v1' }).profile);
  assert.ok(!original.profile.includes('secret'));
});

test('large multilingual batches stay within the aggregate request budget', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { input } = JSON.parse(options.body);
    calls += 1;
    assert.ok(input.length <= 128);
    assert.ok(input.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0) <= 240_000);
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) });
  });
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'fixture', batchSize: 128 });
  assert.equal((await provider.embed(Array.from({ length: 128 }, () => '文'.repeat(2000)))).length, 128);
  assert.ok(calls > 1);
});

test('malformed embedding responses cannot enter the index', async (t) => {
  const cases = [
    ['missing vectors', { data: [] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['missing indexes', { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['duplicate indexes', { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['out of range index', { data: [{ index: 0, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['zero vector', { data: [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 1] }] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['non numeric vector', { data: [{ index: 0, embedding: [null, 0] }, { index: 1, embedding: [0, 1] }] }, 'EMBEDDING_INVALID_RESPONSE'],
    ['inconsistent dimensions', { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }] }, 'EMBEDDING_DIMENSION_MISMATCH'],
  ];
  for (const [name, payload, code] of cases) await t.test(name, async (child) => {
    child.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(new OpenAICompatibleEmbeddingProvider({ model: 'fixture' }).embed(['one', 'two']), { code });
  });
});

test('requested dimensions and dimensions across separate batches must agree', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ index: 0, embedding: ++calls === 1 ? [1, 0] : [1, 0, 0] }] }));
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'fixture', batchSize: 1 });
  await assert.rejects(provider.embed(['one', 'two']), { code: 'EMBEDDING_DIMENSION_MISMATCH' });
  await assert.rejects(new OpenAICompatibleEmbeddingProvider({ model: 'fixture', dimensions: 2 }).embed(['one']), { code: 'EMBEDDING_DIMENSION_MISMATCH' });
});

test('remote errors are sanitized and invalid inputs do not make network calls', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return Response.json({ error: { message: 'fixture-secret private-document-text' } }, { status: 503 }); });
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'fixture', apiKey: 'fixture-secret' });
  await assert.rejects(provider.embed(['one']), (error) => error.code === 'EMBEDDING_HTTP_ERROR' && /503/.test(error.message) && !/secret|private-document/.test(error.message));
  await assert.rejects(provider.embed([' ']), { code: 'EMBEDDING_INVALID_INPUT' });
  await assert.rejects(provider.embed(['x'.repeat(EMBEDDING_LIMITS.inputChars + 1)]), { code: 'EMBEDDING_INVALID_INPUT' });
  assert.deepEqual(await provider.embed([]), []);
  assert.equal(calls, 1);
});

test('an unresponsive embedding endpoint is aborted within the configured timeout', async (t) => {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 40 });
  await assert.rejects(provider.embed(['one']), { code: 'EMBEDDING_TIMEOUT' });
});
