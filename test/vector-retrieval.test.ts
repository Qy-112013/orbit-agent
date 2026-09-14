import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowFixture } from './workflow-fixture.ts';
import { embeddingFixture } from './embedding-fixture.ts';
import { createApp } from '../src/server.ts';
import { createMcpRuntime } from '../src/mcp-server.ts';
import { KnowledgeService } from '../src/core/knowledge.ts';
import { MemoryService } from '../src/core/memory.ts';
import { EMBEDDING_LIMITS } from '../src/core/embeddings.ts';
import { fuseRanks, VectorIndex } from '../src/core/vector-index.ts';

test('semantic search recalls documents and memories without shared terms and keeps source citations', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, undefined, embedding);
  const imported = await fixture.knowledge.importDocument({ title: 'Transport handbook', content: 'A bicycle is useful for commuting.', source: 'travel.md', threadId: fixture.threadId });
  const remembered = await fixture.memory.remember('Cycling is my preferred way to travel.', { threadId: fixture.threadId });
  assert.equal(imported.indexing.pending, 0);
  const query = '两轮通勤工具';
  assert.deepEqual(await fixture.knowledge.search(query, { threadId: fixture.threadId, mode: 'keyword' }), []);
  assert.deepEqual(await fixture.memory.search(query, { threadId: fixture.threadId, mode: 'keyword' }), []);
  const [knowledge, memory] = await Promise.all([
    fixture.knowledge.searchWithMetadata(query, { threadId: fixture.threadId }),
    fixture.memory.searchWithMetadata(query, { threadId: fixture.threadId }),
  ]);
  assert.equal(knowledge.method, 'hybrid');
  assert.equal(memory.method, 'hybrid');
  assert.equal(knowledge.hits[0].documentId, imported.document.id);
  assert.equal(knowledge.hits[0].vectorScore, 1);
  assert.equal(knowledge.hits[0].citation.text, 'A bicycle is useful for commuting.');
  assert.equal(knowledge.hits[0].citation.startLine, 1);
  assert.equal(memory.hits[0].citation, `memory:${remembered.id}`);
  assert.equal(embedding.calls.filter((inputs) => inputs.length === 1 && inputs[0] === query).length, 1, 'the same query embedding is shared across concurrent retrievals');
  const toolHits = await fixture.tools.execute('search_knowledge', { query, mode: 'vector' }, { threadId: fixture.threadId });
  assert.equal(toolHits[0].citation.id, knowledge.hits[0].citation.id);
  const memoryHits = await fixture.tools.execute('search_memory', { query, mode: 'vector' }, { threadId: fixture.threadId });
  assert.equal(memoryHits[0].id, remembered.id);
});

test('reciprocal-rank fusion rewards agreement without mixing BM25 and cosine scales', () => {
  const result = fuseRanks([{ id: 'lexical', score: 5000 }, { id: 'shared', score: 4000 }], [{ id: 'semantic', score: 0.99 }, { id: 'shared', score: 0.98 }], 3);
  assert.equal(result[0].id, 'shared');
  assert.ok(result.every((item) => item.score > 0 && item.score <= 1));
});

test('persistent vectors survive restart and duplicates do not re-embed source text', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, undefined, embedding);
  const input = { title: 'Transport', content: 'A bicycle is useful for commuting.' };
  await Promise.all([fixture.knowledge.importDocument(input), fixture.knowledge.importDocument(input)]);
  assert.equal(embedding.calls.length, 1);
  const saved = await readFile(`${fixture.dataFile}.vectors.json`, 'utf8');
  assert.equal(JSON.parse(saved).entries.length, 1);
  assert.ok(!saved.includes(input.content));
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(fixture.dataFile, 'utf8')), 'vectors'));
  const freshEmbedding = embeddingFixture();
  const restored = await createApp({ dataFile: fixture.dataFile, workspaceRoot: fixture.root, embeddingProvider: freshEmbedding });
  assert.equal(restored.runtime.knowledge.indexStatus().pending, 0);
  assert.equal((await restored.runtime.knowledge.search('两轮通勤工具', { mode: 'vector' }))[0].title, 'Transport');
  assert.deepEqual(freshEmbedding.calls, [['两轮通勤工具']]);
  await restored.runtime.knowledge.deleteDocument(fixture.knowledge.list()[0].id);
  assert.equal(restored.runtime.vectors.describe().cachedVectors, 0);
  assert.equal(JSON.parse(await readFile(`${fixture.dataFile}.vectors.json`, 'utf8')).entries.length, 0);
});

