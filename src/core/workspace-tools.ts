import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath } from './workspace-policy.ts';
import type { ToolRegistry } from './tools.ts';

export const WORKSPACE_TOOL_LIMITS = Object.freeze({
  fileBytes: 200_000, previewChars: 3_500, outputBytes: 32_000,
  shellTimeoutMs: 60_000, shellMaxTimeoutMs: 600_000, commandChars: 4_000,
});

function toolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'unlink', 'shred', 'srm', 'rimraf', 'remove-item', 'ri', 'truncate']);
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'env', 'nohup', 'time', 'xargs', 'call', 'start', 'cmd', 'cmd.exe', '/c', '/k', '/d', '/s',
  'powershell', 'powershell.exe', 'pwsh', '-command', '-c', '-noprofile', 'busybox', 'bash', 'sh', 'zsh']);
// Deletion through scripting-language one-liners and .NET APIs.
const DELETE_APIS = /(::Delete\s*\(|\.Delete\s*\(|os\.(remove|unlink|rmdir)\b|shutil\.rmtree|\bfs\.(rm|rmdir|unlink)(Sync)?\b|\b(rm|rmdir|unlink)Sync\b|Remove-Item\b)/i;

/**
 * Defense in depth for "agents never delete files": rejects commands whose any
 * segment runs a deletion command. Human approval remains the final gate.
 */
export function deletionReason(command: string): string | null {
  if (DELETE_APIS.test(command)) return 'script deletion API';
  for (const segment of command.split(/&&|\|\||[;&|\n\r`]|\$\(/)) {
    const words = segment.trim().replace(/^[({\s@]+/, '').split(/\s+/).filter(Boolean).map((word) => word.replace(/^["']|["']$/g, ''));
    let index = 0;
    while (index < words.length && (/^\w+=/.test(words[index]) || COMMAND_PREFIXES.has(words[index].toLowerCase()))) index += 1;
    const head = (words[index] ?? '').toLowerCase().split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/, '');
    const rest = words.slice(index + 1).map((word) => word.toLowerCase());
    if (DELETE_COMMANDS.has(head)) return head;
    if (head === 'git') {
      const [sub] = rest;
      if (sub === 'clean' || sub === 'rm' || sub === 'restore') return `git ${sub}`;
      if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard';
      if (sub === 'checkout' && (rest.includes('--') || rest.includes('.'))) return 'git checkout (discards files)';
      if (sub === 'stash' && (rest.includes('drop') || rest.includes('clear'))) return `git stash ${rest[1]}`;
    }
    if (head === 'find' && rest.includes('-delete')) return 'find -delete';
  }
  return null;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i;

export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name) && !/^(ANTHROPIC|OPENAI)_/i.test(name)));
}

/** Compact line diff: unchanged head and tail are elided, the changed middle is shown. */
export function linePreview(before: string | null, after: string): string {
  if (before === null) return `新建文件（${Buffer.byteLength(after)} 字节）\n${after.slice(0, WORKSPACE_TOOL_LIMITS.previewChars)}`;
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const lines = [`覆盖文件（${Buffer.byteLength(before)} → ${Buffer.byteLength(after)} 字节，自第 ${start + 1} 行起变化）`,
    ...a.slice(start, endA).map((line) => `- ${line}`), ...b.slice(start, endB).map((line) => `+ ${line}`)];
  const text = lines.join('\n');
  return text.length > WORKSPACE_TOOL_LIMITS.previewChars ? `${text.slice(0, WORKSPACE_TOOL_LIMITS.previewChars)}\n…（预览已截断）` : text;
}

async function readText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw toolError('WORKSPACE_PATH_DENIED', 'target is not a regular file');
    if (info.size > WORKSPACE_TOOL_LIMITS.fileBytes) throw toolError('FILE_TOO_LARGE', `file exceeds ${WORKSPACE_TOOL_LIMITS.fileBytes} bytes`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
  else { try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ } }
}

function tail() {
  let buffer = Buffer.alloc(0);
  let truncated = false;
  return {
    push(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > WORKSPACE_TOOL_LIMITS.outputBytes) { buffer = buffer.subarray(buffer.length - WORKSPACE_TOOL_LIMITS.outputBytes); truncated = true; }
    },
    text: () => (truncated ? '…（仅保留末尾输出）\n' : '') + buffer.toString('utf8'),
  };
}

export async function runShell(command: string, { cwd, timeoutMs, shell = process.env.ORBIT_SHELL?.trim() }: { cwd: string; timeoutMs: number; shell?: string }) {
  const [file, args, extra] = shell
    ? [shell, ['-c', command], {}]
    : process.platform === 'win32'
      // UTF-8 code page so non-ASCII output is not garbled on localized Windows.
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], { windowsVerbatimArguments: true }]
      : ['/bin/sh', ['-c', command], {}];
  const startedAt = Date.now();
  const stdout = tail();
  const stderr = tail();
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>((resolveRun, reject) => {
    const child = spawn(file as string, args as string[], { cwd, env: sanitizedEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(toolError('SHELL_START_FAILED', String(error.message))); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

/**
 * Side-effecting workspace tools. Every call needs human approval; none can
 * delete, move or rename files. Overwritten files are backed up first.
 */
export function registerWorkspaceWriteTools(registry: ToolRegistry, { workspaceRoot, backupDir, protectedDirs = [] }: { workspaceRoot: string; backupDir: string; protectedDirs?: string[] }): ToolRegistry {
  const target = (path: string) => resolveWorkspacePath(workspaceRoot, path, { write: true, protectedDirs: [...protectedDirs, backupDir] });
  const display = (path: string) => relative(resolve(workspaceRoot), path) || '.';
  const backup = async (path: string) => {
    const destination = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`, display(path));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
    return destination;
  };
  // Write to a sibling temp file, then rename, so a crash never leaves a half-written file.
  const atomicWrite = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.orbit-${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  };
  const edited = async ({ path, oldText, newText }: { path: string; oldText: string; newText: string }) => {
    const filePath = await target(path);
    const before = await readText(filePath);
    if (before === null) throw toolError('FILE_NOT_FOUND', `${path} does not exist`);
    const count = before.split(oldText).length - 1;
    if (count !== 1) throw toolError('EDIT_NOT_UNIQUE', `oldText must appear exactly once in ${path}; found ${count}`);
    return { filePath, before, after: before.replace(oldText, () => newText) };
  };

  return registry
    .register({
      name: 'workspace_write',
      description: 'Create or overwrite a UTF-8 text file inside the workspace. Requires human approval. The previous content is backed up. Cannot delete files.',
      capability: 'workspace.write',
      approval: 'always',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1000 }, content: { type: 'string', maxLength: WORKSPACE_TOOL_LIMITS.fileBytes } }, required: ['path', 'content'], additionalProperties: false },
      describe: async ({ path, content }) => {
        const filePath = await target(path);
        return { summary: `写入 ${display(filePath)}`, preview: linePreview(await readText(filePath), content) };
      },
      execute: async ({ path, content }) => {
        if (Buffer.byteLength(content) > WORKSPACE_TOOL_LIMITS.fileBytes) throw toolError('FILE_TOO_LARGE', `content exceeds ${WORKSPACE_TOOL_LIMITS.fileBytes} bytes`);
        const filePath = await target(path);
        const before = await readText(filePath);
        const backupPath = before === null ? null : await backup(filePath);
        await atomicWrite(filePath, content);
        return { path: display(filePath), created: before === null, bytes: Buffer.byteLength(content), ...(backupPath ? { backup: backupPath } : {}) };
      },
    })
    .register({
      name: 'workspace_edit',
      description: 'Replace one exact, unique occurrence of oldText with newText in a workspace text file. Requires human approval. The previous content is backed up.',
      capability: 'workspace.write',
      approval: 'always',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1000 }, oldText: { type: 'string', minLength: 1, maxLength: 50_000 }, newText: { type: 'string', maxLength: 50_000 } }, required: ['path', 'oldText', 'newText'], additionalProperties: false },
      describe: async (input) => {
        const { filePath, before, after } = await edited(input);
        return { summary: `编辑 ${display(filePath)}`, preview: linePreview(before, after) };
      },
      execute: async (input) => {
        const { filePath, after } = await edited(input);
        const backupPath = await backup(filePath);
        await atomicWrite(filePath, after);
        return { path: display(filePath), bytes: Buffer.byteLength(after), backup: backupPath };
      },
    })
    .register({
      name: 'shell_exec',
      description: 'Run a shell command inside the workspace (cmd.exe on Windows unless ORBIT_SHELL is set). Requires human approval. Commands that delete files are rejected. Secrets are removed from the environment. Returns exit code and the tail of stdout/stderr.',
      capability: 'workspace.execute',
      approval: 'always',
      inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: WORKSPACE_TOOL_LIMITS.commandChars }, cwd: { type: 'string', maxLength: 1000 }, timeoutMs: { type: 'integer', minimum: 1_000, maximum: WORKSPACE_TOOL_LIMITS.shellMaxTimeoutMs } }, required: ['command'], additionalProperties: false },
      describe: async ({ command, cwd = '.', timeoutMs = WORKSPACE_TOOL_LIMITS.shellTimeoutMs }) => {
        const reason = deletionReason(command);
        if (reason) throw toolError('DELETE_BLOCKED', `删除类命令被禁止（${reason}）。Agent 不能删除文件。`);
        const directory = await resolveWorkspacePath(workspaceRoot, cwd);
        return { summary: `在 ${display(directory)} 执行命令（超时 ${Math.round(timeoutMs / 1000)} 秒）`, preview: command };
      },
      execute: async ({ command, cwd = '.', timeoutMs = WORKSPACE_TOOL_LIMITS.shellTimeoutMs }) => {
        const reason = deletionReason(command);
        if (reason) throw toolError('DELETE_BLOCKED', `删除类命令被禁止（${reason}）。Agent 不能删除文件。`);
        const directory = await resolveWorkspacePath(workspaceRoot, cwd);
        if (!(await stat(directory)).isDirectory()) throw toolError('WORKSPACE_PATH_DENIED', 'cwd must be a directory');
        return { command, cwd: display(directory), ...(await runShell(command, { cwd: directory, timeoutMs })) };
      },
    });
}
