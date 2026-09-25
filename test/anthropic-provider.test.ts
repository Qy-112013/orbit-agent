import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, anthropicUsage } from '../src/core/anthropic-provider.ts';
import { createProviderFromEnv, createProviderRegistryFromEnv } from '../src/core/providers.ts';

const agent = { id: 'forge', name: 'Forge', role: 'builder', aliases: [], systemPrompt: 'You build things.' };
const context = { recentMessages: [], memories: [], citations: [] };

function fixture(responses: any[]) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (typeof next === 'number') return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: next, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', ...next }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { requests, provider: new AnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl, maxRetries: 2 }) };
}

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

test('selects Anthropic as default only when configured or when it is the only key', () => {
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a' }).id, /^anthropic/);
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).id, /^openai-compatible/);
  assert.match(createProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', ORBIT_DEFAULT_PROVIDER: 'anthropic' }).id, /^anthropic/);
  const registry = createProviderRegistryFromEnv({ ANTHROPIC_API_KEY: 'a', ORBIT_FORGE_PROVIDER: 'anthropic' }, [agent]);
  assert.equal(registry.resolve(agent).id, 'forge');
  assert.match(registry.resolve(agent).provider.id!, /^anthropic/);
});
