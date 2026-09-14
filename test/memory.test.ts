import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, DEFAULT_AGENTS } from '../src/core/agent-registry.ts';
import { MemoryService } from '../src/core/memory.ts';
import { JsonStore } from '../src/core/store.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-memory-'));
  const store = new JsonStore(join(root, 'state.json'), { seedAgents: new AgentRegistry(DEFAULT_AGENTS).list() });
  await store.init();
  const thread = await store.createThread({ title: 'memory test' });
  return { root, store, memory: new MemoryService(store), thread };
}

test('ranks memories by lexical overlap and importance', async (t) => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.root, { recursive: true, force: true }));
  await fixtureData.memory.remember('GraphQL schema review checklist', { importance: 0.8 });
  await fixtureData.memory.remember('今天的午餐是面条', { importance: 0.2 });
  const results = await fixtureData.memory.search('schema review', { limit: 2 });
  assert.equal(results.length, 1);
  assert.match(results[0].text, /GraphQL/);
  assert.match(results[0].citation, /^memory:/);
});

test('searches memories beyond the HTTP display page', async (t) => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.root, { recursive: true, force: true }));
  for (let index = 0; index < 249; index += 1) {
    await fixtureData.memory.remember(`unrelated fact ${index}`, { importance: 0.1 });
  }
  await fixtureData.memory.remember('durable needle survives deep history', { importance: 0.9 });
  const results = await fixtureData.memory.search('durable needle', { limit: 3 });
  assert.equal(results[0].text, 'durable needle survives deep history');
});

test('accepts a remember command after an agent mention has been cleaned', () => {
  const memory = new MemoryService({ addMemory: async () => ({}), listMemories: () => [], getThread: () => null });
  assert.equal(memory.parseRememberCommand('remember: mention-safe fact'), 'mention-safe fact');
});

test('parses explicit Chinese remember commands', async (t) => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.root, { recursive: true, force: true }));
  assert.equal(fixtureData.memory.parseRememberCommand('记住：部署必须先通过 review'), '部署必须先通过 review');
  assert.equal(fixtureData.memory.parseRememberCommand('普通消息'), null);
});
