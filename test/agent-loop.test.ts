import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/core/agent-loop.ts';
import { ToolRegistry } from '../src/core/tools.ts';

const input = { agent: { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] }, content: 'read evidence', context: { recentMessages: [], memories: [], citations: [] } };
const call = (id, name = 'read_data', args = '{"path":"note"}') => ({ id, name, arguments: args });

function setup(provider, limits = {}, read = async () => ({ evidence: 'verified' })) {
  const events = [];
  const tools = new ToolRegistry()
    .register({ name: 'read_data', description: 'Read evidence', readOnly: true, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, execute: read })
    .register({ name: 'write_data', description: 'Write', readOnly: false, inputSchema: { type: 'object' }, execute: () => { throw new Error('must never execute'); } });
  const loop = new AgentLoop({ provider, tools, limits });
  return { events, loop, run: () => loop.run(input, { threadId: 'thread', runId: 'run' }, async (type, payload) => { events.push({ type, payload }); }) };
}

test('feeds a real tool result back to the model with matching call ids', async () => {
  let requests = 0;
  const fixture = setup({ async complete(request) {
    requests += 1;
    assert.deepEqual(request.tools.map((tool) => tool.name), ['read_data']);
    if (requests === 1) return { content: '', toolCalls: [call('read-1')] };
    assert.equal(request.transcript[0].toolCalls[0].id, 'read-1');
    assert.equal(request.transcript[1].toolCallId, 'read-1');
    assert.deepEqual(JSON.parse(request.transcript[1].content), { evidence: 'verified' });
    return { content: 'Evidence checked.' };
  } });
  const result = await fixture.run();
  assert.equal(result.content, 'Evidence checked.');
  assert.equal(result.metadata.agentLoop.steps, 2);
  assert.equal(result.metadata.agentLoop.toolCalls, 1);
  assert.ok(fixture.events.every((event) => event.payload.runId === 'run'));
  assert.ok(fixture.events.some((event) => event.type === 'tool.completed'));
});

test('denied tools, bad JSON and invalid arguments return errors without executing', async () => {
  let reads = 0;
  const fixture = setup({ async complete(request) {
    if (!request.transcript.length) return { content: '', toolCalls: [
      call('write', 'write_data', '{}'), call('unknown', 'shell', '{}'),
      call('json', 'read_data', '{oops'), call('schema', 'read_data', '{"path":7}'),
    ] };
    const errors = request.transcript.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content).error.code);
    assert.deepEqual(errors, ['TOOL_NOT_ALLOWED', 'TOOL_NOT_ALLOWED', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS']);
    return { content: 'I will correct the request.' };
  } }, {}, async () => { reads += 1; });
  const result = await fixture.run();
  assert.equal(reads, 0);
  assert.equal(result.metadata.agentLoop.toolFailures, 4);
  assert.equal(fixture.events.filter((event) => event.type === 'tool.failed').length, 4);
});

test('stops repeated tool requests at the model step budget', async () => {
  let requests = 0;
  let reads = 0;
  const fixture = setup({ async complete() { requests += 1; return { content: '', toolCalls: [call('read-' + requests)] }; } },
    { maxSteps: 2 }, async () => { reads += 1; return {}; });
  await assert.rejects(fixture.run, { code: 'AGENT_STEP_LIMIT' });
  assert.equal(requests, 2);
  assert.equal(reads, 1);
});

test('rejects an over-budget batch before executing any of its tools', async () => {
  let reads = 0;
  const fixture = setup({ async complete() { return { content: '', toolCalls: [call('one'), call('two')] }; } },
    { maxToolCalls: 1 }, async () => { reads += 1; });
  await assert.rejects(fixture.run, { code: 'AGENT_TOOL_LIMIT' });
  assert.equal(reads, 0);
});

test('rejects duplicate call ids before executing the batch', async () => {
  let reads = 0;
  const fixture = setup({ async complete() { return { content: '', toolCalls: [call('same'), call('same')] }; } },
    {}, async () => { reads += 1; });
  await assert.rejects(fixture.run, { code: 'INVALID_TOOL_CALL' });
  assert.equal(reads, 0);
});

test('large tool results stay bounded and parseable with an explicit truncation marker', async () => {
  const fixture = setup({ async complete(request) {
    if (!request.transcript.length) return { content: '', toolCalls: [call('large')] };
    const output = request.transcript.at(-1).content;
    assert.ok(output.length <= 128);
    assert.equal(JSON.parse(output).truncated, true);
    return { content: 'Partial evidence received.' };
  } }, { maxResultChars: 128 }, async () => ({ text: '"\\'.repeat(2000) }));
  await fixture.run();
  assert.equal(fixture.events.find((event) => event.type === 'tool.completed').payload.truncated, true);
});

test('provider fallback is observable rather than silently marked as a normal model answer', async () => {
  const fixture = setup({ async complete() { return { content: 'Local demo', provider: 'local', metadata: { fallbackFrom: 'remote', fallbackError: 'offline' } }; } });
  const result = await fixture.run();
  assert.equal(result.metadata.agentLoop.degraded, true);
  assert.equal(fixture.events.find((event) => event.type === 'provider.fallback').payload.error, 'offline');
});
