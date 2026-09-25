/**
 * Live smoke test for AnthropicProvider against any Anthropic-compatible endpoint.
 * Usage: node --env-file=.env.local --experimental-strip-types scripts/smoke-anthropic.ts
 * Never prints credentials.
 */
import { AnthropicProvider } from '../src/core/anthropic-provider.ts';
import { AgentLoop } from '../src/core/agent-loop.ts';
import { parsePlan } from '../src/core/planner.ts';

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
const provider = new AnthropicProvider({
  apiKey,
  ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
  ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
  timeoutMs: 120_000,
});
const agent = { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [], systemPrompt: 'You are a concise assistant.' };
const context = { recentMessages: [], memories: [], citations: [] };
const facts: Record<string, string> = { alpha: 'Alpha 的值是 42', beta: 'Beta 的值是 7' };
const tools = {
  list: () => [{ name: 'lookup_fact', description: 'Look up a stored fact by key.', readOnly: true,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }],
  execute: async (_name: string, input: any) => ({ key: input.key, fact: facts[input.key] ?? 'not found' }),
} as any;

async function check(name: string, run: () => Promise<string>) {
  const startedAt = Date.now();
  try {
    const output = await run();
    console.log(`PASS ${name} (${Date.now() - startedAt}ms)\n  ${output.replace(/\n/g, '\n  ')}`);
  } catch (error) {
    console.log(`FAIL ${name} (${Date.now() - startedAt}ms)\n  ${error?.status ?? ''} ${String(error?.message ?? error).slice(0, 800)}`);
  }
}

await check('plain chat', async () => {
  const result = await provider.complete({ agent, content: '用一句话回答：1+1 等于几？', context });
  return `model=${result.model} usage=${JSON.stringify(result.usage)}\n${result.content.slice(0, 200)}`;
});

await check('tool round trip', async () => {
  const events: string[] = [];
  const loop = new AgentLoop({ provider, tools });
  const result = await loop.run({ agent, content: '请用 lookup_fact 工具分别查询 alpha 和 beta，然后告诉我两个值之和。', context },
    { threadId: 'smoke', runId: 'r1' }, async (type, payload: any) => { if (type.startsWith('tool.')) events.push(`${type}:${payload.tool}`); });
  return `steps=${JSON.stringify(result.metadata?.agentLoop)} events=${events.join(',')}\n${result.content.slice(0, 300)}`;
});

await check('structured plan', async () => {
  const loop = new AgentLoop({ provider, tools });
  // Mirrors PlanExecutor's planning prompt so providers that ignore output_config.format are tested fairly.
  const content = [
    '为以下目标制定可验证的执行计划：\n给项目加一个健康检查接口',
    '只能把步骤分配给这些 Agent：atlas, lens。最多 5 步；步骤依次执行，依赖只能指向前面的步骤。',
    '只返回 JSON：{"steps":[{"id":"s1","title":"具体工作","owner":"允许的 Agent ID","dependsOn":[],"acceptance":"可检查的验收标准"}]}。不要添加其他字段或说明。',
  ].join('\n\n');
  const result = await loop.run({ agent, content,
    context: { ...context, workflow: { kind: 'planning', goal: '加健康检查接口', participants: ['atlas', 'lens'], revision: 0 } } },
    { threadId: 'smoke', runId: 'r2' }, async () => {});
  try {
    const steps = parsePlan(result.content, ['atlas', 'lens']);
    return `${steps.length} steps: ${steps.map((step) => `${step.id}(${step.owner})`).join(', ')}`;
  } catch (error) {
    throw new Error(`${error.message}\n  raw: ${JSON.stringify(result.content.slice(0, 400))}`);
  }
});
