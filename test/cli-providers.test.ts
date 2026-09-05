import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CliProvider, CliProviderError, ClaudeCodeCliProvider, CodexCliProvider, PiCliProvider } from '../src/core/cli-provider.ts';
import { createProviderRegistryFromEnv } from '../src/core/providers.ts';

const agent = { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] };
const context = { recentMessages: [], memories: [], citations: [] };

function nodeProvider(script: string, options: Record<string, unknown> = {}) {
  return new CliProvider({
    id: 'fixture-cli',
    command: process.execPath,
    args: ['-e', script],
    outputFormat: 'json',
    ...options,
  });
}

test('CLI adapter sends a composed prompt over stdin and parses JSON', async () => {
  const provider = nodeProvider("let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({result:s.includes('User request')?'ok':'bad'})))", { promptMode: 'stdin' });
  const result = await provider.complete({ agent, content: 'hello', context });
  assert.equal(result.content, 'ok');
  assert.equal(result.provider, 'fixture-cli');
});

test('Codex adapter parses agent_message from JSONL', async () => {
  const output = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } });
  const provider = new CodexCliProvider({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(output)})`] });
  const result = await provider.complete({ agent, content: 'hello', context });
  assert.equal(result.content, 'codex answer');
  assert.equal(result.provider, 'codex');
});

test('Claude Code adapter parses JSON result', async () => {
  const provider = new ClaudeCodeCliProvider({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ result: 'claude answer', session_id: 'session-1' }))})`] });
  const result = await provider.complete({ agent, content: 'hello', context });
  assert.equal(result.content, 'claude answer');
  assert.equal(result.metadata?.sessionId, 'session-1');
});

test('Pi adapter parses JSON content blocks', async () => {
  const payload = JSON.stringify({ message: { content: [{ type: 'text', text: 'pi answer' }] } });
  const provider = new PiCliProvider({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(payload)})`] });
  const result = await provider.complete({ agent, content: 'hello', context });
  assert.equal(result.content, 'pi answer');
});

test('CLI adapter reports non-zero exit and timeout as typed errors', async () => {
  const failed = nodeProvider("process.stderr.write('boom');process.exit(3)");
  await assert.rejects(() => failed.complete({ agent, content: 'x', context }), (error: unknown) => {
    assert.ok(error instanceof CliProviderError);
    assert.equal(error.code, 'CLI_PROVIDER_ERROR');
    assert.match(error.message, /boom/);
    return true;
  });

  const timedOut = nodeProvider('setTimeout(() => {}, 1000)', { timeoutMs: 20 });
  await assert.rejects(() => timedOut.complete({ agent, content: 'x', context }), (error: unknown) => {
    assert.ok(error instanceof CliProviderError);
    assert.equal(error.code, 'CLI_TIMEOUT');
    return true;
  });
});

test('CLI adapter rejects a working directory outside the workspace root', async () => {
  const provider = nodeProvider("process.stdout.write(JSON.stringify({result:'should not run'}))", {
    cwd: resolve(process.cwd(), '..'),
    workspaceRoot: process.cwd(),
  });
  await assert.rejects(() => provider.complete({ agent, content: 'x', context }), (error: unknown) => {
    assert.ok(error instanceof CliProviderError);
    assert.equal(error.code, 'CLI_CWD_OUTSIDE_WORKSPACE');
    return true;
  });
});

test('environment mapping registers Codex, Claude Code and Pi adapters per agent', () => {
  const registry = createProviderRegistryFromEnv({
    PATH: process.env.PATH,
    ORBIT_ATLAS_PROVIDER: 'codex',
    ORBIT_FORGE_PROVIDER: 'claude-code',
    ORBIT_LENS_PROVIDER: 'pi',
    ORBIT_CODEX_COMMAND: process.execPath,
    ORBIT_CLAUDE_COMMAND: process.execPath,
    ORBIT_PI_COMMAND: process.execPath,
  }, [
    { ...agent },
    { id: 'forge', name: 'Forge', role: 'builder', aliases: [] },
    { id: 'lens', name: 'Lens', role: 'reviewer', aliases: [] },
  ]);
  const ids = registry.list().map((item) => item.id);
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('claude-code'));
  assert.ok(ids.includes('pi'));
  assert.ok(ids.includes('atlas'));
  assert.ok(ids.includes('forge'));
  assert.ok(ids.includes('lens'));
});
