import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolveCommand } from './cli-provider.ts';
import { sanitizedEnv } from './workspace-tools.ts';
import type { ToolRegistry } from './tools.ts';

export const MCP_LIMITS = Object.freeze({ requestTimeoutMs: 60_000, stderrChars: 4_000, descriptionChars: 1_024, toolNameChars: 64, listPages: 20 });
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  autoApprove?: string[];
  disabled?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function mcpError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Claude Desktop compatible `{ "mcpServers": { name: config } }`; a missing file means no servers. */
export async function loadMcpConfig(path: string): Promise<Record<string, McpServerConfig>> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw mcpError('MCP_CONFIG_INVALID', `${path} is not valid JSON`); }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw mcpError('MCP_CONFIG_INVALID', `${path} needs an "mcpServers" object`);
  for (const [name, config] of Object.entries(servers) as Array<[string, any]>) {
    if (!config || typeof config.command !== 'string' || !config.command.trim()) throw mcpError('MCP_CONFIG_INVALID', `MCP server "${name}" needs a command`);
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) throw mcpError('MCP_CONFIG_INVALID', `MCP server "${name}" args must be strings`);
  }
  return servers;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MCP_LIMITS.toolNameChars);
}

/** Text for the model; binary content is described rather than inlined. */
export function mcpResultContent(result: any): { content: string; structuredContent?: unknown } {
  const text = (Array.isArray(result?.content) ? result.content : []).map((block: any) => {
    if (block?.type === 'text') return String(block.text ?? '');
    if (block?.type === 'resource') return typeof block.resource?.text === 'string' ? block.resource.text : `[resource ${block.resource?.uri ?? ''}]`;
    if (block?.type === 'resource_link') return `[resource link ${block.uri ?? ''}]`;
    return `[${block?.type ?? 'unknown'} content omitted]`;
  }).join('\n');
  if (result?.isError) throw mcpError('MCP_TOOL_ERROR', text || 'MCP tool reported an error');
  return { content: text, ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
}

/** One stdio MCP server: newline-delimited JSON-RPC 2.0 over a child process started without a shell. */
export class McpConnection {
  readonly name: string;
  status: 'idle' | 'connecting' | 'ready' | 'failed' | 'closed' = 'idle';
  error: string | null = null;
  tools: McpToolInfo[] = [];
  private config: McpServerConfig;
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private stderr = '';
  private requestTimeoutMs: number;
  private onChange: () => void;

  constructor(name: string, config: McpServerConfig, { requestTimeoutMs = MCP_LIMITS.requestTimeoutMs, onChange = () => {} }: { requestTimeoutMs?: number; onChange?: () => void } = {}) {
    this.name = name;
    this.config = config;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onChange = onChange;
  }

  async start(defaultCwd: string): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'connecting';
    // Ambient secrets stay with Orbit; servers get credentials only through their explicit env.
    const env = { ...sanitizedEnv(), ...(this.config.env ?? {}) };
    let child: ChildProcessWithoutNullStreams;
    try {
      const resolved = await resolveCommand(this.config.command, env);
      if ((this.status as string) === 'closed') return;
      child = spawn(resolved.command, [...resolved.prefixArgs, ...(this.config.args ?? [])], {
        cwd: this.config.cwd ?? defaultCwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.fail(`failed to start: ${error?.message ?? error}`);
      throw error;
    }
    this.child = child;
    // Writes to a dead server surface as EPIPE here; the exit handler reports the failure.
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-MCP_LIMITS.stderrChars); });
    child.on('error', (error) => this.fail(`failed to start: ${error.message}`));
    child.on('exit', (code, signal) => this.fail(`exited (${signal ?? code})${this.stderr.trim() ? ': ' + this.stderr.trim().slice(-500) : ''}`));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
    try {
      await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'orbit-agent', version: '0.3.0' } });
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.refreshTools();
      this.status = 'ready';
      this.onChange();
    } catch (error) {
      this.fail(String(error?.message ?? error));
      // A server that never finished the handshake must not linger.
      void this.terminate();
      throw error;
    }
  }

  async refreshTools(): Promise<void> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.listPages; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []).filter((tool: any) => typeof tool?.name === 'string' && tool.name));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    this.tools = tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.status !== 'ready') throw mcpError('MCP_UNAVAILABLE', `MCP server ${this.name} is ${this.status}${this.error ? ': ' + this.error : ''}`);
    return this.request('tools/call', { name, arguments: args });
  }

  close(): Promise<void> {
    if (this.status !== 'closed') {
      this.status = 'closed';
      this.rejectAll(mcpError('MCP_UNAVAILABLE', `MCP server ${this.name} was closed`));
    }
    return this.terminate();
  }

  /** Kills the process tree and resolves once the direct child has exited. */
  private terminate(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    // Launchers such as npx or uvx spawn the real server as a grandchild.
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else child.kill();
    return exited;
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(mcpError('MCP_TIMEOUT', `MCP ${this.name} ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(mcpError('MCP_ERROR', `MCP ${this.name}: ${message.error.message ?? 'request failed'}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'notifications/tools/list_changed') {
      void this.refreshTools().then(() => this.onChange(), () => undefined);
      return;
    }
    // Server-to-client requests: answer pings; this client offers no sampling, roots or elicitation.
    if (message.id !== undefined && message.method) {
      if (message.method === 'ping') this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not supported: ${message.method}` } });
    }
  }

  private fail(reason: string): void {
    if (this.status === 'closed' || this.status === 'failed') return;
    this.status = 'failed';
    this.error = reason.slice(0, 1_000);
    this.rejectAll(mcpError('MCP_UNAVAILABLE', `MCP server ${this.name} ${this.error}`));
    this.onChange();
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}

/** Connects configured servers in the background and mirrors their tools into the registry. */
export class McpManager {
  private registry: ToolRegistry;
  private configPath: string;
  private cwd: string;
  private requestTimeoutMs?: number;
  private connections = new Map<string, McpConnection>();
  private registered = new Map<string, string[]>();
  private configError: string | null = null;
  private closed = false;

  constructor({ registry, configPath, cwd, requestTimeoutMs }: { registry: ToolRegistry; configPath: string; cwd: string; requestTimeoutMs?: number }) {
    this.registry = registry;
    this.configPath = configPath;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async start(): Promise<void> {
    let servers: Record<string, McpServerConfig>;
    try { servers = await loadMcpConfig(this.configPath); } catch (error) {
      this.configError = String(error?.message ?? error);
      return;
    }
    if (this.closed) return;
    await Promise.all(Object.entries(servers).filter(([, config]) => !config.disabled).map(async ([name, config]) => {
      const connection = new McpConnection(name, config, { ...(this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {}), onChange: () => this.sync(connection, config) });
      this.connections.set(name, connection);
      await connection.start(this.cwd).catch(() => undefined);
    }));
  }

  status() {
    return {
      configPath: this.configPath,
      ...(this.configError ? { error: this.configError } : {}),
      servers: [...this.connections.values()].map((connection) => ({
        name: connection.name, status: connection.status, error: connection.error,
        tools: connection.status === 'ready' ? connection.tools.map((tool) => mcpToolName(connection.name, tool.name)) : [],
      })),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const name of this.connections.keys()) this.unregister(name);
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
  }

  private unregister(server: string): void {
    for (const toolName of this.registered.get(server) ?? []) this.registry.unregister(toolName);
    this.registered.delete(server);
  }

  /** Re-registers a server's tools whenever it connects, changes its list or fails. */
  private sync(connection: McpConnection, config: McpServerConfig): void {
    this.unregister(connection.name);
    if (connection.status !== 'ready') return;
    const autoApprove = new Set(config.autoApprove ?? []);
    const names: string[] = [];
    for (const tool of connection.tools) {
      const name = mcpToolName(connection.name, tool.name);
      if (names.includes(name) || this.registry.list().some((existing) => existing.name === name)) continue;
      const schema = tool.inputSchema && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
      this.registry.register({
        name,
        description: `[MCP:${connection.name}] ${tool.description ?? tool.name}`.slice(0, MCP_LIMITS.descriptionChars),
        capability: 'mcp',
        approval: autoApprove.has(tool.name) ? 'never' : 'always',
        inputSchema: schema,
        validationSchema: { type: 'object' },
        describe: async (input) => ({ summary: `调用 MCP 工具 ${connection.name} / ${tool.name}`, preview: JSON.stringify(input, null, 2) }),
        execute: async (input) => mcpResultContent(await connection.callTool(tool.name, input)),
      });
      names.push(name);
    }
    this.registered.set(connection.name, names);
  }
}
