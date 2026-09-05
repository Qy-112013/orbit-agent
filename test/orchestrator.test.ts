import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, DEFAULT_AGENTS } from '../src/core/agent-registry.ts';
import { MemoryService } from '../src/core/memory.ts';
import { Orchestrator } from '../src/core/orchestrator.ts';
import { JsonStore } from '../src/core/store.ts';
import { createDefaultTools } from '../src/core/tools.ts';

test('executes a broadcast turn and records an auditable trace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-orchestrator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new AgentRegistry(DEFAULT_AGENTS);
  const store = new JsonStore(join(root, 'state.json'), { seedAgents: registry.list() });
  await store.init();
  const thread = await store.createThread({ title: 'orchestration test' });
  const memory = new MemoryService(store);
  const tools = createDefaultTools({ memory, store });
  const provider = {
    async complete({ agent, content }) {
      return { content: `${agent.id}: ${content}`, provider: 'test', model: 'fixture', citations: [] };
    },
  };
  const orchestrator = new Orchestrator({ store, registry, memory, provider, tools });
  const result = await orchestrator.submitMessage(thread.id, '@all 设计一个可测试的执行闭环\n任务：写测试');
  assert.equal(result.messages.length, 3);
  assert.equal(result.route.strategy, 'parallel');
  assert.ok(result.task?.id);
  const events = store.listEvents({ threadId: thread.id, limit: 100 });
  assert.ok(events.some((event) => event.type === 'route.decided'));
  assert.ok(events.some((event) => event.type === 'execution.completed'));
  assert.equal(store.listTasks({ threadId: thread.id })[0].owner, 'atlas');
});

test('queues concurrent turns on the same thread instead of dropping the second message', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-orchestrator-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new AgentRegistry(DEFAULT_AGENTS);
  const store = new JsonStore(join(root, 'state.json'), { seedAgents: registry.list() });
  await store.init();
  const thread = await store.createThread({ title: 'queue test' });
  const memory = new MemoryService(store);
  const tools = createDefaultTools({ memory, store });
  const provider = {
    async complete({ content }) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { content, provider: 'test', model: 'fixture', citations: [] };
    },
  };
  const orchestrator = new Orchestrator({ store, registry, memory, provider, tools });
  const [first, second] = await Promise.all([
    orchestrator.submitMessage(thread.id, 'first turn'),
    orchestrator.submitMessage(thread.id, 'second turn'),
  ]);
  assert.equal(first.userMessage.content, 'first turn');
  assert.equal(second.userMessage.content, 'second turn');
  assert.deepEqual(store.getThread(thread.id).messages.filter((message) => message.role === 'user').map((message) => message.content), ['first turn', 'second turn']);
});

test('keeps the turn recoverable when one provider call fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-orchestrator-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new AgentRegistry(DEFAULT_AGENTS);
  const store = new JsonStore(join(root, 'state.json'), { seedAgents: registry.list() });
  await store.init();
  const thread = await store.createThread({ title: 'failure test' });
  const memory = new MemoryService(store);
  const tools = createDefaultTools({ memory, store });
  const provider = {
    async complete({ agent }) {
      if (agent.id === 'lens') throw new Error('simulated provider outage');
      return { content: `${agent.id} survived`, provider: 'test', model: 'fixture', citations: [] };
    },
  };
  const orchestrator = new Orchestrator({ store, registry, memory, provider, tools });
  const result = await orchestrator.submitMessage(thread.id, '@all run a resilient turn');
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.filter((message) => message.failed).length, 1);
  assert.ok(store.listEvents({ threadId: thread.id }).some((event) => event.type === 'execution.completed'));
});
