import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createDefaultTools, ToolRegistry } from './core/tools.ts';
import { MemoryService } from './core/memory.ts';
import { JsonStore } from './core/store.ts';
import { SkillRegistry } from './core/skills.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
}

function reply(id: string | number | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id: string | number | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

export function createMcpHandler(tools: ToolRegistry, skills?: SkillRegistry) {
  return async (request: JsonRpcRequest): Promise<void> => {
    const id = request.id;
    try {
      if (request.method === 'initialize') {
        reply(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'orbit-agent', version: '0.2.0' },
        });
        return;
      }
      if (request.method === 'notifications/initialized') return;
      if (request.method === 'tools/list') {
        reply(id, { tools: tools.list() });
        return;
      }
      if (request.method === 'resources/list') {
        reply(id, { resources: (skills?.list() ?? []).map((skill) => ({
          uri: `skill://${skill.id}`,
          name: skill.name,
          description: skill.description,
          mimeType: 'text/markdown',
        })) });
        return;
      }
      if (request.method === 'resources/read') {
        const uri = String(request.params?.uri ?? '');
        const skill = uri.startsWith('skill://') ? skills?.get(uri.slice('skill://'.length)) : null;
        if (!skill) throw new Error(`resource not found: ${uri}`);
        reply(id, { contents: [{ uri, mimeType: 'text/markdown', text: skill.content }] });
        return;
      }
      if (request.method === 'tools/call') {
        const name = String(request.params?.name ?? '');
        const result = await tools.execute(name, request.params?.arguments ?? {}, {
          threadId: String(request.params?.threadId ?? 'mcp'),
          agentId: 'mcp',
        });
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        return;
      }
      error(id, -32601, `method not found: ${request.method ?? ''}`);
    } catch (cause) {
      error(id, -32000, String(cause?.message ?? cause));
    }
  };
}

export async function startMcpServer(): Promise<void> {
  const store = new JsonStore(fileURLToPath(new URL('../data/mcp-state.json', import.meta.url)));
  await store.init();
  const memory = new MemoryService(store);
  const tools = createDefaultTools({ memory, store, workspaceRoot: process.cwd() });
  const skills = await new SkillRegistry().loadDirectory(fileURLToPath(new URL('../skills/', import.meta.url)));
  const handle = createMcpHandler(tools, skills);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      await handle(JSON.parse(line));
    } catch {
      error(undefined, -32700, 'invalid JSON');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startMcpServer().catch((cause) => {
    console.error(cause);
    process.exitCode = 1;
  });
}
