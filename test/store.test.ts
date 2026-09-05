import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, DEFAULT_AGENTS } from '../src/core/agent-registry.ts';
import { JsonStore } from '../src/core/store.ts';

test('persists threads, messages and memories across store instances', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seedAgents = new AgentRegistry(DEFAULT_AGENTS).list();
  const first = new JsonStore(join(root, 'state.json'), { seedAgents });
  await first.init();
  const thread = await first.createThread({ title: 'durable thread' });
  const message = await first.appendMessage({ threadId: thread.id, role: 'user', content: 'hello' });
  const memory = await first.addMemory({ text: 'durable fact', threadId: thread.id });
  await first.appendEvent({ threadId: thread.id, type: 'test.event', payload: { ok: true } });

  const second = new JsonStore(join(root, 'state.json'), { seedAgents });
  await second.init();
  const restored = second.getThread(thread.id);
  assert.equal(restored.messages[0].id, message.id);
  assert.equal(second.listMemories({ threadId: thread.id })[0].id, memory.id);
  assert.equal(second.listEvents({ threadId: thread.id })[0].type, 'test.event');
});

test('serializes concurrent mutations without losing records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-store-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonStore(join(root, 'state.json'));
  await store.init();
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.addMemory({ text: `fact ${index}` })));
  assert.equal(store.listMemories({ limit: 50 }).length, 12);
});
