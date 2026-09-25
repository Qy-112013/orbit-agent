import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, anthropicUsage } from '../src/core/anthropic-provider.ts';
import { createProviderFromEnv, createProviderRegistryFromEnv } from '../src/core/providers.ts';

const agent = { id: 'forge', name: 'Forge', role: 'builder', aliases: [], systemPrompt: 'You build things.' };
const context = { recentMessages: [], memories: [], citations: [] };

/** Renders a message as the Messages API SSE stream the SDK consumes. */
export function sse(message: any): string {
  const { content = [], stop_reason = 'end_turn', stop_details = null, usage = { input_tokens: 1, output_tokens: 1 }, ...rest } = message;
  const events: any[] = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [],
    stop_reason: null, stop_sequence: null, ...rest, usage: { ...usage, output_tokens: 0 } } }];
  content.forEach((block: any, index: number) => {
    const start = block.type === 'text' ? { type: 'text', text: '' } : block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : { type: 'thinking', thinking: '' };
    events.push({ type: 'content_block_start', index, content_block: start });
    if (block.type === 'text') for (const piece of block.text.match(/.{1,4}/gs) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    if (block.type === 'tool_use') events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    if (block.type === 'thinking') events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  events.push({ type: 'message_stop' });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function fixture(responses: any[]) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (typeof next === 'number') return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: next, headers: { 'content-type': 'application/json' } });
    return new Response(sse(next), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { requests, provider: new AnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl, maxRetries: 2 }) };
}

test('streams text deltas and returns the assembled answer', async () => {
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: 'streamed answer' }] }]);
  const deltas: string[] = [];
  const result = await provider.complete({ agent, content: 'x', context, onDelta: (text) => deltas.push(text) });
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 64000);
  assert.ok(deltas.length > 1);
  assert.equal(deltas.join(''), 'streamed answer');
  assert.equal(result.content, 'streamed answer');
});

test('an idle stream is aborted with a clear error', async () => {
  // The body never produces events; closing it on abort keeps the test process from hanging.
  const stalled = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  const provider = new AnthropicProvider({ apiKey: 'test-key', fetch: stalled, maxRetries: 0, timeoutMs: 50 });
  await assert.rejects(provider.complete({ agent, content: 'x', context }), /idle for 50ms/);
});

test('places the summary before history and a cache breakpoint on the last history message', async () => {
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: 'ok' }] }]);
  await provider.complete({ agent, content: 'now', context: { ...context,
    summary: { text: 'goal: ship it', throughSequence: 4, messageCount: 4, method: 'llm-v1', updatedAt: '' },
    memories: [{ id: 'mem', text: 'fact', createdAt: '' }] as any,
    recentMessages: [
      { id: 'm5', threadId: 't', role: 'user', content: 'earlier question', sequence: 5, createdAt: '', metadata: {} },
      { id: 'm6', threadId: 't', role: 'assistant', agentId: 'atlas', content: 'earlier answer', sequence: 6, createdAt: '', metadata: {} },
    ] as any } });
  const messages = requests[0].body.messages;
  assert.match(messages[0].content, /^Earlier conversation summary \(model-generated, through message #4/);
  assert.deepEqual(messages[2].content, [{ type: 'text', text: '[atlas] earlier answer', cache_control: { type: 'ephemeral' } }]);
  assert.doesNotMatch(messages[3].content, /Earlier conversation/);
  assert.match(messages[3].content, /^Reference context:[\s\S]*now$/);
});

test('sends cached system, adaptive thinking, fallbacks and sorted tools', async () => {
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2000, cache_creation_input_tokens: 50 } }]);
  const result = await provider.complete({ agent, content: 'hello', context,
    tools: [{ name: 'zeta', description: 'z', inputSchema: { type: 'object' } }, { name: 'alpha', description: 'a', inputSchema: { type: 'object' } }] });
  const { url, headers, body } = requests[0];
  assert.match(url, /\/v1\/messages/);
  assert.match(headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'high');
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.match(body.system[0].text, /You build things/);
  assert.deepEqual(body.tools.map((tool: any) => tool.name), ['alpha', 'zeta']);
  assert.equal(result.content, 'done');
  assert.equal(result.provider, 'anthropic');
  assert.deepEqual(result.usage, { promptTokens: 2060, completionTokens: 3, cacheReadTokens: 2000, cacheWriteTokens: 50 });
});

