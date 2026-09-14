import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../src/server.ts';
import type { ProviderInput, ProviderResult } from '../src/core/types.ts';

// Scripted model choices keep the demo reproducible; tools, orchestration,
// parent/child results and durable events all use the real runtime.
const provider = {
  id: 'scripted-collaboration-demo',
  async complete(request: ProviderInput): Promise<ProviderResult> {
    const results = (request.transcript ?? []).filter((message) => message.role === 'tool');
    if (request.content.includes('第一轮讨论：')) return { content: request.agent.name + '：先明确执行边界，并保留可复现的证据。' };
    if (request.content.includes('第二轮讨论：')) return { content: request.agent.name + '：已阅读第一轮观点，赞同执行上限；补充失败隔离与来源核对。' };
    if (request.content.includes('两轮讨论结束。')) return { content: '共识：保留执行上限、失败隔离和来源引用。待核实：真实模型的协作质量。下一步：选择真实 Provider 验证。' };
    if (request.agent.id === 'atlas') {
      if (!results.length) return { content: '', toolCalls: [{ id: 'delegate-build', name: 'delegate_to_agent', arguments: JSON.stringify({ agentId: 'forge', task: '读取 evidence.txt 并提出实施建议。' }) }] };
      if (results.length === 1) return { content: '', toolCalls: [{ id: 'delegate-review', name: 'delegate_to_agent', arguments: JSON.stringify({ agentId: 'lens', task: '审查 Forge 的结果：' + JSON.parse(results[0].content).content }) }] };
      return { content: '已收到 Forge 的实施建议和 Lens 的复核。' };
    }
    if (request.agent.id === 'forge') {
      if (!results.length) return { content: '', toolCalls: [{ id: 'read-evidence', name: 'workspace_read', arguments: '{"path":"evidence.txt"}' }] };
      return { content: '读取到真实工具结果：' + JSON.parse(results[0].content).content };
    }
    return { content: 'Lens 复核：保留失败路径测试，并验证子 Agent 不会无限递归。' };
  },
};

const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, 'orbit-collaboration-demo-'));
try {
  await writeFile(join(root, 'evidence.txt'), 'Orbit 的每轮委派最多 2 次，深度最多 1 层。');
  const { runtime } = await createApp({ provider, embeddingProvider: null, workspaceRoot: root, dataFile: join(root, 'state.json') });
  const threadId = runtime.store.listThreads()[0].id;
  console.log('离线协议演示：模型决策使用固定脚本；工具、委派、回传、讨论与持久化使用真实运行时。');
  const delegated = await runtime.orchestrator.submitMessage(threadId, '@atlas 请 Forge 提出建议，再请 Lens 复核，最后汇总。');
  console.log('\n委派与回传：');
  for (const event of runtime.store.listEvents({ threadId, limit: 500 }).filter((event) => ['agent.delegated', 'agent.returned'].includes(event.type))) {
    console.log(event.type + ': ' + event.payload.fromAgentId + ' → ' + event.payload.toAgentId);
  }
  console.log(delegated.messages[0].content);
  const discussion = await runtime.orchestrator.submitMessage(threadId, '#discuss @forge @lens 讨论如何验证协作可靠性。');
  console.log('\n两轮讨论：');
  for (const message of discussion.messages) {
    console.log('[' + message.agentName + ' · ' + (message.metadata.round ? '第 ' + message.metadata.round + ' 轮' : '汇总') + '] ' + message.content);
  }
  console.log('\n委派次数：' + delegated.collaboration.delegations + '；讨论回答数：' + discussion.messages.length + '。');
} finally {
  if (dirname(root) !== parent || !basename(root).startsWith('orbit-collaboration-demo-')) throw new Error('Unexpected demo cleanup path');
  await rm(root, { recursive: true, force: true });
}
