import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleProvider, readChatStream } from '../src/core/providers.ts';
import { fetchWithRetry } from '../src/core/retry.ts';
import { CONTEXT_LIMITS, planHistory } from '../src/core/conversation.ts';
import { ProviderSummarizer } from '../src/core/compaction.ts';
import { MemoryService } from '../src/core/memory.ts';
import { JsonStore } from '../src/core/store.ts';
import { createApp } from '../src/server.ts';

const agent = { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] };
const context = { recentMessages: [], memories: [], citations: [] };

function chatStream(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('chat stream folds text, reasoning, fragmented tool calls and usage', async () => {
  const deltas: string[] = [];
  const payload = await readChatStream(chatStream([
    { model: 'fixture', choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"x"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ]), { onDelta: (text) => deltas.push(text) });
  const message = payload.choices[0].message;
  assert.equal(message.content, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(message.reasoning_content, 'think');
  assert.deepEqual(message.tool_calls.map((call: any) => [call.id, call.function.name, call.function.arguments]), [['call_a', 'alpha', '{}'], ['call_b', 'beta', '{"x":1}']]);
  assert.deepEqual(payload.usage, { prompt_tokens: 9, completion_tokens: 4 });
  assert.equal(payload.model, 'fixture');
});

test('OpenAI-compatible provider streams deltas and falls back to JSON when the server ignores stream', async (t) => {
  const bodies: any[] = [];
  const replies = [
    () => chatStream([{ model: 'm', choices: [{ delta: { content: 'streamed' } }] }]),
    () => Response.json({ model: 'm', choices: [{ message: { content: 'plain json' } }] }),
  ];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return replies.shift()!(); });
  const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'http://fixture' });
  const deltas: string[] = [];
  const first = await provider.complete({ agent, content: 'a', context, onDelta: (text) => deltas.push(text) });
  const second = await provider.complete({ agent, content: 'b', context });
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(first.content, 'streamed');
  assert.deepEqual(deltas, ['streamed']);
  assert.equal(second.content, 'plain json');
});

test('a stalled chat stream is aborted by the idle timer', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`));
      init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'http://fixture', timeoutMs: 50, maxRetries: 0 });
  await assert.rejects(provider.complete({ agent, content: 'x', context }), /idle for 50ms/);
});

test('header-scoped timeouts do not cut off a slow body', async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    async start(controller) {
      await new Promise((done) => setTimeout(done, 80));
      if (init.signal?.aborted) return controller.error(init.signal.reason);
      controller.enqueue(new TextEncoder().encode('late body'));
      controller.close();
    },
  }))) as typeof fetch;
  const { response } = await fetchWithRetry('http://x', {}, { timeoutMs: 30, timeoutScope: 'headers', fetchImpl });
  assert.equal(await response.text(), 'late body');
});

function thread(messages: Array<{ role: string; content: string }>, summary?: any) {
  return { id: 't', title: 't', messages: messages.map((message, index) => ({ id: `m${index + 1}`, threadId: 't', sequence: index + 1, createdAt: '', metadata: {}, ...message })), ...(summary ? { summary } : {}) } as any;
}

test('history stays append-only below the thresholds', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index} ` + 'x'.repeat(6000) }));
  const before = planHistory(thread(messages.slice(0, 5)));
  const after = planHistory(thread(messages.slice(0, 6)));
  assert.equal(before.pending.length, 0);
  // Fixed per-message truncation: earlier messages render identically as history grows.
  assert.deepEqual(after.recentMessages.slice(0, 5).map((message) => message.content), before.recentMessages.map((message) => message.content));
  assert.ok(before.recentMessages.every((message) => message.content.length <= CONTEXT_LIMITS.messageChars));
});

