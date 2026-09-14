import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../src/server.ts';
import { JsonStore } from '../src/core/store.ts';
import { createWorkflowDemoProvider } from './workflow-demo-provider.ts';

const root = await mkdtemp(join(tmpdir(), 'orbit-workflow-demo-'));
try {
  const dataFile = join(root, 'state.json');
  const { runtime } = await createApp({ dataFile, workspaceRoot: root, provider: createWorkflowDemoProvider(), embeddingProvider: null, loopOptions: { toolsEnabled: true } });
  const threadId = runtime.store.listThreads()[0].id;
  await runtime.store.appendMessage({ threadId, role: 'user', content: '原始目标：仅使用本地资料核对 Quartz 发布说明。' });
  for (let index = 1; index < 16; index += 1) await runtime.store.appendMessage({ threadId, role: index % 2 ? 'assistant' : 'user', content: `历史记录 ${index}：需要保留来源，尚未声称通过验收。` });
  const document = await runtime.knowledge.importDocument({ title: 'Quartz 发布说明', source: 'release.md', content: 'Quartz 发布预算：48000 元。\n发布校验码 checksum: b12。', threadId });
  const chat = await runtime.orchestrator.submitMessage(threadId, 'Quartz 预算是多少？');
  const result = await runtime.orchestrator.submitMessage(threadId, '#plan @atlas @forge @lens 核对 Quartz 发布预算与校验码');
  assert.ok(chat.context.summary);
  assert.equal(chat.messages[0].citations[0].documentId, document.document.id);
  assert.equal(result.plan.status, 'completed');
  assert.equal(result.plan.replanCount, 1);
  assert.notEqual(result.plan.revisions[0].steps[0].title, result.plan.revisions[1].steps[0].title);
  const restored = await new JsonStore(dataFile).init();
  assert.equal(restored.getPlan(result.plan.id).status, 'completed');
  console.log(JSON.stringify({
    mode: 'scripted-offline-demo; no real model calls',
    conversation: { summaryMessages: chat.context.summary.messageCount, recentMessages: chat.context.recentMessages.length },
    knowledge: { documents: 1, matchedChunks: chat.context.knowledge.length, citedSource: chat.messages[0].citations[0].source },
    plan: { status: result.plan.status, replans: result.plan.replanCount, stepRuns: result.plan.stepRunCount,
      revisions: result.plan.revisions.map((revision) => ({ revision: revision.revision, steps: revision.steps.map((step) => ({ title: step.title, owner: step.owner, status: step.status })), review: revision.review?.verdict })) },
    persistence: 'verified after reloading state',
  }, null, 2));
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('orbit-workflow-demo-'));
  await rm(root, { recursive: true, force: true });
}
