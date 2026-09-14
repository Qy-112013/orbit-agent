import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';

test('serves health, bootstrap and a complete message turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server } = await createApp({ dataFile: join(root, 'state.json'), embeddingProvider: null });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
  assert.ok(bootstrap.agents.length >= 3);
  assert.equal(bootstrap.collaboration.maxDelegations, 2);
  assert.equal(bootstrap.execution.maxSteps, 5);
  const threadId = bootstrap.threads[0].id;
  const turnResponse = await fetch(`${base}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '@lens 检查这个接口的边界' }),
  });
  assert.equal(turnResponse.status, 200);
  const turn = await turnResponse.json();
  assert.equal(turn.route.targets[0], 'lens');
  assert.equal(turn.messages.length, 1);
  const events = await fetch(`${base}/api/threads/${threadId}/events`).then((response) => response.json());
  assert.ok(events.events.some((event) => event.type === 'execution.completed'));
  assert.ok(events.events.some((event) => event.type === 'agent.step.completed'));
  const taskResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'finish black-box check', threadId }),
  });
  const task = (await taskResponse.json()).task;
  const patchResponse = await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal((await patchResponse.json()).task.status, 'done');
});
