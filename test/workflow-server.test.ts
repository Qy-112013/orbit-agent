import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture } from './workflow-fixture.ts';

async function httpFixture(t, provider) {
  const fixture = await workflowFixture(t, provider);
  await new Promise((done, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${fixture.server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...fixture, base, request };
}

test('HTTP manages thread names, search, archive, restore and branching while preserving the source conversation', async (t) => {
  const { request, threadId } = await httpFixture(t);
  assert.equal((await request(`/api/threads/${threadId}`, 'PATCH', { title: 'Quartz 会话' })).status, 200);
  const first = await request(`/api/threads/${threadId}/messages`, 'POST', { content: '最初的问题 quartz-token' });
  await request(`/api/threads/${threadId}/messages`, 'POST', { content: '后续消息 future-token' });
  const search = await request('/api/threads?q=quartz-token');
  assert.equal(search.body.threads[0].id, threadId);
  const fork = await request(`/api/threads/${threadId}/fork`, 'POST', { messageId: first.body.userMessage.id, title: '只保留第一问' });
  assert.equal(fork.status, 201);
  const branch = (await request(`/api/threads/${fork.body.thread.id}`)).body.thread;
  assert.equal(branch.messages.length, 1);
  assert.ok(!JSON.stringify(branch.messages).includes('future-token'));
  assert.equal((await request(`/api/threads/${threadId}`)).body.thread.messages.length, 4);
  await request(`/api/threads/${threadId}`, 'PATCH', { archived: true });
  assert.ok(!(await request('/api/threads')).body.threads.some((thread) => thread.id === threadId));
  assert.ok((await request('/api/threads?archived=1')).body.threads.some((thread) => thread.id === threadId));
  assert.equal((await request(`/api/threads/${threadId}/messages`, 'POST', { content: '不能写入归档会话' })).status, 409);
  await request(`/api/threads/${threadId}`, 'PATCH', { archived: false });
  assert.equal((await request(`/api/threads/${threadId}/messages`, 'POST', { content: '恢复后继续' })).status, 200);
  assert.equal((await request(`/api/threads/${threadId}/messages/extra`, 'POST', { content: 'bad route' })).status, 404);
  assert.equal((await request(`/api/threads/${threadId}`, 'PATCH', { archived: 'yes' })).status, 400);
});

test('knowledge HTTP import, search, source read and deletion respect thread scope and preserve historical citations', async (t) => {
  const { request, threadId } = await httpFixture(t);
  const another = (await request('/api/threads', 'POST', { title: 'another' })).body.thread.id;
  const imported = await request('/api/knowledge/documents', 'POST', { title: 'Budget source', content: 'Quartz budget is 48000 yuan.', source: 'budget.md', threadId });
  assert.equal(imported.status, 201);
  const documentId = imported.body.document.id;
  assert.equal((await request('/api/knowledge/documents')).body.documents.length, 0);
  assert.equal((await request(`/api/knowledge/documents?threadId=${threadId}`)).body.documents.length, 1);
  assert.equal((await request(`/api/knowledge/documents/${documentId}?threadId=${another}`)).status, 404);
  assert.equal((await request(`/api/knowledge/documents/${documentId}?threadId=${another}`, 'DELETE')).status, 404);
  const hits = (await request(`/api/knowledge/search?threadId=${threadId}&q=Quartz`)).body.hits;
  assert.equal(hits[0].citation.source, 'budget.md');
  const document = (await request(`/api/knowledge/documents/${documentId}?threadId=${threadId}`)).body.document;
  assert.equal(document.content, 'Quartz budget is 48000 yuan.');
  const turn = await request(`/api/threads/${threadId}/messages`, 'POST', { content: 'Quartz budget?' });
  assert.equal(turn.body.messages[0].citations.length, 1);
  assert.equal((await request(`/api/knowledge/documents/${documentId}?threadId=${threadId}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/knowledge/search?threadId=${threadId}&q=Quartz`)).body.hits.length, 0);
  const messages = (await request(`/api/threads/${threadId}`)).body.thread.messages;
  assert.equal(messages.at(-1).citations[0].text, document.content);
  assert.equal((await request('/api/knowledge/documents', 'POST', null)).status, 400);
  assert.equal((await request('/api/knowledge/documents', 'POST', { title: 'too long', content: 'x'.repeat(200001) })).status, 400);
});

test('plan endpoints expose persisted outcomes only under their owning thread', async (t) => {
  const { request, threadId } = await httpFixture(t);
  const result = await request(`/api/threads/${threadId}/messages`, 'POST', { content: '#plan 检查部署说明' });
  assert.equal(result.status, 200);
  assert.equal(result.body.plan.status, 'blocked');
  const planId = result.body.plan.id;
  assert.equal((await request(`/api/threads/${threadId}/plans`)).body.plans[0].id, planId);
  assert.equal((await request(`/api/threads/${threadId}/plans/${planId}`)).body.plan.status, 'blocked');
  const another = (await request('/api/threads', 'POST', {})).body.thread.id;
  assert.equal((await request(`/api/threads/${another}/plans/${planId}`)).status, 404);
  assert.equal((await request(`/api/threads/${another}/plans`)).body.plans.length, 0);
});

test('active turns prevent archiving, including a queued archive racing with message persistence', async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = await httpFixture(t, { async complete() { entered(); await gate; return { content: 'done' }; } });
  t.after(() => release());
  const running = fixture.orchestrator.submitMessage(fixture.threadId, 'wait for result');
  await started;
  assert.equal((await fixture.request(`/api/threads/${fixture.threadId}`)).body.busy, true);
  assert.equal((await fixture.request(`/api/threads/${fixture.threadId}`, 'PATCH', { archived: true })).status, 409);
  release();
  await running;
  assert.equal((await fixture.request(`/api/threads/${fixture.threadId}`)).body.busy, false);
  const second = await fixture.store.createThread();
  const archived = fixture.store.updateThread(second.id, { archived: true });
  const raced = fixture.orchestrator.submitMessage(second.id, 'must not enter archived thread');
  await assert.rejects(raced, { code: 'CONFLICT' });
  await archived;
  assert.equal(fixture.store.getThread(second.id).messages.length, 0);
});

test('event tail shows recent activity and SSE honors Last-Event-ID over the original URL cursor', async (t) => {
  const { store, request, base, threadId } = await httpFixture(t);
  await Promise.all(Array.from({ length: 522 }, (_, index) => store.appendEvent({ threadId, type: 'test.progress', payload: { index } })));
  const tail = (await request(`/api/threads/${threadId}/events`)).body.events;
  assert.equal(tail.length, 500);
  assert.equal(tail[0].sequence, 23);
  assert.equal(tail.at(-1).sequence, 522);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/threads/${threadId}/events?after=1&stream=1`, { headers: { 'last-event-id': '520' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.deepEqual([...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])), [521, 522]);
  assert.match(text, /"busy":false/);
  await reader.cancel();
  controller.abort();
});
