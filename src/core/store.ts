import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { id } from './ids.ts';
import { nowIso, ROLE, asNonEmptyString, clamp, type Agent, type ExecutionEvent, type Memory, type Message, type Role, type Task, type Thread } from './types.ts';
import type { StoragePort } from './contracts.ts';

const SCHEMA_VERSION = 1;
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
  for (const key of ['agents', 'threads', 'messages', 'memories', 'tasks', 'events']) {
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
    this.ready = true;
    if (this.state.agents.length !== known.size || this.state.meta.updatedAt === undefined) {
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

  listThreads(): Thread[] {
    return clone(
      [...this.state.threads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    );
  }

  async touchThread(threadId: string, patch: Partial<Thread> = {}): Promise<Thread | null> {
    return this.mutate((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) return null;
      Object.assign(thread, patch, { updatedAt: nowIso() });
      return thread;
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

  listEvents({ threadId, after = 0, limit = 200 }: { threadId?: string; after?: number; limit?: number } = {}): ExecutionEvent[] {
    const rows = this.state.events.filter((event) => (!threadId || event.threadId === threadId) && event.sequence > Number(after));
    return clone(rows.slice(0, clamp(Number(limit) || 200, 1, 500)));
  }

  stats(): Record<string, number> {
    return {
      agents: this.state.agents.length,
      threads: this.state.threads.length,
      messages: this.state.messages.length,
      memories: this.state.memories.length,
      tasks: this.state.tasks.filter((task) => task.status !== 'done').length,
      events: this.state.events.length,
    };
  }
}
