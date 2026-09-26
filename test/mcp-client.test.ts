import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpConnection, McpManager, loadMcpConfig, mcpResultContent, mcpToolName } from '../src/core/mcp-client.ts';
import { ToolRegistry } from '../src/core/tools.ts';
import { createApp } from '../src/server.ts';

const fixture = fileURLToPath(new URL('./mcp-server-fixture.ts', import.meta.url));
const fixtureConfig = (extra = {}) => ({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', fixture], ...extra });
const ctx = { threadId: 't', agentId: 'forge' };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-mcp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('config loading tolerates a missing file and rejects malformed servers', async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await loadMcpConfig(join(dir, 'absent.json')), {});
  const path = join(dir, 'mcp.json');
  await writeFile(path, '{ not json');
  await assert.rejects(loadMcpConfig(path), { code: 'MCP_CONFIG_INVALID' });
  await writeFile(path, JSON.stringify({ servers: {} }));
  await assert.rejects(loadMcpConfig(path), { code: 'MCP_CONFIG_INVALID' });
  await writeFile(path, JSON.stringify({ mcpServers: { bad: { args: [] } } }));
  await assert.rejects(loadMcpConfig(path), /needs a command/);
  await writeFile(path, JSON.stringify({ mcpServers: { bad: { command: 'x', args: [1] } } }));
  await assert.rejects(loadMcpConfig(path), /args must be strings/);
  await writeFile(path, JSON.stringify({ mcpServers: { ok: { command: 'x' } } }));
  assert.deepEqual(await loadMcpConfig(path), { ok: { command: 'x' } });
});

test('tool names are namespaced, sanitized and bounded; results are flattened', () => {
  assert.equal(mcpToolName('files', 'read'), 'mcp__files__read');
  assert.equal(mcpToolName('my server', 'do.it'), 'mcp__my_server__do_it');
  assert.equal(mcpToolName('s', 'x'.repeat(100)).length, 64);
  assert.deepEqual(mcpResultContent({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '...' }, { type: 'resource', resource: { uri: 'u', text: 'r' } }], structuredContent: { ok: 1 } }),
    { content: 'a\n[image content omitted]\nr', structuredContent: { ok: 1 } });
  assert.throws(() => mcpResultContent({ content: [{ type: 'text', text: 'boom' }], isError: true }), { code: 'MCP_TOOL_ERROR', message: 'boom' });
});

test('connection handshakes, pages tools/list, calls tools and hides ambient secrets', async (t) => {
  process.env.ORBIT_FIXTURE_SECRET_KEY = 'ambient-secret';
  t.after(() => { delete process.env.ORBIT_FIXTURE_SECRET_KEY; });
  const connection = new McpConnection('fixture', fixtureConfig({ env: { FIXTURE_EXPLICIT: 'given' } }));
  t.after(() => connection.close());
  await connection.start(process.cwd());
  assert.equal(connection.status, 'ready');
  assert.deepEqual(connection.tools.map((tool) => tool.name), ['echo', 'fail', 'env', 'grow', 'crash']);
  assert.deepEqual(mcpResultContent(await connection.callTool('echo', { text: '你好' })), { content: 'echo: 你好', structuredContent: { text: '你好' } });
  assert.deepEqual(JSON.parse(mcpResultContent(await connection.callTool('env', {})).content), { secret: null, explicit: 'given' });
  await assert.rejects(connection.callTool('missing', {}), { code: 'MCP_ERROR' });
});

test('requests time out and a crashed server rejects pending calls with its stderr', async (t) => {
  const connection = new McpConnection('fixture', fixtureConfig(), { requestTimeoutMs: 2_000 });
  t.after(() => connection.close());
  await connection.start(process.cwd());
  await assert.rejects(connection.callTool('hang', {}), { code: 'MCP_TIMEOUT' });
  assert.equal(connection.status, 'ready');
  await assert.rejects(connection.callTool('crash', {}), { code: 'MCP_UNAVAILABLE' });
  assert.equal(connection.status, 'failed');
  assert.match(connection.error, /exited \(3\).*crashing on purpose/s);
  await assert.rejects(connection.callTool('echo', { text: 'x' }), { code: 'MCP_UNAVAILABLE' });

  const missing = new McpConnection('missing', { command: join(tmpdir(), 'orbit-no-such-mcp-binary') });
  await assert.rejects(missing.start(process.cwd()));
  assert.equal(missing.status, 'failed');
});

