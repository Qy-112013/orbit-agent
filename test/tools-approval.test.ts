import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.ts';
import { AgentLoop } from '../src/core/agent-loop.ts';
import { ToolRegistry } from '../src/core/tools.ts';
import { deletionReason, registerWorkspaceWriteTools, runShell, sanitizedEnv } from '../src/core/workspace-tools.ts';

const agent = { id: 'forge', name: 'Forge', role: 'builder', aliases: [] };
const context = { recentMessages: [], memories: [], citations: [] };
const node = `"${process.execPath}"`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-tools-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(data);
  const tools = registerWorkspaceWriteTools(new ToolRegistry(), { workspaceRoot: root, backupDir: join(data, 'backups'), protectedDirs: [data] });
  const call = (name: string, input: Record<string, unknown>) => tools.execute(name, input, { threadId: 't', agentId: 'forge' });
  return { root, data, tools, call };
}

function brokerWith(events: Array<{ type: string; payload: any }>, timeoutMs?: number) {
  return new ApprovalBroker({ emit: async (_threadId, type, payload) => { events.push({ type, payload }); }, ...(timeoutMs ? { timeoutMs } : {}) });
}

test('approvals resolve by decision or timeout and are audited', async () => {
  const events: Array<{ type: string; payload: any }> = [];
  const broker = brokerWith(events, 50);
  const request = { threadId: 't', runId: 'r', agentId: 'forge', tool: 'shell_exec', summary: 's', preview: 'p'.repeat(5000) };
  const approved = broker.request(request);
  assert.equal(broker.list('t').length, 1);
  assert.equal(broker.list('t')[0].preview.length, 4000);
  await broker.decide(events[0].payload.approvalId, { approved: true });
  assert.deepEqual(await approved, { approved: true, by: 'user' });
  await assert.rejects(broker.decide(events[0].payload.approvalId, { approved: false }), { code: 'CONFLICT' });
  await assert.rejects(broker.decide('approval_missing', { approved: false }), { code: 'NOT_FOUND' });
  const expired = await broker.request(request);
  assert.equal(expired.approved, false);
  assert.equal(expired.by, 'timeout');
  assert.deepEqual(events.map((event) => event.type), ['approval.requested', 'approval.resolved', 'approval.requested', 'approval.resolved']);
  const pending = broker.request(request);
  await broker.close();
  assert.equal((await pending).by, 'shutdown');
});

test('write tools require approval in the agent loop; denial reaches the model and it continues', async (t) => {
  const { root, tools } = await workspace(t);
  const events: Array<{ type: string; payload: any }> = [];
  const broker = new ApprovalBroker({ emit: async (_threadId, type, payload) => {
    events.push({ type, payload });
    if (type === 'approval.requested') {
      const approved = payload.preview.includes('first');
      setImmediate(() => { void broker.decide(payload.approvalId, { approved, reason: approved ? undefined : 'not this one' }); });
    }
  } });
  const results: string[] = [];
  let step = 0;
  const provider = { async complete(input: any) {
    step += 1;
    if (step === 1) return { content: '', toolCalls: [
      { id: 'a', name: 'workspace_write', arguments: JSON.stringify({ path: 'notes/one.txt', content: 'first' }) },
      { id: 'b', name: 'workspace_write', arguments: JSON.stringify({ path: 'notes/two.txt', content: 'second' }) },
    ] };
    results.push(...input.transcript.filter((message: any) => message.role === 'tool').map((message: any) => message.content));
    return { content: 'done' };
  } };
  const loop = new AgentLoop({ provider, tools, toolPolicy: 'approval', approvals: broker });
  assert.deepEqual(loop.describe().approvalTools.sort(), ['shell_exec', 'workspace_edit', 'workspace_write']);
  const result = await loop.run({ agent, content: 'write', context }, { threadId: 't', runId: 'r' }, async () => {});
  assert.equal(result.content, 'done');
  assert.equal(await readFile(join(root, 'notes', 'one.txt'), 'utf8'), 'first');
  await assert.rejects(readFile(join(root, 'notes', 'two.txt'), 'utf8'), { code: 'ENOENT' });
  assert.match(results[1], /APPROVAL_DENIED/);
  assert.match(results[1], /not this one/);
  assert.match(events[0].payload.summary, /写入 notes[\\/]one\.txt/);
});

test('read-only policy and a missing broker never offer side-effecting tools', async (t) => {
  const { tools } = await workspace(t);
  const broker = brokerWith([]);
  assert.equal(new AgentLoop({ provider: { async complete() { return { content: 'x' }; } }, tools, toolPolicy: 'read-only', approvals: broker }).describe().allowedTools.length, 0);
  assert.equal(new AgentLoop({ provider: { async complete() { return { content: 'x' }; } }, tools, toolPolicy: 'approval' }).describe().toolPolicy, 'read-only');
});

