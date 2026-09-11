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
  CONTEXT_COMPACTED: 'context.compacted',
  KNOWLEDGE_RETRIEVED: 'knowledge.retrieved',
  PLAN_CREATED: 'plan.created',
  PLAN_UPDATED: 'plan.updated',
  PLAN_STEP_STARTED: 'plan.step.started',
  PLAN_STEP_COMPLETED: 'plan.step.completed',
  PLAN_STEP_FAILED: 'plan.step.failed',
  PLAN_REVIEWED: 'plan.reviewed',
  PLAN_REPLANNED: 'plan.replanned',
  PLAN_COMPLETED: 'plan.completed',
  SKILLS_SELECTED: 'skills.selected',
  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',
  AGENT_STEP_STARTED: 'agent.step.started',
  AGENT_STEP_COMPLETED: 'agent.step.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  PROVIDER_FALLBACK: 'provider.fallback',
  AGENT_DELEGATED: 'agent.delegated',
  AGENT_RETURNED: 'agent.returned',
  DISCUSSION_ROUND_STARTED: 'discussion.round.started',
  DISCUSSION_ROUND_COMPLETED: 'discussion.round.completed',
  TOOL_CALLED: 'tool.called',
  EXECUTION_COMPLETED: 'execution.completed',
});

export const STRATEGY = Object.freeze({
  SERIAL: 'serial',
  PARALLEL: 'parallel',
  DISCUSS: 'discuss',
  PLAN: 'plan',
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
  archived?: boolean;
  summary?: ConversationSummary;
  messages?: Message[];
}

export interface ConversationSummary {
  text: string;
  throughSequence: number;
  messageCount: number;
  method: 'extractive-v1';
  updatedAt: string;
}

export interface Citation {
  id: string;
  text: string;
  source: string;
  title?: string;
  documentId?: string;
  chunkId?: string;
  startLine?: number;
  endLine?: number;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  threadId?: string;
  content: string;
  contentHash: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface KnowledgeHit extends KnowledgeChunk {
  title: string;
  source: string;
  score: number;
  citation: Citation;
}

export interface PlanStep {
  id: string;
  title: string;
  owner: string;
  dependsOn: string[];
  acceptance: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  messageId?: string;
  result?: string;
}

export interface PlanReview {
  verdict: 'pass' | 'revise' | 'blocked';
  feedback: string;
  reviewerId: string;
  messageId: string;
  createdAt: string;
}

export interface PlanRevision {
  revision: number;
  reason: string;
  steps: PlanStep[];
  plannerMessageId?: string;
  review?: PlanReview;
  createdAt: string;
}

export interface ExecutionPlan {
  id: string;
  threadId: string;
  requestMessageId: string;
  goal: string;
  participants: string[];
  plannerId: string;
  reviewerId: string;
  status: 'planning' | 'running' | 'reviewing' | 'replanning' | 'completed' | 'blocked' | 'interrupted';
  revisions: PlanRevision[];
  replanCount: number;
  stepRunCount: number;
  outcome: string;
  createdAt: string;
  updatedAt: string;
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
  /** Provider protocol state; retained within a run, never published to the UI. */
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  citations?: unknown[];
  provider?: string;
  model?: string;
  usage?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  capability?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Model/tool exchanges belong to a single run, separate from thread history. */
export type AgentTurnMessage =
  | { role: 'assistant'; content: string; toolCalls: ToolCall[]; reasoningContent?: string }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ProviderInput {
  agent: Agent;
  content: string;
  context: ProviderContext;
  tools?: ToolDefinition[];
  transcript?: AgentTurnMessage[];
}

export interface ProviderContext {
  recentMessages: Message[];
  memories: Memory[];
  citations: unknown[];
  skills?: Array<{ id: string; name: string; content: string }>;
  summary?: ConversationSummary;
  knowledge?: KnowledgeHit[];
  supportingSources?: Citation[];
  contextChars?: number;
  workflow?: { kind: 'planning' | 'review'; goal: string; participants: string[]; revision: number };
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