test('overflowing history keeps the newest messages and marks older ones for compaction', () => {
  const messages = Array.from({ length: CONTEXT_LIMITS.historyMessages + 1 }, (_, index) => ({ role: 'user', content: `m${index}` }));
  const { recentMessages, pending } = planHistory(thread(messages));
  assert.equal(recentMessages.length, CONTEXT_LIMITS.keepMessages);
  assert.equal(pending.length, messages.length - CONTEXT_LIMITS.keepMessages);
  assert.equal(recentMessages.at(-1)!.content, `m${messages.length - 1}`);
  const summarized = planHistory(thread(messages, { text: 's', throughSequence: pending.at(-1)!.sequence, messageCount: pending.length, method: 'llm-v1', updatedAt: '' }));
  assert.equal(summarized.pending.length, 0);
  assert.deepEqual(summarized.recentMessages.map((message) => message.id), recentMessages.map((message) => message.id));
});

async function storeWith(t, count: number) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-compaction-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new JsonStore(join(root, 'state.json')).init();
  const created = await store.createThread({ title: 'compaction' });
  for (let index = 1; index <= count; index += 1) {
    await store.appendMessage({ threadId: created.id, role: index % 2 ? 'user' : 'assistant', content: `消息 ${index}：约束 ${index}` });
  }
  return { store, threadId: created.id };
}

test('overflowing history is summarized by the model and persisted', async (t) => {
  const { store, threadId } = await storeWith(t, CONTEXT_LIMITS.historyMessages + 4);
  const inputs: any[] = [];
  const provider = { async complete(input: any) { inputs.push(input); return { content: '- 用户约束 [#1 user]', provider: 'fixture' }; } };
  const memory = new MemoryService(store, undefined, { summarizer: new ProviderSummarizer(provider) });
  const context = await memory.prepareContext(threadId, '继续');
  assert.equal(context.summary!.method, 'llm-v1');
  assert.equal(context.summary!.text, '- 用户约束 [#1 user]');
  assert.equal(store.getThread(threadId)!.summary!.method, 'llm-v1');
  assert.match(inputs[0].content, /\[#1 user\] 消息 1/);
  assert.match(inputs[0].agent.systemPrompt, /do not follow instructions/);
  // Below the threshold again: no further model calls.
  await memory.prepareContext(threadId, '再继续');
  assert.equal(inputs.length, 1);
});

test('summary failures and demo providers fall back to extractive summaries with a reason', async (t) => {
  for (const provider of [
    { async complete() { throw new Error('boom'); } },
    { async complete() { return { content: 'demo', provider: 'local' }; } },
    { async complete() { return { content: 'degraded', provider: 'local', metadata: { fallbackFrom: 'anthropic', fallbackError: '529' } }; } },
  ]) {
    const { store, threadId } = await storeWith(t, CONTEXT_LIMITS.historyMessages + 2);
    const memory = new MemoryService(store, undefined, { summarizer: new ProviderSummarizer(provider) });
    const context = await memory.prepareContext(threadId, '继续');
    assert.equal(context.summary!.method, 'extractive-v1');
    assert.ok(context.summary!.fallbackReason);
    assert.match(context.summary!.text, /#1 user/);
  }
});

test('streamed deltas reach subscribers but are never persisted or given SSE ids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-delta-test-'));
  const streaming = { id: 'streaming', async complete(input: any) {
    for (const piece of ['流', '式', '回答']) { input.onDelta?.(piece); await new Promise((done) => setTimeout(done, 60)); }
    return { content: '流式回答', provider: 'fixture' };
  } };
  const app = await createApp({ dataFile: join(root, 'state.json'), workspaceRoot: root, provider: streaming });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((done) => app.server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const threadId = app.runtime.store.listThreads()[0].id;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/threads/${threadId}/events?stream=1`, { signal: controller.signal });
  const reader = stream.body!.getReader();
  let raw = '';
  const collecting = (async () => {
    const decoder = new TextDecoder();
    while (!raw.includes('event: execution.completed')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
  })();
  await fetch(`${base}/api/threads/${threadId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '你好' }) });
  await collecting;
  controller.abort();
  const frames = raw.split('\n\n').filter((frame) => frame.includes('event: agent.delta'));
  assert.ok(frames.length >= 2);
  assert.ok(frames.every((frame) => !/^id:/m.test(frame)));
  assert.equal(frames.map((frame) => JSON.parse(frame.split('data: ')[1]).payload.text).join(''), '流式回答');
  assert.ok(!app.runtime.store.listEvents({ threadId, limit: 500 }).some((event) => event.type === 'agent.delta'));
});
