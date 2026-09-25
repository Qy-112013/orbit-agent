import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, retryAfterMs } from '../src/core/retry.ts';
import { toProviderSchema } from '../src/core/structured-output.ts';
import { OpenAICompatibleProvider } from '../src/core/providers.ts';
import { AgentLoop } from '../src/core/agent-loop.ts';
import { planSchema } from '../src/core/planner.ts';

const agent = { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] };
const context = { recentMessages: [], memories: [], citations: [] };

function scripted(responses: Array<() => Response | Promise<Response>>) {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('retries 429 honouring retry-after, then succeeds', async () => {
  const sleeps: number[] = [];
  const { calls, fetchImpl } = scripted([
    () => new Response('busy', { status: 429, headers: { 'retry-after': '2' } }),
    () => new Response('ok', { status: 200 }),
  ]);
  const { response, attempts } = await fetchWithRetry('http://x', {}, { timeoutMs: 1000, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('backs off exponentially on 5xx and returns the last response when exhausted', async () => {
  const sleeps: number[] = [];
  const { fetchImpl } = scripted([() => new Response('', { status: 500 }), () => new Response('', { status: 502 }), () => new Response('', { status: 503 })]);
  const { response, attempts } = await fetchWithRetry('http://x', {}, { timeoutMs: 1000, baseDelayMs: 100, fetchImpl, random: () => 1, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(response.status, 503);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('does not retry non-transient client errors', async () => {
  const { calls, fetchImpl } = scripted([() => new Response('bad', { status: 400 })]);
  const { response } = await fetchWithRetry('http://x', {}, { timeoutMs: 1000, fetchImpl, sleep: async () => {} });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
});

test('retries network errors and rethrows after exhaustion', async () => {
  const { calls, fetchImpl } = scripted([() => { throw new TypeError('socket hang up'); }, () => { throw new TypeError('socket hang up'); }]);
  await assert.rejects(fetchWithRetry('http://x', {}, { timeoutMs: 1000, maxRetries: 1, fetchImpl, sleep: async () => {} }), /socket hang up/);
  assert.equal(calls.length, 2);
});

test('caller cancellation is never retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, fetchImpl } = scripted([() => { throw new DOMException('aborted', 'AbortError'); }]);
  await assert.rejects(fetchWithRetry('http://x', {}, { timeoutMs: 1000, signal: controller.signal, fetchImpl, sleep: async () => {} }));
  assert.equal(calls.length, 1);
});

test('parses retry-after seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(null), null);
});

test('provider schema drops unsupported keywords but keeps enums and closes objects', () => {
  const schema = toProviderSchema(planSchema(['atlas', 'lens']));
  const step = (schema as any).properties.steps.items;
  assert.equal((schema as any).properties.steps.maxItems, undefined);
  assert.equal(step.properties.title.maxLength, undefined);
  assert.deepEqual(step.properties.owner.enum, ['atlas', 'lens']);
  assert.equal(step.additionalProperties, false);
  assert.equal((schema as any).additionalProperties, false);
});

test('provider schema refuses optional properties instead of changing semantics', () => {
  assert.throws(() => toProviderSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] }), /optional properties: b/);
});

test('OpenAI-compatible provider retries, sends response_format and a cache-friendly message order', async (t) => {
  const bodies: any[] = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init.body)));
    if (calls === 1) return new Response('overloaded', { status: 503 });
    return Response.json({ model: 'fixture', choices: [{ message: { content: '{"verdict":"pass","feedback":"ok"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } } });
  });
  const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'http://fixture', sleep: async () => {} });
  const result = await provider.complete({
    agent, content: 'review this',
    context: { ...context, recentMessages: [{ id: 'm1', threadId: 't', role: 'user', content: 'earlier', sequence: 1, createdAt: '', metadata: {} }] as any,
      memories: [{ id: 'mem', text: 'remembered fact', createdAt: '' }] as any },
    responseSchema: { name: 'review', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } },
  });
  assert.equal(calls, 2);
  assert.equal(result.metadata?.attempts, 2);
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 5, cacheReadTokens: 64, cacheWriteTokens: 0 });
  const body = bodies[1];
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  // History precedes the per-turn reference context, which travels with the question.
  assert.equal(body.messages[1].content, 'earlier');
  assert.match(body.messages[2].content, /^Reference context:[\s\S]*review this$/);
});

test('agent loop passes a response schema and no tools during structured workflow phases', async () => {
  const inputs: any[] = [];
  const provider = { async complete(input: any) { inputs.push(input); return { content: '{"steps":[]}', provider: 'fixture' }; } };
  const tools = { list: () => [{ name: 'search_memory', description: 'x', inputSchema: { type: 'object' }, readOnly: true }], execute: async () => null } as any;
  const loop = new AgentLoop({ provider, tools });
  await loop.run({ agent, content: 'plan', context: { ...context, workflow: { kind: 'planning', goal: 'g', participants: ['atlas'], revision: 0 } } },
    { threadId: 't', runId: 'r' }, async () => {});
  await loop.run({ agent, content: 'answer', context }, { threadId: 't', runId: 'r2' }, async () => {});
  assert.equal(inputs[0].responseSchema.name, 'plan');
  assert.deepEqual(inputs[0].tools, []);
  assert.equal(inputs[1].responseSchema, undefined);
  assert.equal(inputs[1].tools.length, 1);
});