test('replays raw content blocks and merges parallel tool results into one user turn', async () => {
  const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu_1', name: 'alpha', input: { q: 1 } }, { type: 'tool_use', id: 'tu_2', name: 'zeta', input: {} }];
  const { requests, provider } = fixture([{ content: blocks, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'final' }] }]);
  const first = await provider.complete({ agent, content: 'go', context });
  assert.deepEqual(first.toolCalls, [{ id: 'tu_1', name: 'alpha', arguments: '{"q":1}' }, { id: 'tu_2', name: 'zeta', arguments: '{}' }]);
  await provider.complete({ agent, content: 'go', context, transcript: [
    { role: 'assistant', content: '', toolCalls: first.toolCalls!, providerState: first.providerState },
    { role: 'tool', toolCallId: 'tu_1', content: '"a"' },
    { role: 'tool', toolCallId: 'tu_2', content: '"b"' },
  ] });
  const messages = requests[1].body.messages;
  assert.deepEqual(messages.at(-2).content, blocks);
  assert.equal(messages.at(-1).role, 'user');
  assert.deepEqual(messages.at(-1).content.map((block: any) => block.tool_use_id), ['tu_1', 'tu_2']);
});

test('structured output uses output_config.format with a provider-safe schema', async () => {
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: '{"verdict":"pass","feedback":"ok"}' }] }]);
  await provider.complete({ agent, content: 'review', context,
    responseSchema: { name: 'review', schema: { type: 'object', properties: { feedback: { type: 'string', maxLength: 10 } }, required: ['feedback'] } } });
  const format = requests[0].body.output_config.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.schema.properties.feedback.maxLength, undefined);
  assert.equal(format.schema.additionalProperties, false);
});

test('retries overloaded responses through the SDK', async () => {
  const { requests, provider } = fixture([529, { content: [{ type: 'text', text: 'recovered' }] }]);
  const result = await provider.complete({ agent, content: 'x', context });
  assert.equal(result.content, 'recovered');
  assert.equal(requests.length, 2);
});

test('a refusal is raised so the fallback provider takes over', async () => {
  const { provider } = fixture([{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }]);
  await assert.rejects(provider.complete({ agent, content: 'x', context }), /refused.*cyber/);
});

test('history that starts with an assistant turn is anchored by a user message', async () => {
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: 'ok' }] }]);
  await provider.complete({ agent, content: 'next', context: { ...context,
    recentMessages: [{ id: 'm', threadId: 't', role: 'assistant', agentId: 'atlas', content: 'earlier answer', sequence: 2, createdAt: '', metadata: {} }] as any } });
  assert.equal(requests[0].body.messages[0].role, 'user');
});

test('usage normalization tolerates missing fields', () => {
  assert.equal(anthropicUsage(undefined), null);
  assert.deepEqual(anthropicUsage({ input_tokens: 5, output_tokens: 1 }), { promptTokens: 5, completionTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('ignores ambient SDK endpoint and bearer credentials', async (t) => {
  const saved = { url: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_BASE_URL = 'https://relay.invalid';
  process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token';
  t.after(() => {
    for (const [key, value] of [['ANTHROPIC_BASE_URL', saved.url], ['ANTHROPIC_AUTH_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { requests, provider } = fixture([{ content: [{ type: 'text', text: 'ok' }] }]);
  await provider.complete({ agent, content: 'x', context });
  assert.match(requests[0].url, /^https:\/\/api\.anthropic\.com\//);
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('x-api-key'), 'test-key');
});

test('selects Anthropic as default only when configured or when it is the only key', () => {
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a' }).id, /^anthropic/);
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).id, /^openai-compatible/);
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', ORBIT_DEFAULT_PROVIDER: 'anthropic' }).id, /^anthropic/);
  const registry = createProviderRegistryFromEnv({ ANTHROPIC_API_KEY: 'a', ORBIT_FORGE_PROVIDER: 'anthropic' }, [agent]);
  assert.equal(registry.resolve(agent).id, 'forge');
  assert.match(registry.resolve(agent).provider.id!, /^anthropic/);
});
