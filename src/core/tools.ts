import { asNonEmptyString } from './types.ts';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { KnowledgeService } from './knowledge.ts';

function knowledgeToolResult(hit) {
  // The original text lives once, inside its citation, so a few long chunks
  // do not consume the entire tool-result budget through duplicate fields.
  return { chunkId: hit.id, score: hit.score, citation: hit.citation };
}

async function safeWorkspacePath(workspaceRoot: string, requested = '.') {
  const root = await realpath(resolve(workspaceRoot));
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    const error = new Error('workspace path escapes the configured root');
    error.code = 'WORKSPACE_PATH_DENIED';
    throw error;
  }
  const resolved = await realpath(candidate);
  const resolvedRel = relative(root, resolved);
  if (isAbsolute(resolvedRel) || resolvedRel === '..' || resolvedRel.startsWith(`..${sep}`)) {
    throw Object.assign(new Error('workspace link escapes the configured root'), { code: 'WORKSPACE_PATH_DENIED' });
  }
  return resolved;
}

/** Validate the JSON Schema subset used by Orbit's built-in tools. */
export function validateToolInput(schema, value, path = 'arguments') {
  const fail = (reason) => { throw Object.assign(new Error(`${path}: ${reason}`), { code: 'INVALID_TOOL_ARGUMENTS' }); };
  const types = schema.type ? [].concat(schema.type) : [];
  const matches = (type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type;
  if (types.length && !types.some(matches)) fail(`expected ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.includes(value)) fail('value is not allowed');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) fail('string is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('string is too long');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('number is below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('number exceeds maximum');
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.items) value.forEach((item, index) => validateToolInput(schema.items, item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateToolInput(schema.properties[key], value[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`);
    }
  }
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
    validateToolInput(tool.inputSchema ?? { type: 'object' }, input ?? {});
    return tool.execute(input ?? {}, context);
  }
}

export function createDefaultTools({ memory, store, knowledge = new KnowledgeService(store), workspaceRoot = process.cwd() }) {
  return new ToolRegistry()
    .register({
      name: 'search_memory',
      description: '在当前线程和全局记忆中检索；配置 embedding 后默认混合语义与关键词召回。mode 可选 hybrid、vector 或 keyword。',
      readOnly: true,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, mode: { type: 'string', enum: ['hybrid', 'vector', 'keyword'] } }, required: ['query'], additionalProperties: false },
      execute: async ({ query, limit = 5, mode = 'hybrid' } = {}, context = {}) =>
        memory.search(asNonEmptyString(query, 'query'), { threadId: context.threadId, limit, mode }),
    })
    .register({
      name: 'search_knowledge',
      description: 'Search imported documents with semantic + BM25 retrieval when embeddings are configured, otherwise BM25. Optional mode: hybrid (default), vector or keyword. Each result has chunkId, score and citation (id, text, title, source, source lines). Results are bounded to fit the context budget.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 8 }, mode: { type: 'string', enum: ['hybrid', 'vector', 'keyword'] } }, required: ['query'], additionalProperties: false },
      execute: async ({ query, limit = 3, mode = 'hybrid' }, context = {}) => {
        const matches = (await knowledge.search(query, { threadId: context.threadId, limit, mode })).map(knowledgeToolResult);
        const selected = [];
        for (const match of matches) {
          if (selected.length && JSON.stringify([...selected, match]).length > (context.maxResultChars ?? 8000)) break;
          selected.push(match);
        }
        return selected;
      },
    })
    .register({
      name: 'read_knowledge',
      description: 'Read a specific knowledge chunk returned by search_knowledge, with its source citation. Use the chunkId without the knowledge: prefix.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { chunkId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['chunkId'], additionalProperties: false },
      execute: async ({ chunkId }, context = {}) => knowledgeToolResult(knowledge.readChunk(chunkId, { threadId: context.threadId })),
    })
    .register({
      name: 'remember',
      description: '把经过确认的事实写入长期记忆',
      readOnly: false,
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, importance: { type: 'number', minimum: 0, maximum: 1 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['text'], additionalProperties: false },
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
      readOnly: false,
      inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, owner: { type: ['string', 'null'] } }, required: ['title'], additionalProperties: false },
      execute: async ({ title, owner = null } = {}, context = {}) =>
        store.createTask({ title: asNonEmptyString(title, 'title'), owner, threadId: context.threadId }),
    })
    .register({
      name: 'list_tasks',
      description: '列出当前线程的待办任务',
      readOnly: true,
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      execute: async ({ limit = 20 } = {}, context = {}) => store.listTasks({ threadId: context.threadId, limit }),
    })
    .register({
      name: 'workspace_list',
      description: 'List files in the configured workspace without executing them',
      capability: 'workspace.read',
      readOnly: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1000 } }, additionalProperties: false },
      execute: async ({ path = '.' } = {}) => {
        const directory = await safeWorkspacePath(workspaceRoot, path);
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.slice(0, 200).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }));
      },
    })
    .register({
      name: 'workspace_read',
      description: 'Read a text file from the configured workspace with a bounded response',
      capability: 'workspace.read',
      readOnly: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['path'], additionalProperties: false },
      execute: async ({ path } = {}) => {
        const filePath = await safeWorkspacePath(workspaceRoot, asNonEmptyString(path, 'path'));
        const file = await open(filePath, 'r');
        try {
          if (!(await file.stat()).isFile()) throw new Error('workspace_read requires a regular file');
          const buffer = Buffer.alloc(200_001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          return { path: relative(resolve(workspaceRoot), filePath), content: buffer.subarray(0, Math.min(bytesRead, 200_000)).toString('utf8'), truncated: bytesRead > 200_000 };
        } finally { await file.close(); }
      },
    });
}
