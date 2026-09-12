import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { id } from './ids.ts';
import { nowIso, ROLE, asNonEmptyString, clamp, type Agent, type ExecutionEvent, type Memory, type Message, type Role, type Task, type Thread } from './types.ts';
import type { StoragePort } from './contracts.ts';
import { NATIVE_SESSION_ID, type ExecutionPlan, type KnowledgeChunk, type KnowledgeDocument, type NativeAgentSession } from './types.ts';
import { conversationContext } from './conversation.ts';

const SCHEMA_VERSION = 2;
const MAX_EVENTS = 1200;
const MAX_MESSAGES_PER_THREAD = 500;

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface StoreState {
  schemaVersion: number;
  meta: { createdAt: string; updatedAt: string };
  agents: Agent[];
  threads: Thread[];
  messages: Message[];
  memories: Memory[];
  tasks: Task[];
  events: ExecutionEvent[];
  eventSequence: number;
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
  plans: ExecutionPlan[];
}

function emptyState(): StoreState {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { createdAt: now, updatedAt: now },
    agents: [],
    threads: [],
    messages: [],
    memories: [],
    tasks: [],
    events: [],
    eventSequence: 0,
    documents: [],
    chunks: [],
    plans: [],
  };
}

function normalizeState(candidate: unknown): StoreState {
  const base = emptyState();
  if (!candidate || typeof candidate !== 'object') return base;
  const state = {
    ...base,
    ...candidate,
    schemaVersion: SCHEMA_VERSION,
    meta: { ...base.meta, ...(candidate.meta ?? {}) },
  };
  for (const key of ['agents', 'threads', 'messages', 'memories', 'tasks', 'events', 'documents', 'chunks', 'plans']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!Number.isInteger(state.eventSequence) || state.eventSequence < 0) {
    state.eventSequence = state.events.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0);
  }
  return state;
}

/**
 * Small durable store used by the distilled project.
 *
 * Writes are serialized and persisted through a temporary file + rename.  It
 * keeps a “ports first, storage behind an adapter” boundary without requiring
 * Redis or a database server.
 */
export class JsonStore implements StoragePort {
  private filePath: string;
  private seedAgents: Agent[];
  private state: StoreState;
  private writeChain: Promise<unknown>;
  private ready: boolean;

  constructor(filePath: string, { seedAgents = [] }: { seedAgents?: Agent[] } = {}) {
    this.filePath = resolve(filePath);
    this.seedAgents = seedAgents;
    this.state = emptyState();
    this.writeChain = Promise.resolve();
    this.ready = false;
  }

