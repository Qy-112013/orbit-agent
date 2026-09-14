import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { JsonStore } from '../src/core/store.ts';

async function setup(t, provider, loopOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-collaboration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'evidence.txt'), 'verified implementation evidence');
  const dataFile = join(root, 'state.json');
  const { runtime } = await createApp({ dataFile, workspaceRoot: root, provider, loopOptions, embeddingProvider: null });
  return { ...runtime, dataFile, threadId: runtime.store.listThreads()[0].id };
}
const delegate = (id, agentId, task) => ({ id, name: 'delegate_to_agent', arguments: JSON.stringify({ agentId, task }) });

test('parent delegates implementation and review, receives both results and persists parent-child links', async (t) => {
  const runtime = await setup(t, { async complete(request) {
    const results = request.transcript.filter((message) => message.role === 'tool');
    if (request.agent.id === 'atlas') {
      if (!results.length) return { content: 'private parent scratch', toolCalls: [delegate('build', 'forge', 'Read evidence.txt and propose implementation')] };
      if (results.length === 1) {
        const implementation = JSON.parse(results[0].content);
        assert.equal(implementation.agentId, 'forge');
        assert.match(implementation.content, /verified implementation evidence/);
        return { content: '', toolCalls: [delegate('review', 'lens', 'Review: ' + implementation.content)] };
      }
      assert.equal(JSON.parse(results[1].content).agentId, 'lens');
      return { content: 'Implementation and independent review received.' };
    }
    assert.ok(!request.tools.some((tool) => tool.name === 'delegate_to_agent'));
    assert.ok(!JSON.stringify(request.transcript).includes('private parent scratch'));
    if (request.agent.id === 'forge') {
      if (!results.length) return { content: '', toolCalls: [{ id: 'file', name: 'workspace_read', arguments: '{"path":"evidence.txt"}' }] };
      return { content: JSON.parse(results[0].content).content };
    }
    assert.match(request.content, /verified implementation evidence/);
    return { content: 'Review: evidence checked; add a boundary test.' };
  } });
  const result = await runtime.orchestrator.submitMessage(runtime.threadId, '@atlas coordinate implementation and review');
  assert.equal(result.collaboration.delegations, 2);
  const messages = runtime.store.getThread(runtime.threadId).messages.filter((message) => message.role === 'assistant');
  assert.equal(messages.length, 3);
  const parent = messages.find((message) => message.agentId === 'atlas');
  for (const child of messages.filter((message) => message.agentId !== 'atlas')) {
    assert.equal(child.metadata.parentRunId, parent.metadata.runId);
    assert.equal(child.metadata.depth, 1);
  }
  const restored = new JsonStore(runtime.dataFile);
  await restored.init();
  const events = restored.listEvents({ threadId: runtime.threadId, limit: 500 });
  assert.equal(events.filter((event) => event.type === 'agent.returned').length, 2);
  assert.ok(events.filter((event) => event.type.startsWith('agent.')).every((event) => event.payload.runId));
  assert.ok(!JSON.stringify(events).includes('private parent scratch'));
});

test('two discussion rounds use previous-round evidence and end with a synthesis', async (t) => {
  const runtime = await setup(t, { async complete(request) {
    assert.ok(!request.tools.some((tool) => tool.name === 'delegate_to_agent'));
    if (request.content.includes('第一轮讨论：')) {
      assert.ok(!request.content.includes('first-lens') && !request.content.includes('first-forge'));
      return { content: 'first-' + request.agent.id };
    }
    assert.match(request.content, /first-forge/);
    assert.match(request.content, /first-lens/);
    if (request.content.includes('第二轮讨论：')) return { content: 'revised-' + request.agent.id };
    assert.match(request.content, /revised-forge/);
    assert.match(request.content, /revised-lens/);
    return { content: 'Consensus, disagreement and next steps.' };
  } });
  const result = await runtime.orchestrator.submitMessage(runtime.threadId, '#discuss @forge @lens assess the design');
  assert.equal(result.route.cleanContent, 'assess the design');
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages.at(-1).metadata.phase, 'synthesis');
  assert.equal(result.messages.at(-1).agentId, 'forge');
  assert.equal(result.collaboration.delegations, 0);
  assert.equal(runtime.store.listEvents({ threadId: runtime.threadId }).filter((event) => event.type === 'discussion.round.completed').length, 2);
});

