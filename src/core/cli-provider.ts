import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Agent, ProviderContext, ProviderResult } from './types.ts';
import type { ProviderAdapter } from './contracts.ts';
import { EVIDENCE_INSTRUCTIONS, formatReferenceContext, referencedCitations } from './context-format.ts';

export type CliOutputFormat = 'text' | 'json' | 'jsonl';
export type CliPromptMode = 'argument' | 'stdin';

export interface CliProviderOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  outputFormat?: CliOutputFormat;
  promptMode?: CliPromptMode;
}

export interface CliInvocation {
  command: string;
  args: string[];
  cwd: string;
  promptMode: CliPromptMode;
}

export interface ParsedCliOutput {
  content: string;
  model?: string;
  sessionId?: string;
  usage?: unknown;
}

export class CliProviderError extends Error {
  readonly code: string;
  readonly provider: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(message: string, options: { code?: string; provider: string; stderr?: string; exitCode?: number | null } ) {
    super(message);
    this.name = 'CliProviderError';
    this.code = options.code ?? 'CLI_PROVIDER_ERROR';
    this.provider = options.provider;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}

function isInside(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  const rel = relative(rootResolved, targetResolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function trimOutput(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8') + '\n[output truncated]';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command without invoking a shell. npm installs CLI shims as
 * .cmd files on Windows; those shims are converted to a direct executable
 * invocation so user-provided prompts never become shell source code.
 */
async function resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<{ command: string; prefixArgs: string[] }> {
  const raw = command.trim();
  if (!raw) throw new CliProviderError('CLI command is empty', { code: 'CLI_NOT_CONFIGURED', provider: 'cli' });
  if (process.platform !== 'win32') return { command: raw, prefixArgs: [] };

  const hasPath = raw.includes('\\') || raw.includes('/');
  const pathEntries = hasPath ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const entry of pathEntries) {
    const base = hasPath ? raw : resolve(entry, raw);
    // npm also installs an extensionless POSIX launcher. On Windows prefer
    // executable and cmd shims, while preserving explicitly named files.
    if (/^\.(exe|cmd|bat)$/i.test(extname(raw))) candidates.push(base);
    else candidates.push(`${base}.exe`, `${base}.cmd`, `${base}.bat`, base);
  }
  let found: string | undefined;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      found = candidate;
      break;
    }
  }
  if (!found) return { command: raw, prefixArgs: [] };
  if (!found.toLowerCase().endsWith('.cmd') && !found.toLowerCase().endsWith('.bat')) {
    return { command: found, prefixArgs: [] };
  }

  const shim = await readFile(found, 'utf8').catch(() => '');
  const scriptMatch = shim.match(/%dp0%[\\/]([^\"\r\n]+?\.(?:js|cjs|mjs))/i) ?? shim.match(/%~dp0([^\"\r\n]+?\.(?:js|cjs|mjs))/i);
  if (!scriptMatch) {
    const nativeMatch = shim.match(/"%dp0%[\\/]([^"\r\n]+?\.exe)"[ \t]*%\*/i)
      ?? shim.match(/"%~dp0([^"\r\n]+?\.exe)"[ \t]*%\*/i);
    if (nativeMatch) {
      return { command: resolve(dirname(found), nativeMatch[1].replace(/\\/g, '/')), prefixArgs: [] };
    }
    throw new CliProviderError(`CLI shim is not a supported Node launcher: ${found}`, { code: 'CLI_UNSUPPORTED_SHIM', provider: 'cli' });
  }
  const scriptPath = resolve(dirname(found), scriptMatch[1].replace(/\\/g, '/'));
  return { command: process.execPath, prefixArgs: [scriptPath] };
}

function composePrompt(agent: Agent, content: string, context: ProviderContext): string {
  const sections = [`You are ${agent.name}, ${agent.role}.`, agent.systemPrompt ? `System instructions:\n${agent.systemPrompt}` : ''];
  sections.push(EVIDENCE_INSTRUCTIONS);
  if (context.skills?.length) {
    sections.push(`Relevant skills:\n${context.skills.map((skill) => `## ${skill.name}\n${skill.content}`).join('\n\n')}`);
  }
  sections.push(formatReferenceContext(context));
  if (context.recentMessages?.length) {
    sections.push(`Recent thread context:\n${context.recentMessages.map((message) => `${message.role}${message.agentId ? '/' + message.agentId : ''}: ${message.content}`).join('\n')}`);
  }
  sections.push(`User request:\n${content}`);
  return sections.filter(Boolean).join('\n\n');
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.output_text === 'string') return record.output_text;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.content === 'string' || Array.isArray(record.content)) return asText(record.content);
  if (record.message && typeof record.message === 'object') return asText(record.message);
  if (record.delta && typeof record.delta === 'object') return asText(record.delta);
  return '';
}

function parseJsonRecords(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
}

function genericParse(raw: string, format: CliOutputFormat): ParsedCliOutput {
  if (format === 'text') return { content: raw.trim() };
  const records = parseJsonRecords(raw);
  const pieces: string[] = [];
  let finalText = '';
  let model: string | undefined;
  let sessionId: string | undefined;
  let usage: unknown;
  for (const item of records) {
    if (typeof item === 'string') { pieces.push(item); continue; }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.model === 'string') model = record.model;
    if (typeof record.session_id === 'string') sessionId = record.session_id;
    if (typeof record.sessionId === 'string') sessionId = record.sessionId;
    if (record.usage !== undefined) usage = record.usage;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'result' || type === 'turn.completed' || typeof record.result === 'string') {
      const candidate = asText(record.result ?? record.output_text ?? record.message ?? record.content);
      if (candidate) finalText = candidate;
      continue;
    }
    const candidate = asText(record.delta ?? record.item ?? record.message ?? record.content ?? record.text ?? record.output_text);
    if (candidate) pieces.push(candidate);
  }
  return { content: (finalText || pieces.join('')).trim(), model, sessionId, usage };
}

