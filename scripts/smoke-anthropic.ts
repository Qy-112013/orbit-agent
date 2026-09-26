/**
 * Live smoke test for AnthropicProvider against any Anthropic-compatible endpoint.
 * Usage: node --env-file=.env.local --experimental-strip-types scripts/smoke-anthropic.ts
 * Never prints credentials.
 */
import { AnthropicProvider } from '../src/core/anthropic-provider.ts';
import { AgentLoop } from '../src/core/agent-loop.ts';
import { parsePlan } from '../src/core/planner.ts';
import { ProviderSummarizer } from '../src/core/compaction.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalBroker } from '../src/core/approvals.ts';
import { McpManager } from '../src/core/mcp-client.ts';
import { ToolRegistry } from '../src/core/tools.ts';
import { registerWorkspaceWriteTools } from '../src/core/workspace-tools.ts';

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
  const deltas: string[] = [];
  const result = await provider.complete({ agent, content: '用两句话介绍一下流式输出的好处。', context, onDelta: (text) => deltas.push(text) });
  if (deltas.length < 2 || deltas.join('').trim() !== result.content) throw new Error(`expected streamed deltas matching the answer, got ${deltas.length}`);
  return `model=${result.model} deltas=${deltas.length} usage=${JSON.stringify(result.usage)}\n${result.content.slice(0, 200)}`;
});

await check('model summary', async () => {
  const messages = [
    { role: 'user', content: '项目 Vega 的硬约束：只能使用本地存储，预算 48000 元。' },
    { role: 'assistant', agentId: 'atlas', content: '收到，我会按本地存储设计，并把预算上限记为 48000 元。' },
    { role: 'user', content: '另外，发布日期定在十月底。' },
  ].map((message, index) => ({ id: `m${index + 1}`, threadId: 't', sequence: index + 1, createdAt: '', metadata: {}, ...message })) as any;
  const summary = await new ProviderSummarizer(provider).summarize({ messages });
  if (!/48000|4\.8\s*万/.test(summary) || !/本地存储/.test(summary)) throw new Error(`summary lost key constraints: ${summary}`);
  return summary.slice(0, 400);
});

await check('tool round trip', async () => {
  const events: string[] = [];
  const loop = new AgentLoop({ provider, tools });
  const result = await loop.run({ agent, content: '请用 lookup_fact 工具分别查询 alpha 和 beta，然后告诉我两个值之和。', context },
    { threadId: 'smoke', runId: 'r1' }, async (type, payload: any) => { if (type.startsWith('tool.')) events.push(`${type}:${payload.tool}`); });
  return `steps=${JSON.stringify(result.metadata?.agentLoop)} events=${events.join(',')}\n${result.content.slice(0, 300)}`;
});

await check('approved workspace write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-smoke-write-'));
  try {
    const registry = registerWorkspaceWriteTools(new ToolRegistry(), { workspaceRoot: root, backupDir: join(root, '.backups'), protectedDirs: [join(root, '.backups')] });
    const approvals: string[] = [];
    // Stands in for the human: approves every request as soon as it is published.
    const broker = new ApprovalBroker({ emit: async (_threadId, type, payload: any) => {
      if (type === 'approval.requested') { approvals.push(`${payload.tool}: ${payload.summary}`); await broker.decide(payload.approvalId, { approved: true }); }
    } });
    const loop = new AgentLoop({ provider, tools: registry, toolPolicy: 'approval', approvals: broker });
    const result = await loop.run({ agent, content: '请用 workspace_write 工具创建文件 notes/hello.md，内容恰好是一行：你好，Orbit。完成后简短确认。', context },
      { threadId: 'smoke', runId: 'r3' }, async () => {});
    const written = await readFile(join(root, 'notes', 'hello.md'), 'utf8');
    if (!written.includes('你好，Orbit')) throw new Error(`unexpected file content: ${JSON.stringify(written)}`);
    if (!approvals.length) throw new Error('the write ran without an approval request');
    return `approvals=${JSON.stringify(approvals)} file=${JSON.stringify(written)}\n${result.content.slice(0, 200)}`;
  } finally { await rm(root, { recursive: true, force: true }); }
});

await check('mcp tool round trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-smoke-mcp-'));
  const registry = new ToolRegistry();
  const manager = new McpManager({ registry, configPath: join(dir, 'mcp.json'), cwd: dir });
  try {
    const fixture = fileURLToPath(new URL('../test/mcp-server-fixture.ts', import.meta.url));
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', fixture], autoApprove: ['echo'] } } }));
    await manager.start();
    const loop = new AgentLoop({ provider, tools: registry, toolPolicy: 'approval', approvals: new ApprovalBroker({ emit: async () => { throw new Error('echo is auto-approved'); } }) });
    const events: string[] = [];
    const result = await loop.run({ agent, content: '请调用 mcp__fixture__echo 工具，参数 text 为 "orbit-mcp-ok"，然后原样告诉我工具返回的文本。', context },
      { threadId: 'smoke', runId: 'r4' }, async (type, payload: any) => { if (type.startsWith('tool.')) events.push(`${type}:${payload.tool}`); });
    if (!events.includes('tool.completed:mcp__fixture__echo')) throw new Error(`echo was not called successfully: ${events.join(',')}`);
    return `events=${events.join(',')}\n${result.content.slice(0, 200)}`;
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
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
