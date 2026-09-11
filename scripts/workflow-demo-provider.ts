import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderInput, ProviderResult } from '../src/core/types.ts';

/** Scripted fixture only. Exercises the runtime, not real model intelligence. */
export function createWorkflowDemoProvider() {
  const answer = (content: string, toolCalls?: ProviderResult['toolCalls']): ProviderResult => ({
    content, ...(toolCalls ? { toolCalls } : {}), provider: 'scripted-demo', model: 'fixture-only', metadata: { scripted: true },
  });
  return { id: 'scripted-demo', async complete(input: ProviderInput): Promise<ProviderResult> {
    const workflow = input.context.workflow;
    if (workflow?.kind === 'planning') {
      const revision = workflow.revision;
      return answer(JSON.stringify({ steps: [{
        id: revision ? 'verify-checksum' : 'read-budget',
        title: revision ? '核验发布校验码' : '查阅发布预算',
        owner: revision ? workflow.participants[0] : workflow.participants[1] ?? workflow.participants[0],
        dependsOn: [], acceptance: '依据导入的发布说明，报告预算、校验码和原文引用。',
      }] }));
    }
    if (workflow?.kind === 'review') {
      if (workflow.revision === 0) return answer(JSON.stringify({ verdict: 'revise', feedback: '已有预算信息；请补充校验码 b12 的原文核验。' }));
      return answer(JSON.stringify({ verdict: input.content.includes('b12') ? 'pass' : 'blocked', feedback: input.content.includes('b12') ? '演示复核：预算与校验码 b12 均有原文依据。' : '演示所需的校验码证据缺失。' }));
    }
    if (input.content.includes('执行当前步骤：')) {
      const result = input.transcript?.find((message) => message.role === 'tool');
      if (!result) return answer('', [{ id: 'lookup', name: 'search_knowledge', arguments: JSON.stringify({ query: 'Quartz', limit: 1 }) }]);
      const hit = JSON.parse(result.content)[0];
      if (!hit) throw new Error('The workflow demo needs its Quartz knowledge document.');
      return answer(input.content.includes('执行当前步骤：查阅发布预算')
        ? `演示步骤：发布预算为 48000 元。[${hit.citation.id}]`
        : `演示步骤已核对原文：${hit.citation.text} [${hit.citation.id}]`);
    }
    if (input.content.startsWith('SLOW_TURN')) await delay(900);
    const hit = input.context.knowledge?.[0];
    return answer(hit ? `演示回答，检索原文如下：\n${hit.text}\n[${hit.citation.id}]` : `演示回答：已收到 ${input.content.slice(0, 120)}`);
  } };
}