function parseCodex(raw: string, format: CliOutputFormat): ParsedCliOutput {
  const parsed = genericParse(raw, format);
  const records = parseJsonRecords(raw);
  const pieces: string[] = [];
  let finalText = '';
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'item.completed' && record.item && typeof record.item === 'object') {
      const inner = record.item as Record<string, unknown>;
      if (inner.type === 'agent_message') {
        const text = asText(inner.text ?? inner.content);
        if (text) finalText = text;
      }
    } else if (record.type === 'response.output_text.delta') {
      const text = asText(record.delta);
      if (text) pieces.push(text);
    }
  }
  return { ...parsed, content: (finalText || pieces.join('') || parsed.content).trim() };
}

function parseClaude(raw: string, format: CliOutputFormat): ParsedCliOutput {
  const parsed = genericParse(raw, format);
  const records = parseJsonRecords(raw);
  const pieces: string[] = [];
  let finalText = '';
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'result' && typeof record.result === 'string') finalText = record.result;
    if (record.type === 'stream_event' && record.event && typeof record.event === 'object') {
      const event = record.event as Record<string, unknown>;
      if (event.type === 'content_block_delta') {
        const text = asText(event.delta);
        if (text) pieces.push(text);
      }
    }
    if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
      const text = asText(record.message);
      if (text) pieces.push(text);
    }
  }
  return { ...parsed, content: (finalText || pieces.join('') || parsed.content).trim() };
}

function parsePi(raw: string, format: CliOutputFormat): ParsedCliOutput {
  return genericParse(raw, format);
}

export class CliProvider implements ProviderAdapter {
  readonly id: string;
  protected readonly options: CliProviderOptions;

  constructor(options: CliProviderOptions) {
    this.id = options.id;
    this.options = { timeoutMs: 120_000, maxOutputBytes: 2_000_000, outputFormat: 'text', promptMode: 'argument', ...options };
  }

  protected buildInvocation(prompt: string): CliInvocation {
    const args = [...(this.options.args ?? [])];
    if (this.options.promptMode === 'stdin') return { command: this.options.command, args, cwd: this.options.cwd ?? process.cwd(), promptMode: 'stdin' };
    args.push(prompt);
    return { command: this.options.command, args, cwd: this.options.cwd ?? process.cwd(), promptMode: 'argument' };
  }

  protected parseOutput(raw: string): ParsedCliOutput {
    return genericParse(raw, this.options.outputFormat ?? 'text');
  }