test('changed embedding profiles and dimensions rebuild the derived index without migrating user data', async (t) => {
  const fixture = await workflowFixture(t, undefined, embeddingFixture());
  await fixture.knowledge.importDocument({ title: 'Transport', content: 'A bicycle is useful for commuting.' });
  const changed = embeddingFixture({ profile: 'fixture-v2', dimensions: 2, vectorFor: () => [1, 0] });
  const restored = await createApp({ dataFile: fixture.dataFile, workspaceRoot: fixture.root, embeddingProvider: changed });
  assert.equal(restored.runtime.knowledge.indexStatus().pending, 1);
  const result = await restored.runtime.knowledge.searchWithMetadata('两轮通勤工具');
  assert.equal(result.method, 'hybrid');
  assert.equal(result.hits.length, 1);
  assert.equal(result.index.pending, 0);
  assert.ok(changed.calls.flat().some((text) => text.includes('bicycle')));
  assert.equal(restored.runtime.store.snapshot().schemaVersion, 2);
  assert.equal(JSON.parse(await readFile(`${fixture.dataFile}.vectors.json`, 'utf8')).entries[0].vector.length, 2);
});

test('lazy indexing and retrieval include only global and current-thread sources', async (t) => {
  const fixture = await workflowFixture(t);
  const other = await fixture.store.createThread({ title: 'private thread' });
  const publicDoc = await fixture.knowledge.importDocument({ title: 'Public', content: 'A bicycle for public travel.' });
  const currentDoc = await fixture.knowledge.importDocument({ title: 'Current', content: 'A bicycle for this thread.', threadId: fixture.threadId });
  await fixture.knowledge.importDocument({ title: 'private-other-source', content: 'A bicycle from another thread.', threadId: other.id });
  await fixture.memory.remember('Cycling in public.');
  await fixture.memory.remember('Cycling in this thread.', { threadId: fixture.threadId });
  await fixture.memory.remember('private-other-memory: Cycling elsewhere.', { threadId: other.id });
  const embedding = embeddingFixture();
  const vectors = await new VectorIndex(`${fixture.dataFile}.vectors.json`, embedding).init();
  const knowledge = new KnowledgeService(fixture.store, vectors);
  const memory = new MemoryService(fixture.store, vectors);
  const hits = await knowledge.search('两轮通勤工具', { threadId: fixture.threadId });
  assert.deepEqual(new Set(hits.map((hit) => hit.documentId)), new Set([publicDoc.document.id, currentDoc.document.id]));
  assert.equal((await memory.search('两轮通勤工具', { threadId: fixture.threadId })).length, 2);
  assert.ok(!embedding.calls.flat().some((text) => text.includes('private-other')));
  assert.deepEqual((await knowledge.search('两轮通勤工具')).map((hit) => hit.documentId), [publicDoc.document.id]);
  assert.equal((await memory.search('两轮通勤工具')).length, 1);
});

test('embedding outages preserve imports and explicitly fall back to lexical retrieval', async (t) => {
  const embedding = embeddingFixture();
  embedding.fail = true;
  const fixture = await workflowFixture(t, undefined, embedding);
  const imported = await fixture.knowledge.importDocument({ title: 'Transport', content: 'A bicycle is useful for commuting.' });
  await fixture.memory.remember('Cycling is useful.');
  assert.equal(imported.indexing.pending, 1);
  assert.match(imported.indexing.error, /503/);
  const docs = await fixture.knowledge.searchWithMetadata('bicycle');
  const memories = await fixture.memory.searchWithMetadata('Cycling');
  assert.equal(docs.method, 'bm25');
  assert.equal(memories.method, 'keyword');
  assert.equal(docs.hits.length, 1);
  assert.equal(memories.hits.length, 1);
  assert.match(docs.fallbackReason, /503/);
  assert.match(fixture.vectors.describe().lastError.message, /503/);
  embedding.fail = false;
  const recovered = await fixture.knowledge.searchWithMetadata('两轮通勤工具');
  assert.equal(recovered.method, 'hybrid');
  assert.equal(recovered.index.pending, 0);
  assert.equal(fixture.vectors.describe().lastError, null);
});

