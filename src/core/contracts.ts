import type { ExecutionEvent, ExecutionPlan, KnowledgeChunk, KnowledgeDocument, Memory, Message, ProviderInput, ProviderResult, Task, Thread } from './types.ts';

/** Small ports that keep provider and storage implementations replaceable. */
export interface ProviderAdapter {
  readonly id?: string;
  complete(input: ProviderInput): Promise<ProviderResult>;
}

export interface StoragePort {
  getThread(threadId: string): Thread | null;
  touchThread(threadId: string, patch?: Partial<Thread>): Promise<Thread | null>;
  appendMessage(input: { threadId: string; role: Message['role']; content: string; agentId?: string | null; metadata?: Record<string, unknown>; citations?: unknown[] }): Promise<Message>;
  listMemories(input?: { threadId?: string; limit?: number }): Memory[];
  addMemory(input: { text: string; source?: string; threadId?: string | null; importance?: number; tags?: string[] }): Promise<Memory>;
  createTask(input: { title: string; threadId?: string | null; owner?: string | null; status?: string }): Promise<Task>;
  appendEvent(input: { threadId?: string | null; type: string; payload?: Record<string, unknown> }): Promise<ExecutionEvent>;
  savePlan(plan: ExecutionPlan): Promise<ExecutionPlan>;
  listKnowledgeDocuments(input?: { threadId?: string }): KnowledgeDocument[];
  listKnowledgeChunks(documentIds: string[]): KnowledgeChunk[];
  saveKnowledgeDocument(document: KnowledgeDocument, chunks: KnowledgeChunk[]): Promise<{ document: KnowledgeDocument; duplicate: boolean }>;
  deleteKnowledgeDocument(documentId: string, input?: { threadId?: string }): Promise<void>;
}

export interface ExecutionContext {
  threadId: string;
  runId: string;
  agentId: string;
  requestId?: string;
}

export interface AuditSink {
  append(event: { type: string; context: ExecutionContext; payload?: Record<string, unknown> }): Promise<ExecutionEvent>;
}