test('overwrites and edits back up the previous content', async (t) => {
  const { root, data, call } = await workspace(t);
  const created = await call('workspace_write', { path: 'src/a.txt', content: 'one\ntwo\n' });
  assert.equal(created.created, true);
  assert.equal(created.backup, undefined);
  const overwritten = await call('workspace_write', { path: 'src/a.txt', content: 'one\nTWO\n' });
  assert.equal(await readFile(overwritten.backup, 'utf8'), 'one\ntwo\n');
  const edit = await call('workspace_edit', { path: 'src/a.txt', oldText: 'TWO', newText: 'three' });
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'one\nthree\n');
  assert.equal(await readFile(edit.backup, 'utf8'), 'one\nTWO\n');
  assert.equal((await readdir(join(data, 'backups'))).length, 2);
  await assert.rejects(call('workspace_edit', { path: 'src/a.txt', oldText: 'missing', newText: 'x' }), { code: 'EDIT_NOT_UNIQUE' });
  await call('workspace_write', { path: 'src/b.txt', content: 'x x' });
  await assert.rejects(call('workspace_edit', { path: 'src/b.txt', oldText: 'x', newText: 'y' }), { code: 'EDIT_NOT_UNIQUE' });
});

test('writes outside the workspace, to secrets, .git or Orbit data are rejected', async (t) => {
  const { root, call } = await workspace(t);
  await writeFile(join(root, '.env'), 'SECRET=1');
  for (const path of ['../escape.txt', '.env', '.env.local', '.git/config', 'data/state.json', 'data/backups/x.txt']) {
    await assert.rejects(call('workspace_write', { path, content: 'x' }), { code: 'WORKSPACE_PATH_DENIED' }, path);
  }
  await call('workspace_write', { path: '.env.example', content: 'KEY=' });
});

test('deletion commands are rejected across shells, other commands pass', () => {
  for (const command of ['rm -rf build', 'echo ok && del /q a.txt', 'cmd /c rd /s /q out', 'git clean -fdx', 'git reset --hard HEAD', 'git checkout -- .',
    'find . -name "*.log" -delete', 'powershell -Command Remove-Item x', `${node} -e "require('fs').rmSync('x')"`, 'python -c "import os; os.remove(\'a\')"',
    'sudo rm a', 'FOO=1 rm a', 'ls | xargs rm', '/bin/rm a', 'rimraf dist', 'echo $(rm a)']) {
    assert.ok(deletionReason(command), command);
  }
  for (const command of ['npm test', 'git status', 'git diff -- src', 'node --version', 'echo removed items', 'dir /b', 'git checkout -b feature']) {
    assert.equal(deletionReason(command), null, command);
  }
});

test('shell_exec runs in the workspace, reports exit codes and hides secrets', async (t) => {
  const { root, call, tools } = await workspace(t);
  process.env.ORBIT_TEST_SECRET_TOKEN = 'leak';
  t.after(() => { delete process.env.ORBIT_TEST_SECRET_TOKEN; });
  const ok = await call('shell_exec', { command: `${node} -e "console.log(process.cwd()); console.log(process.env.ORBIT_TEST_SECRET_TOKEN ?? 'absent')"` });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /absent/);
  assert.ok(ok.stdout.includes(root) || ok.stdout.toLowerCase().includes(root.toLowerCase()));
  const failed = await call('shell_exec', { command: `${node} -e "console.error('boom'); process.exit(3)"` });
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /boom/);
  await assert.rejects(call('shell_exec', { command: 'rm -rf .' }), { code: 'DELETE_BLOCKED' });
  await assert.rejects(tools.describeCall('shell_exec', { command: 'del a.txt' }, {}), { code: 'DELETE_BLOCKED' });
  await assert.rejects(call('shell_exec', { command: 'echo x', cwd: '..' }), { code: 'WORKSPACE_PATH_DENIED' });
  assert.equal(sanitizedEnv({ PATH: 'p', GITHUB_TOKEN: 't', OPENAI_BASE_URL: 'u', MY_API_KEY: 'k' }).PATH, 'p');
  assert.deepEqual(Object.keys(sanitizedEnv({ PATH: 'p', GITHUB_TOKEN: 't', OPENAI_BASE_URL: 'u', MY_API_KEY: 'k' })), ['PATH']);
});

test('shell output stays UTF-8 and runaway commands are killed at the timeout', async (t) => {
  const { root } = await workspace(t);
  const unicode = await runShell(`${node} -e "console.log('你好')"`, { cwd: root, timeoutMs: 10_000 });
  assert.match(unicode.stdout, /你好/);
  const startedAt = Date.now();
  const slow = await runShell(`${node} -e "setTimeout(() => {}, 20000)"`, { cwd: root, timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - startedAt < 8_000);
});