  async init(): Promise<this> {
    if (this.ready) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = emptyState();
    }
    const known = new Set(this.state.agents.map((agent) => agent.id));
    for (const agent of this.seedAgents) {
      if (!known.has(agent.id)) this.state.agents.push(clone(agent));
    }
    let recovered = false;
    for (const plan of this.state.plans) {
      if (['planning', 'running', 'reviewing', 'replanning'].includes(plan.status)) {
        plan.status = 'interrupted';
        plan.outcome = '服务在执行期间重启；结果可能不完整，请检查已保留的步骤后重新规划。';
        plan.updatedAt = nowIso();
        for (const step of plan.revisions.at(-1)?.steps ?? []) {
          if (step.status === 'running') step.status = 'failed';
        }
        recovered = true;
      }
    }
    this.ready = true;
    if (recovered || this.state.agents.length !== known.size || this.state.meta.updatedAt === undefined) {
      await this.persist();
    }
    return this;
  }

  snapshot(): StoreState {
    return clone(this.state);
  }

  async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, 'utf8');
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      // Windows can reject replacing an existing file while an antivirus
      // scanner has it open.  The direct write is a safe last-resort fallback
      // and the temporary file is cleaned up below.
      try {
        await writeFile(this.filePath, payload, 'utf8');
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
      if (!error) return;
    }
  }

  async mutate<T>(mutator: (state: StoreState) => T): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const result = await mutator(this.state);
      this.state.meta.updatedAt = nowIso();
      await this.persist();
      return clone(result);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  getAgent(agentId: string): Agent | null {
    return this.state.agents.find((agent) => agent.id === agentId) ?? null;
  }

  listAgents(): Agent[] {
    return clone(this.state.agents);
  }

  async saveAgent(agent: Agent): Promise<Agent> {
    const normalized = { ...agent, id: asNonEmptyString(agent.id, 'agent.id') };
    return this.mutate((state) => {
      const index = state.agents.findIndex((item) => item.id === normalized.id);
      if (index >= 0) state.agents[index] = { ...state.agents[index], ...normalized };
      else state.agents.push(normalized);
      return state.agents.find((item) => item.id === normalized.id);
    });
  }

  async createThread({ title, activeAgentId, metadata = {} }: { title?: unknown; activeAgentId?: string | null; metadata?: Record<string, unknown> } = {}): Promise<Thread> {
    const safeTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : '新的协作线程';
    return this.mutate((state) => {
      const thread = {
        id: id('thr'),
        title: safeTitle,
        activeAgentId: activeAgentId ?? state.agents[0]?.id ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        messageCount: 0,
        archived: false,
        metadata: { ...metadata },
      };
      state.threads.unshift(thread);
      return thread;
    });
  }

  getThread(threadId: string): Thread | null {
    const thread = this.state.threads.find((item) => item.id === threadId);
    if (!thread) return null;
    const messages = this.state.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    return { ...clone(thread), messages: clone(messages) };
  }

  listThreads({ query = '', archived = false }: { query?: string; archived?: boolean } = {}): Thread[] {
    const needle = query.trim().toLowerCase();
    return clone(
      this.state.threads.filter((thread) => Boolean(thread.archived) === archived && (!needle
        || thread.title.toLowerCase().includes(needle)
        || this.state.messages.some((message) => message.threadId === thread.id && message.content.toLowerCase().includes(needle))))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    );
  }

  async updateThread(threadId: string, patch: { title?: string; archived?: boolean }): Promise<Thread> {
    if (patch.title === undefined && patch.archived === undefined) throw Object.assign(new Error('provide title or archived'), { code: 'VALIDATION_ERROR' });
    const title = patch.title === undefined ? undefined : asNonEmptyString(patch.title, 'title').slice(0, 120);
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw Object.assign(new Error('archived must be boolean'), { code: 'VALIDATION_ERROR' });
    return this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      if (title !== undefined) thread.title = title;
      if (patch.archived !== undefined) thread.archived = patch.archived;
      thread.updatedAt = nowIso();
      return thread;
    });
  }

  async forkThread(threadId: string, { messageId, title }: { messageId?: string; title?: string } = {}): Promise<Thread> {
    return this.mutate((state) => {
      const source = state.threads.find((item) => item.id === threadId);
      if (!source) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      const history = state.messages.filter((message) => message.threadId === threadId);
      const boundary = messageId ? history.find((message) => message.id === messageId) : history.at(-1);
      if (messageId && !boundary) throw Object.assign(new Error('branch message not found in this thread'), { code: 'NOT_FOUND' });
      const selected = history.filter((message) => message.sequence <= (boundary?.sequence ?? 0));
      const thread: Thread = {
        id: id('thr'), title: title === undefined ? `${source.title} · 分支`.slice(0, 120) : asNonEmptyString(title, 'title').slice(0, 120),
        activeAgentId: [...selected].reverse().find((message) => message.agentId)?.agentId ?? state.agents[0]?.id ?? null,
        createdAt: nowIso(), updatedAt: nowIso(), messageCount: selected.length, archived: false,
        metadata: { parentThreadId: threadId, forkMessageId: boundary?.id ?? null },
        ...(source.summary && source.summary.throughSequence <= (boundary?.sequence ?? 0) ? { summary: clone(source.summary) } : {}),
      };
      state.threads.unshift(thread);
      state.messages.push(...selected.map((message) => ({ ...clone(message), id: id('msg'), threadId: thread.id,
        metadata: { ...clone(message.metadata), originalMessageId: message.id } })));
      return thread;
    });
  }

  async touchThread(threadId: string, patch: Partial<Thread> = {}): Promise<Thread | null> {
    return this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) return null;
      Object.assign(thread, patch, { updatedAt: nowIso() });
      return thread;
    });
  }

  async saveAgentSession(threadId: string, agentId: string, session: NativeAgentSession): Promise<NativeAgentSession> {
    if (!['codex', 'claude-code'].includes(session.provider) || !NATIVE_SESSION_ID.test(session.sessionId) || !/^[a-f0-9]{64}$/.test(session.profile)) {
      throw Object.assign(new Error('invalid native session binding'), { code: 'VALIDATION_ERROR' });
    }
    return this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      if (!state.agents.some((agent) => agent.id === agentId)) throw Object.assign(new Error('agent not found'), { code: 'NOT_FOUND' });
      const saved = { provider: session.provider, sessionId: session.sessionId, profile: session.profile, updatedAt: nowIso() };
      thread.agentSessions ??= {};
      thread.agentSessions[agentId] = saved;
      thread.updatedAt = saved.updatedAt;
      return saved;
    });
  }

  async resetAgentSession(threadId: string, agentId: string): Promise<void> {
    await this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      if (thread.agentSessions) delete thread.agentSessions[agentId];
      thread.updatedAt = nowIso();
    });
  }

  async appendMessage({ threadId, role, content, agentId = null, metadata = {}, citations = [] }: { threadId: string; role: Role; content: string; agentId?: string | null; metadata?: Record<string, unknown>; citations?: unknown[] }): Promise<Message> {
    asNonEmptyString(threadId, 'threadId');
    asNonEmptyString(content, 'content');
    if (!Object.values(ROLE).includes(role)) {
      const error = new Error(`unsupported message role: ${role}`);
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    return this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) {
        const error = new Error(`thread not found: ${threadId}`);
        error.code = 'NOT_FOUND';
        throw error;
      }
      const prior = state.messages.filter((message) => message.threadId === threadId);
      // Check inside the serialized mutation: archiving can win the race
      // between route validation and this queued write.
      if (role === ROLE.USER && thread.archived) throw Object.assign(new Error('thread is archived'), { code: 'CONFLICT' });
      const message = {
        id: id('msg'),
        threadId,
        sequence: (prior.at(-1)?.sequence ?? 0) + 1,
        role,
        content: content.trim().slice(0, 30000),
        ...(agentId ? { agentId } : {}),
        citations: Array.isArray(citations) ? citations.slice(0, 12) : [],
        metadata: { ...metadata },
        createdAt: nowIso(),
      };
      state.messages.push(message);
      thread.messageCount = prior.length + 1;
      thread.updatedAt = message.createdAt;
      // Keep durable state bounded while preserving the latest conversation.
      const threadMessages = state.messages.filter((item) => item.threadId === threadId);
      if (threadMessages.length > MAX_MESSAGES_PER_THREAD) {
        const { summary } = conversationContext({ ...thread, messages: threadMessages });
        if (summary) thread.summary = summary;
        const remove = new Set(threadMessages.slice(0, threadMessages.length - MAX_MESSAGES_PER_THREAD).map((item) => item.id));
        state.messages = state.messages.filter((item) => !remove.has(item.id));
        thread.messageCount = MAX_MESSAGES_PER_THREAD;
      }
      return message;
    });
  }

  async addMemory({ text, source = 'manual', threadId = null, importance = 0.5, tags = [] }: { text: string; source?: string; threadId?: string | null; importance?: number; tags?: string[] }): Promise<Memory> {
    asNonEmptyString(text, 'memory.text');
    return this.mutate((state) => {
      const memory = {
        id: id('mem'),
        text: text.trim().slice(0, 12000),
        source,
        ...(threadId ? { threadId } : {}),
        importance: clamp(Number(importance) || 0.5, 0, 1),
        tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.memories.unshift(memory);
      if (state.memories.length > 1000) state.memories.length = 1000;
      return memory;
    });
  }

  listMemories({ threadId, limit = 50 }: { threadId?: string; limit?: number } = {}): Memory[] {
    const rows = this.state.memories.filter((memory) => !threadId || !memory.threadId || memory.threadId === threadId);
    return clone(rows.slice(0, clamp(Number(limit) || 50, 1, 1000)));
  }

  async createTask({ title, threadId = null, owner = null, status = 'todo' }: { title: string; threadId?: string | null; owner?: string | null; status?: string }): Promise<Task> {
    asNonEmptyString(title, 'task.title');
    return this.mutate((state) => {
      const task = {
        id: id('task'),
        title: title.trim().slice(0, 240),
        ...(threadId ? { threadId } : {}),
        ...(owner ? { owner } : {}),
        status: ['todo', 'doing', 'done'].includes(status) ? status : 'todo',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.tasks.unshift(task);
      return task;
    });
  }

  async updateTask(taskId: string, patch: Partial<Pick<Task, 'title' | 'owner' | 'status'>> = {}): Promise<Task> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        const error = new Error(`task not found: ${taskId}`);
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (patch.status !== undefined) {
        if (!['todo', 'doing', 'done'].includes(patch.status)) {
          const error = new Error('task.status must be todo, doing or done');
          error.code = 'VALIDATION_ERROR';
          throw error;
        }
        task.status = patch.status;
      }
      if (patch.title !== undefined) task.title = asNonEmptyString(patch.title, 'task.title').slice(0, 240);
      if (patch.owner !== undefined) task.owner = patch.owner ? String(patch.owner).slice(0, 80) : null;
      task.updatedAt = nowIso();
      return task;
    });
  }

  listTasks({ threadId, limit = 50 }: { threadId?: string; limit?: number } = {}): Task[] {
    const rows = this.state.tasks.filter((task) => !threadId || !task.threadId || task.threadId === threadId);
    return clone(rows.slice(0, clamp(Number(limit) || 50, 1, 200)));
  }

  async appendEvent({ threadId, type, payload = {} }: { threadId?: string | null; type: string; payload?: Record<string, unknown> }): Promise<ExecutionEvent> {
    return this.mutate((state) => {
      const event = {
        id: id('evt'),
        sequence: ++state.eventSequence,
        threadId: threadId ?? null,
        type: asNonEmptyString(type, 'event.type'),
        payload: clone(payload),
        createdAt: nowIso(),
      };
      state.events.push(event);
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
      return event;
    });
  }

  listEvents({ threadId, after = 0, limit = 200, latest = false }: { threadId?: string; after?: number; limit?: number; latest?: boolean } = {}): ExecutionEvent[] {
    const rows = this.state.events.filter((event) => (!threadId || event.threadId === threadId) && event.sequence > Number(after));
    const count = clamp(Number(limit) || 200, 1, 500);
    return clone(latest ? rows.slice(-count) : rows.slice(0, count));
  }

  listKnowledgeDocuments({ threadId }: { threadId?: string } = {}): KnowledgeDocument[] {
    return clone(this.state.documents.filter((document) => !document.threadId || document.threadId === threadId));
  }

  listKnowledgeChunks(documentIds: string[]): KnowledgeChunk[] {
    const allowed = new Set(documentIds);
    return clone(this.state.chunks.filter((chunk) => allowed.has(chunk.documentId)));
  }

  async saveKnowledgeDocument(document: KnowledgeDocument, chunks: KnowledgeChunk[]): Promise<{ document: KnowledgeDocument; duplicate: boolean }> {
    return this.mutate((state) => {
      if (document.threadId && !state.threads.some((thread) => thread.id === document.threadId)) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      const duplicate = state.documents.find((item) => item.contentHash === document.contentHash && item.threadId === document.threadId);
      if (duplicate) return { document: duplicate, duplicate: true };
      if (state.documents.length >= 100 || state.documents.reduce((sum, item) => sum + item.content.length, document.content.length) > 5_000_000) {
        throw Object.assign(new Error('知识库容量上限为 100 个文档、共 500 万字符，请先移除不再使用的文档。'), { code: 'VALIDATION_ERROR' });
      }
      state.documents.unshift(clone(document));
      state.chunks.push(...clone(chunks));
      return { document, duplicate: false };
    });
  }

  async deleteKnowledgeDocument(documentId: string, { threadId }: { threadId?: string } = {}): Promise<void> {
    await this.mutate((state) => {
      const document = state.documents.find((item) => item.id === documentId && (!item.threadId || item.threadId === threadId));
      if (!document) throw Object.assign(new Error('document not found'), { code: 'NOT_FOUND' });
      state.documents = state.documents.filter((item) => item.id !== documentId);
      state.chunks = state.chunks.filter((item) => item.documentId !== documentId);
    });
  }

  async savePlan(plan: ExecutionPlan): Promise<ExecutionPlan> {
    return this.mutate((state) => {
      if (!state.threads.some((thread) => thread.id === plan.threadId)) throw Object.assign(new Error('thread not found'), { code: 'NOT_FOUND' });
      const index = state.plans.findIndex((item) => item.id === plan.id);
      const saved = { ...clone(plan), updatedAt: nowIso() };
      if (index >= 0) state.plans[index] = saved;
      else {
        if (state.plans.length >= 100) {
          const removable = state.plans.findLastIndex((item) => ['completed', 'blocked', 'interrupted'].includes(item.status));
          if (removable < 0) throw Object.assign(new Error('too many active plans'), { code: 'CONFLICT' });
          state.plans.splice(removable, 1);
        }
        state.plans.unshift(saved);
      }
      return saved;
    });
  }

  listPlans({ threadId }: { threadId?: string } = {}): ExecutionPlan[] {
    return clone(this.state.plans.filter((plan) => !threadId || plan.threadId === threadId));
  }

  getPlan(planId: string): ExecutionPlan | null {
    return clone(this.state.plans.find((plan) => plan.id === planId) ?? null);
  }

  stats(): Record<string, number> {
    return {
      agents: this.state.agents.length,
      threads: this.state.threads.length,
      messages: this.state.messages.length,
      memories: this.state.memories.length,
      tasks: this.state.tasks.filter((task) => task.status !== 'done').length,
      events: this.state.events.length,
      documents: this.state.documents.length,
      chunks: this.state.chunks.length,
      plans: this.state.plans.length,
    };
  }
}