test('long memories embed all passages and contribute the matched passage to bounded context', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, undefined, embedding);
  const text = 'Administrative notes. '.repeat(160) + 'A bicycle is my preferred transport.';
  const remembered = await fixture.memory.remember(text, { threadId: fixture.threadId });
  assert.ok(embedding.calls.flat().every((part) => part.length <= EMBEDDING_LIMITS.inputChars));
  const context = await fixture.memory.prepareContext(fixture.threadId, '两轮通勤工具');
  assert.equal(context.memories[0].id, remembered.id);
  assert.match(context.memories[0].text, /bicycle/);
  assert.ok(context.memories[0].text.length <= 2000);
  assert.equal(context.citations[0].text, context.memories[0].text);
  assert.equal(context.retrieval.memory.method, 'hybrid');
});

test('backfill is bounded and resumes without re-embedding completed entries', async (t) => {
  const fixture = await workflowFixture(t);
  const embedding = embeddingFixture();
  const vectors = await new VectorIndex(join(fixture.root, 'bounded-vectors.json'), embedding).init();
  const sources = Array.from({ length: EMBEDDING_LIMITS.indexItems + 2 }, (_, index) => ({ id: `source-${index}`, text: `A bicycle ${index}` }));
  const first = await vectors.index('knowledge', () => sources);
  assert.equal(first.added, EMBEDDING_LIMITS.indexItems);
  assert.equal(first.pending, 2);
  const resumed = await vectors.index('knowledge', () => sources);
  assert.equal(resumed.added, 2);
  assert.equal(resumed.pending, 0);
  const before = embedding.calls.length;
  assert.equal((await vectors.index('knowledge', () => sources)).added, 0);
  assert.equal(embedding.calls.length, before);
  sources[0].text = 'A physician is available.';
  assert.equal((await vectors.index('knowledge', () => sources)).added, 1);
});

test('a document deleted during an embedding request cannot leave retrievable or orphaned vectors', { timeout: 5000 }, async (t) => {
  const embedding = embeddingFixture();
  const originalEmbed = embedding.embed.bind(embedding);
  let release;
  let entered;
  const gate = new Promise<void>((done) => { release = done; });
  const started = new Promise<void>((done) => { entered = done; });
  embedding.embed = async (inputs) => { entered(); await gate; return originalEmbed(inputs); };
  t.after(() => release());
  const fixture = await workflowFixture(t, undefined, embedding);
  const importing = fixture.knowledge.importDocument({ title: 'Transport', content: 'A bicycle to be deleted.' });
  await started;
  const documentId = fixture.knowledge.list()[0].id;
  let deleted;
  const sourceDeleted = new Promise<void>((done) => { deleted = done; });
  const originalDelete = fixture.store.deleteKnowledgeDocument.bind(fixture.store);
  t.mock.method(fixture.store, 'deleteKnowledgeDocument', async (...args) => { await originalDelete(...args); deleted(); });
  const deleting = fixture.knowledge.deleteDocument(documentId);
  await sourceDeleted;
  release();
  await Promise.all([importing, deleting]);
  assert.equal(fixture.vectors.describe().cachedVectors, 0);
  assert.deepEqual(await fixture.knowledge.search('两轮通勤工具'), []);
});

test('invalid cached vectors are rebuilt and evicted memories are removed from the vector cache', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, undefined, embedding);
  await fixture.memory.remember('Cycling is useful.');
  const cacheFile = `${fixture.dataFile}.vectors.json`;
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  cache.entries[0].vector = [0, 0, 0];
  await writeFile(cacheFile, JSON.stringify(cache));
  const vectors = await new VectorIndex(cacheFile, embedding).init();
  const memory = new MemoryService(fixture.store, vectors);
  assert.equal(memory.indexStatus().pending, 1);
  assert.equal((await memory.search('两轮通勤工具')).length, 1);
  await fixture.store.mutate((state) => { state.memories = []; });
  await memory.remember('A physician is available.');
  assert.equal(vectors.describe().cachedVectors, 1);
  assert.deepEqual(await memory.search('两轮通勤工具'), []);
});

