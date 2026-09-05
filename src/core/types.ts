/**
 * Shared domain vocabulary for Orbit Agent.
 *
 * The upstream project has a very large TypeScript contract package.  This
 * file is the intentionally small boundary used by the distilled runtime:
 * threads, messages, memories, tasks and execution events.
 */

export const ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
});

export const EVENT = Object.freeze({
  MESSAGE_ACCEPTED: 'message.accepted',
  ROUTE_DECIDED: 'route.decided',
  CONTEXT_RETRIEVED: 'context.retrieved',
  SKILLS_SELECTED: 'skills.selected',
  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',
  TOOL_CALLED: 'tool.called',
  EXECUTION_COMPLETED: 'execution.completed',
});

export const STRATEGY = Object.freeze({
  SERIAL: 'serial',
  PARALLEL: 'parallel',
});

export type Role = (typeof ROLE)[keyof typeof ROLE];
export type Strategy = (typeof STRATEGY)[keyof typeof STRATEGY];

export interface Agent {
  id: string;
  name: string;
  role: string;
  emoji?: string;
  color?: string;
  provider?: string;
  description?: string;
  systemPrompt?: string;
  aliases: string[];
  [key: string]: unknown;
}

export interface Thread {
  id: string;
  title: string;
  activeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  metadata: Record<string, unknown>;
  messages?: Message[];
}

export interface Message {
  id: string;
  threadId: string;
  sequence: number;
  role: Role;
  content: string;
  agentId?: string;
  citations: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
  failed?: boolean;
  agentName?: string;
}

export interface Memory {
  id: string;
  text: string;
  source: string;
  threadId?: string;
  importance: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  score?: number;
  citation?: string;
}

export interface Task {
  id: string;
  title: string;
  threadId?: string;
  owner?: string;
  status: 'todo' | 'doing' | 'done';
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEvent {
  id: string;
  sequence: number;
  threadId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProviderResult {
  content: string;
  citations?: unknown[];
  provider?: string;
  model?: string;
  usage?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ProviderContext {
  recentMessages: Message[];
  memories: Memory[];
  citations: unknown[];
  skills?: Array<{ id: string; name: string; content: string }>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new Error(`${field} must be a non-empty string`);
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return value.trim();
}
