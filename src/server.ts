import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { AgentRegistry, DEFAULT_AGENTS } from './core/agent-registry.ts';
import { MemoryService } from './core/memory.ts';
import { Orchestrator, COLLABORATION_LIMITS } from './core/orchestrator.ts';
import { createProviderFromEnv, createProviderRegistryFromEnv, ProviderRegistry } from './core/providers.ts';
import { JsonStore } from './core/store.ts';
import { createDefaultTools } from './core/tools.ts';
import { SkillRegistry } from './core/skills.ts';
import { KnowledgeService, KNOWLEDGE_LIMITS } from './core/knowledge.ts';
import { CONTEXT_LIMITS } from './core/conversation.ts';
import { PLAN_LIMITS } from './core/planner.ts';
import { EVENT } from './core/types.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SRC_DIR, '..');
const PUBLIC_DIR = join(PROJECT_DIR, 'public');
const DOCS_DIR = join(PROJECT_DIR, 'docs');
const SKILLS_DIR = join(PROJECT_DIR, 'skills');
const DEFAULT_PORT = 3030;
const MAX_BODY_BYTES = 1_000_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

function headers(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, headers());
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  const code = error?.code === 'NOT_FOUND' ? 404 : error?.code === 'VALIDATION_ERROR' ? 400 : error?.code === 'CONFLICT' ? 409 : 500;
  sendJson(response, code, { error: { code: error?.code ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) } });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected object');
    return parsed;
  } catch {
    const error = new Error('request body must be valid JSON');
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
}

function pathSegments(pathname) {
  return pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = normalize(join(PUBLIC_DIR, relativePath));
  if (!candidate.startsWith(`${PUBLIC_DIR}${process.platform === 'win32' ? '\\' : '/'}`)) {
    sendJson(response, 400, { error: { code: 'BAD_PATH', message: 'invalid path' } });
    return;
  }
  let filePath = candidate;
  try {
    await access(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    filePath = join(PUBLIC_DIR, 'index.html');
  }
  response.writeHead(200, headers(MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'));
  createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
}

async function serveDoc(response, pathname) {
  const relativePath = pathname.replace(/^\/docs\/+/, '');
  const candidate = normalize(join(DOCS_DIR, relativePath));
  if (!candidate.startsWith(`${DOCS_DIR}${process.platform === 'win32' ? '\\' : '/'}`)) {
    sendJson(response, 400, { error: { code: 'BAD_PATH', message: 'invalid documentation path' } });
    return;
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, headers(MIME_TYPES[extname(candidate).toLowerCase()] ?? 'text/plain; charset=utf-8'));
    createReadStream(candidate).on('error', () => response.destroy()).pipe(response);
  } catch {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'documentation not found' } });
  }
}

function providerStatus(provider) {
  if (provider instanceof ProviderRegistry) {
    return { mode: 'provider-registry', fallback: true, providers: provider.list() };
  }
  return {
    mode: provider?.primary ? 'openai-compatible-with-local-fallback' : 'local-demo',
    fallback: true,
    lastError: provider?.lastError ?? null,
  };
}