test('manager registers namespaced tools with approval, follows list_changed and unregisters on failure', async (t) => {
  const dir = await tempDir(t);
  const configPath = join(dir, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: { fx: fixtureConfig({ autoApprove: ['echo'] }), off: { command: 'nope', disabled: true } } }));
  const registry = new ToolRegistry();
  const manager = new McpManager({ registry, configPath, cwd: dir });
  t.after(() => manager.close());
  await manager.start();

  const listed = Object.fromEntries(registry.list().map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(listed).sort(), ['mcp__fx__crash', 'mcp__fx__echo', 'mcp__fx__env', 'mcp__fx__fail', 'mcp__fx__grow']);
  assert.equal(listed.mcp__fx__echo.approval, 'never');
  assert.equal(listed.mcp__fx__fail.approval, 'always');
  assert.match(listed.mcp__fx__echo.description, /^\[MCP:fx\] Echo text back/);
  assert.equal(listed.mcp__fx__echo.inputSchema.required[0], 'text');
  assert.equal(listed.mcp__fx__echo.validationSchema, undefined);

  assert.equal((await registry.execute('mcp__fx__echo', { text: 'hi' }, ctx)).content, 'echo: hi');
  await assert.rejects(registry.execute('mcp__fx__fail', {}, ctx), { code: 'MCP_TOOL_ERROR' });
  // Only the object shape is checked locally; the server owns its schema.
  await assert.rejects(registry.execute('mcp__fx__echo', [] as any, ctx), { code: 'INVALID_TOOL_ARGUMENTS' });
  const described = await registry.describeCall('mcp__fx__fail', { a: 1 }, ctx);
  assert.match(described.summary, /fx \/ fail/);

  await registry.execute('mcp__fx__grow', {}, ctx);
  await until(() => registry.list().some((tool) => tool.name === 'mcp__fx__late'));

  assert.deepEqual(manager.status().servers.map(({ name, status }) => ({ name, status })), [{ name: 'fx', status: 'ready' }]);
  await assert.rejects(registry.execute('mcp__fx__crash', {}, ctx), { code: 'MCP_UNAVAILABLE' });
  assert.equal(registry.list().length, 0);
  assert.equal(manager.status().servers[0].status, 'failed');
});

test('a broken config is reported without stopping the manager', async (t) => {
  const dir = await tempDir(t);
  const configPath = join(dir, 'mcp.json');
  await writeFile(configPath, '[]');
  const manager = new McpManager({ registry: new ToolRegistry(), configPath, cwd: dir });
  await manager.start();
  assert.match(manager.status().error, /mcpServers/);
});

test('the web app exposes MCP status and closes servers on shutdown', async (t) => {
  const dir = await tempDir(t);
  const configPath = join(dir, 'mcp.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: { fx: fixtureConfig() } }));
  const provider = { id: 'stub', generate: async () => ({ content: 'ok' }) };
  const { server, runtime } = await createApp({ dataFile: join(dir, 'data', 'state.json'), provider, embeddingProvider: null, workspaceRoot: dir, mcpConfigPath: configPath });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await until(() => runtime.tools.list().some((tool) => tool.name === 'mcp__fx__echo'));

  const status = await (await fetch(`http://127.0.0.1:${port}/api/mcp`)).json();
  assert.equal(status.configPath, configPath);
  assert.equal(status.servers[0].status, 'ready');
  assert.ok(status.servers[0].tools.includes('mcp__fx__echo'));
  const tools = await (await fetch(`http://127.0.0.1:${port}/api/tools`)).json();
  assert.ok(tools.tools.some((tool) => tool.name === 'mcp__fx__echo' && tool.approval === 'always'));

  await new Promise((resolve) => server.close(resolve));
  await runtime.mcp.close();
  assert.equal(runtime.mcp.status().servers[0].status, 'closed');
  assert.equal(runtime.tools.list().some((tool) => tool.name.startsWith('mcp__')), false);
});
