import { asNonEmptyString } from './types.ts';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

function safeWorkspacePath(workspaceRoot: string, requested = '.') {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) {
    const error = new Error('workspace path escapes the configured root');
    error.code = 'WORKSPACE_PATH_DENIED';
    throw error;
  }
  return candidate;
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    const name = asNonEmptyString(tool.name, 'tool.name');
    if (typeof tool.execute !== 'function') throw new TypeError(`tool ${name} needs an execute function`);
    this.tools.set(name, { ...tool, name });
    return this;
  }

  list() {
    return [...this.tools.values()].map(({ execute, ...metadata }) => metadata);
  }

  async execute(name, input, context) {
    const tool = this.tools.get(name);
    if (!tool) {
      const error = new Error(`unknown tool: ${name}`);
      error.code = 'TOOL_NOT_FOUND';
      throw error;
    }
    return tool.execute(input, context);
  }
}

export function createDefaultTools({ memory, store, workspaceRoot = process.cwd() }) {
  return new ToolRegistry()
    .register({
      name: 'search_memory',
      description: '在当前线程和全局记忆中做轻量关键词检索',
      inputSchema: { type: 'object', required: ['query'] },
      execute: async ({ query, limit = 5 } = {}, context = {}) =>
        memory.search(asNonEmptyString(query, 'query'), { threadId: context.threadId, limit }),
    })
    .register({
      name: 'remember',
      description: '把经过确认的事实写入长期记忆',
      inputSchema: { type: 'object', required: ['text'] },
      execute: async ({ text, importance = 0.7, tags = [] } = {}, context = {}) =>
        memory.remember(asNonEmptyString(text, 'text'), {
          threadId: context.threadId,
          importance,
          tags,
          source: context.agentId ? `agent:${context.agentId}` : 'tool',
        }),
    })
    .register({
      name: 'create_task',
      description: '创建一个可追踪的协作任务，不执行任意 shell 命令',
      inputSchema: { type: 'object', required: ['title'] },
      execute: async ({ title, owner = null } = {}, context = {}) =>
        store.createTask({ title: asNonEmptyString(title, 'title'), owner, threadId: context.threadId }),
    })
    .register({
      name: 'list_tasks',
      description: '列出当前线程的待办任务',
      inputSchema: { type: 'object' },
      execute: async ({ limit = 20 } = {}, context = {}) => store.listTasks({ threadId: context.threadId, limit }),
    })
    .register({
      name: 'workspace_list',
      description: 'List files in the configured workspace without executing them',
      capability: 'workspace.read',
      readOnly: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async ({ path = '.' } = {}) => {
        const directory = safeWorkspacePath(workspaceRoot, path);
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.slice(0, 200).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }));
      },
    })
    .register({
      name: 'workspace_read',
      description: 'Read a text file from the configured workspace with a bounded response',
      capability: 'workspace.read',
      readOnly: true,
      inputSchema: { type: 'object', required: ['path'] },
      execute: async ({ path } = {}) => {
        const filePath = safeWorkspacePath(workspaceRoot, asNonEmptyString(path, 'path'));
        const content = await readFile(filePath, 'utf8');
        return { path: relative(resolve(workspaceRoot), filePath), content: content.slice(0, 200_000), truncated: content.length > 200_000 };
      },
    });
}
