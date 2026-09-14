import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowFixture } from './workflow-fixture.ts';
import { JsonStore } from '../src/core/store.ts';
import { MemoryService } from '../src/core/memory.ts';
import { CONTEXT_LIMITS } from '../src/core/conversation.ts';
import { OpenAICompatibleProvider } from '../src/core/providers.ts';
import { CliProvider } from '../src/core/cli-provider.ts';

test('long conversations retain attributed early context across restarts without duplicating the current request', async (t) => {
  let received;
  const fixture = await workflowFixture(t, { async complete(input) { received = input; return { content: 'ready to continue' }; } });
  await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: 'Vega 的硬约束：仅使用本地存储。' });
  for (let index = 1; index <= 35; index += 1) {
    await fixture.store.appendMessage({ threadId: fixture.threadId, role: index % 2 ? 'assistant' : 'user', content: `历史片段 ${index} ` + '内容'.repeat(500) });
  }
  const turn = await fixture.orchestrator.submitMessage(fixture.threadId, '请继续 Vega 的实现');
  assert.match(received.context.summary.text, /仅使用本地存储/);
  assert.match(received.context.summary.text, /#1 user/);
  assert.ok(received.context.summary.text.length <= CONTEXT_LIMITS.summaryChars);
  assert.ok(received.context.recentMessages.length <= CONTEXT_LIMITS.recentMessages);
  assert.ok(received.context.recentMessages.reduce((sum, message) => sum + message.content.length, 0) <= CONTEXT_LIMITS.recentChars);
  assert.ok(!received.context.recentMessages.some((message) => message.id === turn.userMessage.id));
  assert.ok(fixture.store.listEvents({ threadId: fixture.threadId }).some((event) => event.type === 'context.compacted'));
  const restored = await new JsonStore(fixture.dataFile).init();
  assert.deepEqual(restored.getThread(fixture.threadId).summary, received.context.summary);
  const next = await new MemoryService(restored).prepareContext(fixture.threadId, '再次继续');
  assert.match(next.summary.text, /仅使用本地存储/);
  assert.ok(next.summary.throughSequence >= received.context.summary.throughSequence);
});

test('branching at an earlier message excludes later messages, summaries and thread-local knowledge', async (t) => {
  const fixture = await workflowFixture(t);
  const first = await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: '最初目标' });
  for (let index = 0; index < 18; index += 1) await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'assistant', content: `未来信息 ${index}` });
  await fixture.memory.prepareContext(fixture.threadId, '未来');
  await fixture.knowledge.importDocument({ title: '原会话专用', content: 'branch-private-source', threadId: fixture.threadId });
  const fork = await fixture.store.forkThread(fixture.threadId, { messageId: first.id, title: '独立分支' });
  const restored = fixture.store.getThread(fork.id);
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].content, '最初目标');
  assert.notEqual(restored.messages[0].id, first.id);
  assert.equal(restored.metadata.parentThreadId, fixture.threadId);
  assert.equal(restored.summary, undefined);
  assert.ok(!JSON.stringify(await fixture.memory.buildContext(fork.id, '目标')).includes('未来信息'));
  assert.equal(fixture.knowledge.list({ threadId: fork.id }).length, 0);
  await fixture.store.appendMessage({ threadId: fork.id, role: 'user', content: '分支新消息' });
  assert.equal(fixture.store.getThread(fixture.threadId).messages.length, 19);
});

test('API providers preserve conversation roles and send the current user message exactly once', async (t) => {
  const fixture = await workflowFixture(t);
  await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: '上一问' });
  await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'assistant', agentId: 'forge', content: '上一答' });
  const current = await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: '当前唯一请求' });
  const context = await fixture.memory.buildContext(fixture.threadId, '当前唯一请求', { excludeMessageId: current.id });
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'new answer' } }] }));
  });
  await new OpenAICompatibleProvider({ apiKey: 'fixture' }).complete({ agent: fixture.registry.get('atlas'), content: current.content, context });
  assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.match(request.messages[2].content, /forge.*上一答/);
  assert.equal(request.messages.filter((message) => message.content.includes('当前唯一请求')).length, 1);
});

test('CLI prompts include the complete bounded history, summary and source identifiers', async (t) => {
  const fixture = await workflowFixture(t);
  for (let index = 1; index <= 20; index += 1) await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: `history-marker-${index}` });
  await fixture.knowledge.importDocument({ title: 'Quartz 来源', content: 'Quartz checksum b12', source: 'release.md' });
  const context = await fixture.memory.prepareContext(fixture.threadId, 'Quartz');
  context.knowledge = await fixture.knowledge.search('Quartz');
  context.citations = context.knowledge.map((hit) => hit.citation);
  const cli = new CliProvider({ id: 'fixture-cli', command: process.execPath, args: ['-e', 'let text="";process.stdin.on("data",part=>text+=part);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({result:text})));'], cwd: fixture.root, workspaceRoot: fixture.root, promptMode: 'stdin', outputFormat: 'json' });
  const result = await cli.complete({ agent: fixture.registry.get('atlas'), content: 'new-cli-request', context });
  assert.match(result.content, /history-marker-1/);
  assert.match(result.content, /user: history-marker-9/);
  assert.match(result.content, /user: history-marker-20/);
  assert.ok(result.content.includes(context.knowledge[0].citation.id));
  assert.equal(result.content.split('new-cli-request').length, 2);
});

test('schema version one state loads without losing messages or memory', async (t) => {
  const fixture = await workflowFixture(t);
  const file = join(fixture.root, 'legacy.json');
  const message = await fixture.store.appendMessage({ threadId: fixture.threadId, role: 'user', content: '旧版消息' });
  const memory = await fixture.memory.remember('旧版长期记忆', { threadId: fixture.threadId });
  const prior = fixture.store.snapshot();
  prior.schemaVersion = 1;
  delete prior.documents;
  delete prior.chunks;
  delete prior.plans;
  await writeFile(file, JSON.stringify(prior));
  const store = await new JsonStore(file).init();
  assert.equal(store.snapshot().schemaVersion, 2);
  assert.equal(store.getThread(fixture.threadId).title, fixture.store.getThread(fixture.threadId).title);
  assert.equal(store.getThread(fixture.threadId).messages[0].id, message.id);
  assert.equal(store.listMemories({ threadId: fixture.threadId })[0].id, memory.id);
  assert.deepEqual(store.listKnowledgeDocuments(), []);
  assert.deepEqual(store.listPlans(), []);
});