test('a failed delegate is returned to the parent without aborting the user turn', async (t) => {
  const runtime = await setup(t, { async complete(request) {
    if (request.agent.id === 'lens') throw new Error('review service unavailable');
    if (!request.transcript.length) return { content: '', toolCalls: [delegate('review', 'lens', 'Review this task')] };
    const answer = JSON.parse(request.transcript.at(-1).content);
    assert.equal(answer.status, 'failed');
    assert.match(answer.content, /review service unavailable/);
    return { content: 'Review failed; no approval is claimed.' };
  } });
  const result = await runtime.orchestrator.submitMessage(runtime.threadId, '@atlas request review');
  assert.equal(result.collaboration.failed, 1);
  assert.equal(result.messages[0].failed, undefined);
  assert.ok(runtime.store.listEvents({ threadId: runtime.threadId }).some((event) => event.type === 'execution.completed'));
});

test('parallel parents share the same delegation budget and isolated transcripts', async (t) => {
  const runtime = await setup(t, { async complete(request) {
    if (!request.tools.some((tool) => tool.name === 'delegate_to_agent')) return { content: 'Child result for ' + request.agent.id };
    if (!request.transcript.length) return { content: '', toolCalls: [delegate('call-' + request.agent.id, request.agent.id === 'lens' ? 'forge' : 'lens', 'Focused child task')] };
    assert.equal(request.transcript[0].toolCalls[0].id, 'call-' + request.agent.id);
    return { content: 'Parent complete: ' + request.agent.id };
  } });
  const result = await runtime.orchestrator.submitMessage(runtime.threadId, '@all coordinate');
  assert.equal(result.collaboration.delegations, 2);
  const events = runtime.store.listEvents({ threadId: runtime.threadId, limit: 500 });
  assert.equal(events.filter((event) => event.type === 'agent.delegated').length, 2);
  assert.equal(events.filter((event) => event.type === 'tool.failed' && event.payload.code === 'DELEGATION_LIMIT').length, 1);
});

test('children cannot recursively delegate, and the failure can be explained to the parent', async (t) => {
  const runtime = await setup(t, { async complete(request) {
    if (request.agent.id === 'atlas') {
      if (!request.transcript.length) return { content: '', toolCalls: [delegate('child', 'forge', 'Help with analysis')] };
      return { content: 'Child returned without further delegation.' };
    }
    if (!request.transcript.length) return { content: '', toolCalls: [delegate('recursive', 'lens', 'Keep delegating')] };
    assert.equal(JSON.parse(request.transcript.at(-1).content).error.code, 'TOOL_NOT_ALLOWED');
    return { content: 'I completed the analysis within my own boundary.' };
  } });
  const result = await runtime.orchestrator.submitMessage(runtime.threadId, '@atlas analyze');
  assert.equal(result.collaboration.delegations, 1);
});

test('discussion validates participant count before persisting a user turn', async (t) => {
  const runtime = await setup(t, { async complete() { throw new Error('should not run'); } });
  await assert.rejects(() => runtime.orchestrator.submitMessage(runtime.threadId, '#discuss @atlas discuss'), { code: 'VALIDATION_ERROR' });
  assert.equal(runtime.store.getThread(runtime.threadId).messages.length, 0);
});

test('step exhaustion is a persisted failed run and later turns remain usable', async (t) => {
  let calls = 0;
  let recovered = false;
  const runtime = await setup(t, { async complete() {
    if (recovered) return { content: 'Recovered.' };
    calls += 1;
    return { content: '', toolCalls: [{ id: 'tasks-' + calls, name: 'list_tasks', arguments: '{}' }] };
  } }, { limits: { maxSteps: 2 } });
  const first = await runtime.orchestrator.submitMessage(runtime.threadId, '@atlas loop');
  assert.equal(first.messages[0].failed, true);
  assert.equal(first.messages[0].metadata.errorCode, 'AGENT_STEP_LIMIT');
  recovered = true;
  const second = await runtime.orchestrator.submitMessage(runtime.threadId, '@atlas retry');
  assert.equal(second.messages[0].content, 'Recovered.');
});
