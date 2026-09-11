import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../src/core/skills.ts';
import { createMcpHandler } from '../src/mcp-server.ts';
import { createDefaultTools, ToolRegistry } from '../src/core/tools.ts';

test('loads local markdown skills with typed metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'review.md'), '---\nid: review\nname: Review\ndescription: Check risks.\nkeywords: review, 审查\n---\n\nCheck boundaries.', 'utf8');
  const registry = await new SkillRegistry().loadDirectory(root);
  assert.deepEqual(registry.get('review'), {
    id: 'review', name: 'Review', description: 'Check risks.', keywords: ['review', '审查'], content: 'Check boundaries.', source: join(root, 'review.md'),
  });
});

test('selects a skill from Chinese task keywords', () => {
  const skills = new SkillRegistry().register({ id: 'architecture', name: 'Architecture', description: '', keywords: ['架构', '设计'], content: 'Review boundaries.', source: 'memory' });
  assert.equal(skills.select('请做架构设计')[0].id, 'architecture');
});

test('exposes registered tools through MCP tools/list and tools/call', async () => {
  const tools = new ToolRegistry().register({
    name: 'echo', description: 'Echo input', inputSchema: { type: 'object' },
    execute: async (input) => input,
  });
  const handle = createMcpHandler(tools);
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((value: string) => { output.push(value); return true; }) as typeof process.stdout.write;
  try {
    await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { ok: true } } });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(output[0], /"name":"echo"/);
  const response = JSON.parse(output[1]);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: true });
});

test('exposes loaded skills as MCP resources', async () => {
  const skills = new SkillRegistry().register({ id: 'demo', name: 'Demo', description: 'Demo skill', content: 'Do the demo.', source: 'memory' });
  const handle = createMcpHandler(new ToolRegistry(), skills);
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((value: string) => { output.push(value); return true; }) as typeof process.stdout.write;
  try {
    await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    await handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'skill://demo' } });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(output[0], /skill:\/\/demo/);
  assert.equal(JSON.parse(output[1]).result.contents[0].text, 'Do the demo.');
});

test('workspace tools stay inside the configured root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-agent-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'hello workspace', 'utf8');
  const tools = createDefaultTools({
    workspaceRoot: root,
    memory: { search: () => [], remember: async () => ({}) },
    store: { createTask: async () => ({}), listTasks: () => [] },
  });
  const files = await tools.execute('workspace_list', {});
  assert.deepEqual(files, [{ name: 'note.txt', kind: 'file' }]);
  assert.equal((await tools.execute('workspace_read', { path: 'note.txt' })).content, 'hello workspace');
  await assert.rejects(() => tools.execute('workspace_read', { path: '../outside.txt' }), { code: 'WORKSPACE_PATH_DENIED' });
});

test('workspace reads reject links outside the root and bound large files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-tool-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside evidence');
  await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(workspace, 'large.txt'), 'a'.repeat(250_000));
  const tools = createDefaultTools({ workspaceRoot: workspace, memory: {}, store: {} });
  await assert.rejects(() => tools.execute('workspace_read', { path: 'linked/secret.txt' }), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(() => tools.execute('workspace_list', { path: 'linked' }), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(() => tools.execute('workspace_read', { path: 3 }), { code: 'INVALID_TOOL_ARGUMENTS' });
  const result = await tools.execute('workspace_read', { path: 'large.txt' });
  assert.equal(result.content.length, 200_000);
  assert.equal(result.truncated, true);
});