test('agent context and execution events report the actual retrieval method and preserve semantic citations', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, { async complete(input) {
    const hit = input.context.knowledge[0];
    assert.equal(input.context.retrieval.knowledge.method, 'hybrid');
    return { content: `推荐原文中的通勤工具 [${hit.citation.id}]` };
  } }, embedding);
  await fixture.knowledge.importDocument({ title: 'Transport', content: 'A bicycle is useful for commuting.', threadId: fixture.threadId });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '两轮通勤工具');
  assert.equal(result.messages[0].citations.length, 1);
  assert.match(result.messages[0].citations[0].text, /bicycle/);
  const event = fixture.store.listEvents({ threadId: fixture.threadId }).find((event) => event.type === 'knowledge.retrieved');
  assert.equal(event.payload.method, 'hybrid');
  assert.equal(event.payload.index.pending, 0);
});

test('HTTP exposes modes, index progress, fallback state and semantic results without raw vectors', async (t) => {
  const embedding = embeddingFixture();
  const fixture = await workflowFixture(t, undefined, embedding);
  await new Promise<void>((done) => fixture.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${fixture.server.address().port}`;
  const request = async (path, body?) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const imported = await request('/api/knowledge/documents', { title: 'Transport', content: 'A bicycle for commuting.', threadId: fixture.threadId });
  assert.equal(imported.status, 201);
  await request('/api/memories', { text: 'Cycling for commuting.', threadId: fixture.threadId });
  const query = encodeURIComponent('两轮通勤工具');
  const result = await request(`/api/knowledge/search?threadId=${fixture.threadId}&q=${query}&mode=vector`);
  assert.equal(result.body.method, 'vector');
  assert.equal(result.body.hits.length, 1);
  assert.ok(!/"vector":\[/.test(JSON.stringify(result.body)));
  assert.equal((await request(`/api/memories?threadId=${fixture.threadId}&q=${query}`)).body.memories.length, 1);
  assert.equal((await request(`/api/knowledge/search?q=${query}`)).body.hits.length, 0);
  assert.equal((await request('/api/knowledge/search?q=hello&mode=invalid')).status, 400);
  assert.equal((await request('/api/retrieval/reindex', { threadId: 'missing' })).status, 404);
  assert.equal((await request('/api/retrieval/reindex', { threadId: 12 })).status, 400);
  const status = (await request(`/api/retrieval?threadId=${fixture.threadId}`)).body;
  assert.equal(status.enabled, true);
  assert.equal(status.knowledge.pending, 0);
  assert.equal(status.memory.pending, 0);
  assert.equal((await request('/api/retrieval/reindex', { threadId: fixture.threadId })).body.knowledge.added, 0);
  assert.equal((await request('/api/bootstrap')).body.knowledge.method, 'hybrid');
  embedding.fail = true;
  const fallback = await request(`/api/knowledge/search?threadId=${fixture.threadId}&q=bicycle`);
  assert.equal(fallback.body.method, 'bm25');
  assert.equal(fallback.body.hits.length, 1);
  assert.match(fallback.body.fallbackReason, /503/);
});

test('MCP runtime shares semantic retrieval for knowledge and memory with its own persistent cache', async (t) => {
  const fixture = await workflowFixture(t);
  const runtime = await createMcpRuntime({ dataFile: join(fixture.root, 'mcp-state.json'), workspaceRoot: fixture.root, embeddingProvider: embeddingFixture() });
  await runtime.knowledge.importDocument({ title: 'Transport', content: 'A bicycle for commuting.' });
  await runtime.memory.remember('Cycling for commuting.');
  const sources = await runtime.tools.execute('search_knowledge', { query: '两轮通勤工具' }, { threadId: 'mcp' });
  const memories = await runtime.tools.execute('search_memory', { query: '两轮通勤工具' }, { threadId: 'mcp' });
  assert.equal(sources.length, 1);
  assert.equal(memories.length, 1);
  assert.equal(runtime.vectors.describe().cachedVectors, 2);
  assert.equal(fixture.store.listKnowledgeDocuments().length, 0);
});