export async function createApp({ dataFile = join(PROJECT_DIR, 'data', 'state.json'), provider, providers, workspaceRoot = process.env.ORBIT_WORKSPACE_ROOT || PROJECT_DIR, loopOptions = {} } = {}) {
  const registry = new AgentRegistry(DEFAULT_AGENTS);
  const store = new JsonStore(dataFile, { seedAgents: registry.list() });
  await store.init();
  // Rehydrate user-added identities before composing routes.  The store is
  // the source of truth across restarts; defaults merely bootstrap a fresh
  // install.
  for (const agent of store.listAgents()) registry.register(agent);
  const providerRuntime = providers ?? (provider ? new ProviderRegistry().register('default', provider) : createProviderRegistryFromEnv(process.env, registry.list(), workspaceRoot));
  // A fresh install should have a usable first thread without a setup wizard.
  if (store.listThreads().length === 0) {
    await store.createThread({ title: '欢迎来到 Orbit Agent', activeAgentId: registry.default()?.id });
  }
  const memory = new MemoryService(store);
  const knowledge = new KnowledgeService(store);
  const tools = createDefaultTools({ memory, store, knowledge, workspaceRoot });
  const skills = await new SkillRegistry().loadDirectory(SKILLS_DIR);
  const orchestrator = new Orchestrator({ store, registry, memory, knowledge, provider: providerRuntime, tools, skills,
    loopOptions: { toolsEnabled: process.env.ORBIT_MODEL_TOOLS !== '0', ...loopOptions },
  });

  const runtime = { store, registry, memory, knowledge, tools, skills, provider: providerRuntime, providers: providerRuntime, orchestrator };
  const requireThread = (threadId) => {
    const thread = store.getThread(threadId);
    if (!thread) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
    return thread;
  };

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const pathname = requestUrl.pathname;
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers());
        response.end();
        return;
      }

      if (!pathname.startsWith('/api/')) {
        if (pathname.startsWith('/docs/')) {
          await serveDoc(response, pathname);
          return;
        }
        await serveStatic(request, response, pathname);
        return;
      }

      const parts = pathSegments(pathname);
      const method = request.method ?? 'GET';

      if (method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true, name: 'orbit-agent', version: '0.3.0', now: new Date().toISOString() });
        return;
      }
      if (method === 'GET' && pathname === '/api/bootstrap') {
        sendJson(response, 200, {
          agents: registry.list(),
          threads: store.listThreads(),
          tasks: store.listTasks({ limit: 20 }),
          stats: store.stats(),
          tools: tools.list(),
          skills: skills.list().map(({ content, ...metadata }) => metadata),
          provider: providerStatus(providerRuntime),
          execution: orchestrator.agentLoop.describe(),
          collaboration: COLLABORATION_LIMITS,
          planning: PLAN_LIMITS,
          context: CONTEXT_LIMITS,
          knowledge: { method: 'bm25', limits: KNOWLEDGE_LIMITS },
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/agents') {
        sendJson(response, 200, { agents: registry.list() });
        return;
      }
      if (method === 'POST' && pathname === '/api/agents') {
        const body = await readJson(request);
        const agent = registry.register(body);
        await store.saveAgent(agent);
        sendJson(response, 201, { agent });
        return;
      }
      if (method === 'GET' && pathname === '/api/threads') {
        sendJson(response, 200, { threads: store.listThreads({ query: (requestUrl.searchParams.get('q') ?? '').slice(0, 2000), archived: requestUrl.searchParams.get('archived') === '1' }) });
        return;
      }
      if (method === 'POST' && pathname === '/api/threads') {
        const body = await readJson(request);
        const activeAgentId = body.activeAgentId && registry.get(body.activeAgentId)?.id;
        const thread = await store.createThread({ title: body.title, activeAgentId, metadata: body.metadata });
        sendJson(response, 201, { thread });
        return;
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'threads' && parts.length === 3) {
        const thread = store.getThread(parts[2]);
        if (!thread) {
          const error = new Error('thread not found');
          error.code = 'NOT_FOUND';
          throw error;
        }
        sendJson(response, 200, { thread, busy: orchestrator.activeRuns.has(thread.id) });
        return;
      }
      if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'threads' && parts.length === 3) {
        const body = await readJson(request);
        if (body.archived !== undefined && orchestrator.activeRuns.has(parts[2])) throw Object.assign(new Error('请等待当前执行结束后再归档会话。'), { code: 'CONFLICT' });
        sendJson(response, 200, { thread: await store.updateThread(parts[2], { title: body.title, archived: body.archived }) });
        return;
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'threads' && parts.length === 4 && parts[3] === 'fork') {
        const body = await readJson(request);
        sendJson(response, 201, { thread: await store.forkThread(parts[2], { title: body.title, messageId: body.messageId }) });
        return;
      }
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'threads' && parts[3] === 'agents' && parts[5] === 'session' && parts.length === 6) {
        requireThread(parts[2]);
        const agent = registry.get(parts[4]);
        if (!agent) throw Object.assign(new Error('agent not found'), { code: 'NOT_FOUND' });
        if (orchestrator.activeRuns.has(parts[2])) throw Object.assign(new Error('请等待当前协作结束后再开启新的 CLI 会话。'), { code: 'CONFLICT' });
        await store.resetAgentSession(parts[2], agent.id);
        await orchestrator.emit(parts[2], EVENT.SESSION_RESET, { agentId: agent.id });
        sendJson(response, 200, { reset: true, agentId: agent.id });
        return;
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'threads' && parts[3] === 'plans' && (parts.length === 4 || parts.length === 5)) {
        requireThread(parts[2]);
        if (parts.length === 5) {
          const plan = store.getPlan(parts[4]);
          if (!plan || plan.threadId !== parts[2]) throw Object.assign(new Error('plan not found'), { code: 'NOT_FOUND' });
          sendJson(response, 200, { plan });
        } else sendJson(response, 200, { plans: store.listPlans({ threadId: parts[2] }) });
        return;
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'threads' && parts.length === 4 && parts[3] === 'messages') {
        const body = await readJson(request);
        const result = await orchestrator.submitMessage(parts[2], body.content, {
          clientRequestId: body.clientRequestId,
        });
        sendJson(response, 200, result);
        return;
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'threads' && parts.length === 4 && parts[3] === 'events') {
        const threadId = parts[2];
        if (!store.getThread(threadId)) {
          const error = new Error('thread not found');
          error.code = 'NOT_FOUND';
          throw error;
        }
        const after = Number(request.headers['last-event-id'] ?? requestUrl.searchParams.get('after') ?? 0) || 0;
        if (requestUrl.searchParams.get('stream') !== '1') {
          sendJson(response, 200, { events: store.listEvents({ threadId, after, limit: 500, latest: !requestUrl.searchParams.has('after') }) });
          return;
        }
        response.writeHead(200, {
          ...headers('text/event-stream; charset=utf-8'),
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const writeEvent = (event) => {
          response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const unsubscribe = orchestrator.subscribe(threadId, writeEvent);
        // Subscribe before replaying the durable tail so an event emitted
        // between the read and the subscription cannot disappear. Clients
        // de-duplicate by event id; replay is therefore safe even if a frame
        // crosses the boundary while the connection is being established.
        let cursor = after;
        while (true) {
          const page = store.listEvents({ threadId, after: cursor, limit: 500 });
          for (const event of page) writeEvent(event);
          if (page.length < 500) break;
          cursor = page.at(-1).sequence;
        }
        response.write(`event: ready\ndata: ${JSON.stringify({ threadId, busy: orchestrator.activeRuns.has(threadId) })}\n\n`);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
        request.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      if (parts[0] === 'api' && parts[1] === 'knowledge') {
        const threadId = requestUrl.searchParams.get('threadId') || undefined;
        if (threadId) requireThread(threadId);
        if (method === 'GET' && pathname === '/api/knowledge/search') {
          sendJson(response, 200, { hits: knowledge.search(requestUrl.searchParams.get('q') ?? '', { threadId, limit: Number(requestUrl.searchParams.get('limit')) || 5 }), method: 'bm25' });
          return;
        }
        if (parts[2] === 'documents' && parts.length === 3) {
          if (method === 'GET') { sendJson(response, 200, { documents: knowledge.list({ threadId }) }); return; }
          if (method === 'POST') {
            const body = await readJson(request);
            sendJson(response, 201, await knowledge.importDocument(body));
            return;
          }
        }
        if (parts[2] === 'documents' && parts.length === 4) {
          if (method === 'GET') { sendJson(response, 200, { document: knowledge.getDocument(parts[3], { threadId }) }); return; }
          if (method === 'DELETE') {
            await knowledge.deleteDocument(parts[3], { threadId });
            sendJson(response, 200, { deleted: true });
            return;
          }
        }
      }
      if (method === 'GET' && pathname === '/api/memories') {
        const query = requestUrl.searchParams.get('q');
        const threadId = requestUrl.searchParams.get('threadId') || undefined;
        const memories = query ? memory.search(query, { threadId, limit: 20 }) : store.listMemories({ threadId, limit: 100 });
        sendJson(response, 200, { memories });
        return;
      }
      if (method === 'POST' && pathname === '/api/memories') {
        const body = await readJson(request);
        const memoryRecord = await memory.remember(body.text, {
          source: body.source ?? 'manual',
          threadId: body.threadId ?? null,
          importance: body.importance,
          tags: body.tags,
        });
        sendJson(response, 201, { memory: memoryRecord });
        return;
      }
      if (method === 'GET' && pathname === '/api/tasks') {
        sendJson(response, 200, { tasks: store.listTasks({ threadId: requestUrl.searchParams.get('threadId') || undefined }) });
        return;
      }
      if (method === 'POST' && pathname === '/api/tasks') {
        const body = await readJson(request);
        const task = await store.createTask(body);
        sendJson(response, 201, { task });
        return;
      }
      if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 3) {
        const body = await readJson(request);
        const task = await store.updateTask(parts[2], body);
        sendJson(response, 200, { task });
        return;
      }
      if (method === 'GET' && pathname === '/api/tools') {
        sendJson(response, 200, { tools: tools.list() });
        return;
      }
      if (method === 'GET' && pathname === '/api/providers') {
        sendJson(response, 200, { providers: providerRuntime instanceof ProviderRegistry ? providerRuntime.list() : [{ id: providerRuntime.id ?? 'default', adapter: providerRuntime.constructor.name, default: true }] });
        return;
      }
      if (method === 'GET' && pathname === '/api/skills') {
        sendJson(response, 200, { skills: skills.list().map(({ content, ...metadata }) => metadata) });
        return;
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skills' && parts.length === 3) {
        const skill = skills.get(parts[2]);
        if (!skill) {
          const error = new Error('skill not found');
          error.code = 'NOT_FOUND';
          throw error;
        }
        sendJson(response, 200, { skill });
        return;
      }

      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (error) {
      sendError(response, error);
    }
  });

  return { server, runtime };
}

export async function start({ port = Number(process.env.PORT) || DEFAULT_PORT, ...options } = {}) {
  const app = await createApp(options);
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolveListen);
  });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Orbit Agent running at http://127.0.0.1:${actualPort}`);
  return { ...app, port: actualPort };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
