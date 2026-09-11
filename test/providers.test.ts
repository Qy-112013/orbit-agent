import test from 'node:test';
import assert from 'node:assert/strict';
import { FallbackProvider, OpenAICompatibleProvider, ProviderRegistry } from '../src/core/providers.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliProvider } from '../src/core/cli-provider.ts';
import { createApp } from '../src/server.ts';

test('clears a stale provider error after recovery', async () => {
  let attempts = 0;
  const primary = {
    async complete() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary outage');
      return { content: 'recovered', provider: 'test', model: 'fixture' };
    },
  };
  const fallback = { async complete() { return { content: 'fallback', provider: 'local' }; } };
  const provider = new FallbackProvider(primary, fallback);
  const input = { agent: { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] }, content: 'x', context: { recentMessages: [], memories: [], citations: [] } };
  await provider.complete(input);
  assert.equal(provider.lastError, 'temporary outage');
  await provider.complete(input);
  assert.equal(provider.lastError, null);
});

test('routes different agents to different registered providers', async () => {
  const calls: string[] = [];
  const registry = new ProviderRegistry()
    .register('default', { id: 'default-adapter', async complete() { calls.push('default'); return { content: 'default' }; } })
    .register('atlas', { id: 'atlas-adapter', async complete() { calls.push('atlas'); return { content: 'atlas' }; } });
  const base = { content: 'x', context: { recentMessages: [], memories: [], citations: [] } };
  const atlas = await registry.complete({ ...base, agent: { id: 'atlas', name: 'Atlas', role: 'architect', provider: 'auto', aliases: [] } });
  const lens = await registry.complete({ ...base, agent: { id: 'lens', name: 'Lens', role: 'reviewer', provider: 'auto', aliases: [] } });
  assert.equal(atlas.content, 'atlas');
  assert.equal(lens.content, 'default');
  assert.deepEqual(calls, ['atlas', 'default']);
});

test('OpenAI-compatible transport sends tool schemas and preserves the tool-result protocol', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: requests.length === 1
      ? { content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'workspace_read', arguments: '{"path":"README.md"}' } }] }
      : { content: 'Read and checked.' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const provider = new OpenAICompatibleProvider({ apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:' + server.address().port });
  const request = {
    agent: { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] }, content: 'Check the README',
    context: { recentMessages: [], memories: [], citations: [], skills: [{ id: 'review', name: 'Review', content: 'Check evidence first.' }] },
    tools: [{ name: 'workspace_read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  };
  const first = await provider.complete(request);
  assert.equal(first.content, '');
  assert.equal(first.toolCalls[0].id, 'read-1');
  const second = await provider.complete({ ...request, transcript: [
    { role: 'assistant', content: '', toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: 'read-1', content: '{"content":"readme evidence"}' },
  ] });
  assert.equal(second.content, 'Read and checked.');
  assert.equal(requests[0].tools[0].function.parameters.properties.path.type, 'string');
  assert.match(requests[0].messages[0].content, /Check evidence first/);
  assert.equal(requests[1].messages.at(-2).tool_calls[0].id, 'read-1');
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'read-1');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
});

test('thinking API preserves full protocol state while delegating to a CLI, without exposing it in thread data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-thinking-hybrid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reasoning = ['private-protocol-first-'.repeat(600), 'private-protocol-second'];
  let requests = 0;
  let violations = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests += 1;
    response.setHeader('content-type', 'application/json');
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    if (assistants.some((message, index) => message.reasoning_content !== reasoning[index])) {
      violations += 1;
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: 'missing reasoning_content' } }));
      return;
    }
    if (requests <= 2) {
      response.end(JSON.stringify({ choices: [{ message: {
        content: '', reasoning_content: reasoning[requests - 1],
        tool_calls: [{ id: 'call-' + requests, type: 'function', function: requests === 1
          ? { name: 'delegate_to_agent', arguments: '{"agentId":"forge","task":"Return a focused implementation suggestion"}' }
          : { name: 'list_tasks', arguments: '{}' } }],
      } }] }));
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: 'Parent integrated the CLI result.', reasoning_content: 'private-protocol-final' } }] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const providers = new ProviderRegistry()
    .register('default', new OpenAICompatibleProvider({ apiKey: 'fixture-key', model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:' + server.address().port }))
    .register('forge', new CliProvider({
      id: 'claude-code-fixture', command: process.execPath,
      args: ['-e', "process.stdout.write(JSON.stringify({result:'GLM CLI fixture result'}))"],
      cwd: root, workspaceRoot: root, outputFormat: 'json',
    }));
  const { runtime } = await createApp({ providers, dataFile: join(root, 'state.json'), workspaceRoot: root });
  const threadId = runtime.store.listThreads()[0].id;
  const result = await runtime.orchestrator.submitMessage(threadId, '@atlas delegate an implementation task');
  assert.equal(result.messages[0].content, 'Parent integrated the CLI result.');
  assert.equal(result.collaboration.delegations, 1);
  assert.equal(requests, 3);
  assert.equal(violations, 0);
  const thread = runtime.store.getThread(threadId);
  assert.ok(thread.messages.some((message) => message.agentId === 'forge' && message.content === 'GLM CLI fixture result'));
  assert.ok(!JSON.stringify({ result, thread, events: runtime.store.listEvents({ threadId, limit: 500 }) }).includes('private-protocol'));
});