  async complete({ agent, content, context }: { agent: Agent; content: string; context: ProviderContext }): Promise<ProviderResult> {
    const prompt = composePrompt(agent, content, context);
    const invocation = this.buildInvocation(prompt);
    const workspaceRoot = this.options.workspaceRoot ? resolve(this.options.workspaceRoot) : undefined;
    const cwd = resolve(invocation.cwd);
    if (workspaceRoot && !isInside(workspaceRoot, cwd)) {
      throw new CliProviderError(`CLI cwd must stay inside workspace root: ${cwd}`, { code: 'CLI_CWD_OUTSIDE_WORKSPACE', provider: this.id });
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.options.env ?? {}) };
    const resolved = await resolveCommand(invocation.command, env);
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...invocation.args], {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const { stdout, stderr, exitCode } = await collectChild(child, {
      prompt: invocation.promptMode === 'stdin' ? prompt : undefined,
      timeoutMs: this.options.timeoutMs ?? 120_000,
      maxOutputBytes: this.options.maxOutputBytes ?? 2_000_000,
      provider: this.id,
    });
    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode ?? 'unknown'}`;
      throw new CliProviderError(`${this.id} CLI failed: ${detail}`, { provider: this.id, stderr: stderr.trim(), exitCode });
    }
    const parsed = this.parseOutput(stdout);
    if (!parsed.content) {
      throw new CliProviderError(`${this.id} CLI returned empty output`, { code: 'CLI_EMPTY_OUTPUT', provider: this.id, stderr: stderr.trim(), exitCode });
    }
    return {
      content: parsed.content,
      citations: referencedCitations(parsed.content, context.citations ?? []),
      provider: this.id,
      model: parsed.model ?? this.options.command,
      usage: parsed.usage ?? null,
      metadata: { command: this.options.command, cwd, ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}) },
    };
  }
}

async function collectChild(child: ChildProcessWithoutNullStreams, options: { prompt?: string; timeoutMs: number; maxOutputBytes: number; provider: string }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const append = (current: string, chunk: Buffer | string) => trimOutput(current + chunk.toString(), options.maxOutputBytes);
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolvePromise, reject) => {
    const finish = (fn: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(() => reject(new CliProviderError(`${options.provider} CLI could not start: ${error.message}`, { code: 'CLI_NOT_FOUND', provider: options.provider }))));
    child.once('close', (code) => finish(() => resolvePromise({ stdout, stderr, exitCode: code })));
    timer = setTimeout(() => finish(() => { child.kill(); reject(new CliProviderError(`${options.provider} CLI timed out after ${options.timeoutMs}ms`, { code: 'CLI_TIMEOUT', provider: options.provider, stderr })); }), options.timeoutMs);
    if (options.prompt !== undefined) {
      child.stdin.end(options.prompt);
    } else {
      child.stdin.end();
    }
  });
  return result;
}

export class CodexCliProvider extends CliProvider {
  constructor(options: Partial<CliProviderOptions> = {}) {
    super({ id: 'codex', command: 'codex', args: ['exec', '--json'], outputFormat: 'jsonl', promptMode: 'argument', ...options });
  }
  protected parseOutput(raw: string): ParsedCliOutput { return parseCodex(raw, this.options.outputFormat ?? 'jsonl'); }
}

export class ClaudeCodeCliProvider extends CliProvider {
  constructor(options: Partial<CliProviderOptions> = {}) {
    super({ id: 'claude-code', command: 'claude', args: ['-p', '--output-format', 'json'], outputFormat: 'json', promptMode: 'argument', ...options });
  }
  protected buildInvocation(prompt: string): CliInvocation {
    const args = [...(this.options.args ?? []), prompt];
    return { command: this.options.command, args, cwd: this.options.cwd ?? process.cwd(), promptMode: 'argument' };
  }
  protected parseOutput(raw: string): ParsedCliOutput { return parseClaude(raw, this.options.outputFormat ?? 'json'); }
}

export class PiCliProvider extends CliProvider {
  constructor(options: Partial<CliProviderOptions> = {}) {
    super({ id: 'pi', command: 'pi', args: ['--print', '--mode', 'json'], outputFormat: 'json', promptMode: 'argument', ...options });
  }
  protected parseOutput(raw: string): ParsedCliOutput { return parsePi(raw, this.options.outputFormat ?? 'json'); }
}

export function createCliProvider(name: string, options: Partial<CliProviderOptions> = {}): CliProvider {
  const key = name.trim().toLowerCase();
  if (key === 'codex') return new CodexCliProvider(options);
  if (key === 'claude' || key === 'claude-code' || key === 'claudecode') return new ClaudeCodeCliProvider(options);
  if (key === 'pi') return new PiCliProvider(options);
  throw new Error(`unknown CLI provider: ${name}`);
}

export function defaultCliCwd(): string {
  return process.env.ORBIT_WORKSPACE_ROOT?.trim() || process.cwd();
}
