import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture } from './workflow-fixture.ts';
import { KnowledgeService, KNOWLEDGE_LIMITS } from '../src/core/knowledge.ts';
import { JsonStore } from '../src/core/store.ts';

test('document chunks preserve exact text offsets and source lines across persistence and deduplication', async (t) => {
  const fixture = await workflowFixture(t);
  const content = Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 行 🛰 Quartz 检索证据与预算说明。`).join('\r\n');
  const imported = await fixture.knowledge.importDocument({ title: 'release.md', content, source: 'release.md' });
  const document = fixture.knowledge.getDocument(imported.document.id);
  assert.ok(document.chunks.length > 1);
  assert.equal(document.content, content.replace(/\r\n/g, '\n'));
  for (const [index, chunk] of document.chunks.entries()) {
    assert.equal(chunk.text, document.content.slice(chunk.startOffset, chunk.endOffset));
    assert.equal(chunk.startLine, document.content.slice(0, chunk.startOffset).split('\n').length);
    assert.equal(chunk.endLine, document.content.slice(0, chunk.endOffset - 1).split('\n').length);
    assert.ok(chunk.text.length <= KNOWLEDGE_LIMITS.chunkChars);
    if (index) assert.ok(chunk.startOffset > document.chunks[index - 1].startOffset && chunk.startOffset < document.chunks[index - 1].endOffset);
  }
  const again = await fixture.knowledge.importDocument({ title: 'same source', content: document.content });
  assert.equal(again.duplicate, true);
  assert.equal(again.document.id, document.id);
  const store = await new JsonStore(fixture.dataFile).init();
  assert.deepEqual(new KnowledgeService(store).getDocument(document.id).chunks, document.chunks);
});

test('BM25 retrieves English and Chinese source terms while isolating thread-scoped documents', async (t) => {
  const fixture = await workflowFixture(t);
  const second = await fixture.store.createThread({ title: 'other thread' });
  await fixture.knowledge.importDocument({ title: '公共部署说明', content: 'Quartz deployment requires checksum verification.' });
  const privateDoc = await fixture.knowledge.importDocument({ title: '专用预算', content: 'Quartz 项目的预算上限为 48000 元。', threadId: fixture.threadId });
  await fixture.knowledge.importDocument({ title: '午餐安排', content: '今天午餐是面条。', threadId: second.id });
  const hits = fixture.knowledge.search('预算上限', { threadId: fixture.threadId });
  assert.equal(hits[0].documentId, privateDoc.document.id);
  assert.match(hits[0].text, /48000/);
  assert.equal(fixture.knowledge.search('quartz')[0].title, '公共部署说明');
  assert.equal(fixture.knowledge.search('预算上限', { threadId: second.id }).length, 0);
  assert.equal(fixture.knowledge.search('unrelatedneedle').length, 0);
  assert.equal(fixture.knowledge.search('the and').length, 0);
  await assert.rejects(fixture.tools.execute('read_knowledge', { chunkId: hits[0].id }, { threadId: second.id }), { code: 'NOT_FOUND' });
  assert.throws(() => fixture.knowledge.getDocument(privateDoc.document.id), { code: 'NOT_FOUND' });
});

test('concurrent imports deduplicate atomically within one scope and keep independent thread copies', async (t) => {
  const fixture = await workflowFixture(t);
  const input = { title: 'Concurrent source', content: 'A unique concurrent document.', threadId: fixture.threadId };
  const imports = await Promise.all(Array.from({ length: 5 }, () => fixture.knowledge.importDocument(input)));
  assert.equal(new Set(imports.map((result) => result.document.id)).size, 1);
  assert.equal(imports.filter((result) => !result.duplicate).length, 1);
  const second = await fixture.store.createThread();
  const copy = await fixture.knowledge.importDocument({ ...input, threadId: second.id });
  assert.notEqual(copy.document.id, imports[0].document.id);
  await assert.rejects(fixture.knowledge.importDocument({ title: 'empty', content: ' ' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(fixture.knowledge.importDocument({ title: 'oversize', content: 'x'.repeat(200_001) }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(fixture.knowledge.importDocument({ title: 'bad scope', content: 'text', threadId: 'missing-thread' }), { code: 'NOT_FOUND' });
});

test('retrieval augments generation and only actually used, supplied sources become citations', async (t) => {
  const fixture = await workflowFixture(t, { async complete(input) {
    assert.ok(input.context.knowledge.length >= 2);
    const hit = input.context.knowledge[0];
    return { content: `根据原文：${hit.text} [${hit.citation.id}]，另一个编号 [knowledge:invented] 未提供来源。` };
  } });
  await fixture.knowledge.importDocument({ title: 'Quartz budget', content: 'Quartz budget is 48000.', threadId: fixture.threadId });
  await fixture.knowledge.importDocument({ title: 'Quartz release', content: 'Quartz release requires review.' });
  const turn = await fixture.orchestrator.submitMessage(fixture.threadId, 'Quartz');
  assert.equal(turn.messages[0].citations.length, 1);
  assert.match(turn.messages[0].citations[0].id, /^knowledge:chunk_/);
  assert.equal(turn.messages[0].citations[0].text, turn.context.knowledge[0].text);
  const citation = turn.messages[0].citations[0];
  await fixture.knowledge.deleteDocument(citation.documentId, { threadId: fixture.threadId });
  assert.ok(!fixture.knowledge.search('Quartz', { threadId: fixture.threadId }).some((hit) => hit.documentId === citation.documentId));
  const saved = fixture.store.getThread(fixture.threadId).messages.find((message) => message.id === turn.messages[0].id);
  assert.equal(saved.citations[0].text, citation.text);
});

test('sources discovered during a ReAct tool call can be cited in the final answer', async (t) => {
  const fixture = await workflowFixture(t, { async complete(input) {
    assert.equal(input.context.knowledge.length, 0);
    const result = input.transcript.find((message) => message.role === 'tool');
    if (!result) return { content: '', toolCalls: [{ id: 'lookup', name: 'search_knowledge', arguments: JSON.stringify({ query: 'Quartz', limit: 1 }) }] };
    const hit = JSON.parse(result.content)[0];
    return { content: `已找到原文 ${hit.citation.text} [${hit.citation.id}]` };
  } });
  await fixture.knowledge.importDocument({ title: 'Quartz', content: 'Quartz checksum is b12.' });
  const turn = await fixture.orchestrator.submitMessage(fixture.threadId, '请查找代号');
  assert.equal(turn.messages[0].citations.length, 1);
  assert.match(turn.messages[0].citations[0].text, /b12/);
  assert.equal(turn.messages[0].metadata.providerMetadata.agentLoop.toolCalls, 1);
});

test('long knowledge tool hits fit the result budget without losing source text', async (t) => {
  const fixture = await workflowFixture(t);
  await fixture.knowledge.importDocument({ title: 'Quartz', content: 'Quartz 原始检索片段与预算说明。\n'.repeat(400) });
  const hits = await fixture.tools.execute('search_knowledge', { query: 'Quartz', limit: 8 }, { threadId: fixture.threadId, maxResultChars: 8000 });
  assert.ok(hits.length >= 2 && hits.length < 8);
  assert.ok(JSON.stringify(hits).length <= 8000);
  for (const hit of hits) {
    const source = fixture.knowledge.readChunk(hit.chunkId, { threadId: fixture.threadId });
    assert.equal(hit.citation.text, source.text);
  }
});

test('serial handoffs carry original tool-discovered sources into the reviewing agent context', async (t) => {
  const fixture = await workflowFixture(t, { async complete(input) {
    assert.equal(input.context.knowledge.length, 0);
    if (input.agent.id === 'lens') {
      const source = input.context.supportingSources[0];
      assert.match(source.text, /checksum b12/);
      return { content: `复核引用原文：${source.text} [${source.id}]` };
    }
    const result = input.transcript.find((message) => message.role === 'tool');
    if (!result) return { content: '', toolCalls: [{ id: 'source', name: 'search_knowledge', arguments: JSON.stringify({ query: 'Quartz', limit: 1 }) }] };
    const hit = JSON.parse(result.content)[0];
    return { content: `查到证据 ${hit.citation.text} [${hit.citation.id}]` };
  } });
  await fixture.knowledge.importDocument({ title: 'Source', content: 'Quartz checksum b12.' });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#serial @atlas @lens 把找到的证据交接复核');
  assert.equal(result.messages[1].citations.length, 1);
  assert.equal(result.messages[1].citations[0].id, result.messages[0].citations[0].id);
  assert.match(result.messages[1].content, /checksum b12/);
});
