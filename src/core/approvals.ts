import { id } from './ids.ts';
import { EVENT, nowIso } from './types.ts';

export interface ApprovalRequest {
  threadId: string;
  runId: string;
  agentId: string;
  tool: string;
  summary: string;
  preview: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  by: 'user' | 'timeout' | 'shutdown';
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export const APPROVAL_LIMITS = Object.freeze({ timeoutMs: 600_000, summaryChars: 500, previewChars: 4_000, reasonChars: 500, resolvedMemory: 500 });

type Emit = (threadId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Holds tool calls that need a human decision. Pending approvals live in
 * memory only: a restart denies them, which is the safe default for side effects.
 * Requests and decisions are persisted as events for the audit trail.
 */
export class ApprovalBroker {
  private pending = new Map<string, { approval: PendingApproval; resolve: (decision: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  private resolved = new Set<string>();
  private emit: Emit;
  private timeoutMs: number;

  constructor({ emit, timeoutMs = APPROVAL_LIMITS.timeoutMs }: { emit: Emit; timeoutMs?: number }) {
    this.emit = emit;
    this.timeoutMs = timeoutMs;
  }

  async request(input: ApprovalRequest): Promise<ApprovalDecision> {
    const createdAt = nowIso();
    const approval: PendingApproval = {
      ...input, id: id('approval'), summary: input.summary.slice(0, APPROVAL_LIMITS.summaryChars), preview: input.preview.slice(0, APPROVAL_LIMITS.previewChars),
      createdAt, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    // Register before publishing so a decision arriving right after the event is never lost.
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => { void this.settle(approval.id, { approved: false, by: 'timeout', reason: '审批已超时，按拒绝处理。' }); }, this.timeoutMs);
      this.pending.set(approval.id, { approval, resolve, timer });
    });
    try {
      await this.emit(input.threadId, EVENT.APPROVAL_REQUESTED, {
        approvalId: approval.id, runId: approval.runId, agentId: approval.agentId, tool: approval.tool,
        summary: approval.summary, preview: approval.preview, expiresAt: approval.expiresAt,
      });
    } catch (error) {
      // Without a durable request nobody can see it; deny rather than wait for the timeout.
      await this.settle(approval.id, { approved: false, by: 'shutdown', reason: '审批请求无法记录。' });
      throw error;
    }
    return decision;
  }

  list(threadId?: string): PendingApproval[] {
    return [...this.pending.values()].map(({ approval }) => approval).filter((approval) => !threadId || approval.threadId === threadId);
  }

  async decide(approvalId: string, { approved, reason }: { approved: boolean; reason?: string }): Promise<PendingApproval> {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      throw Object.assign(new Error(this.resolved.has(approvalId) ? '该审批已处理或已超时。' : 'approval not found'),
        { code: this.resolved.has(approvalId) ? 'CONFLICT' : 'NOT_FOUND' });
    }
    await this.settle(approvalId, { approved, by: 'user', ...(reason ? { reason: String(reason).slice(0, APPROVAL_LIMITS.reasonChars) } : {}) });
    return entry.approval;
  }

  /** Denies everything still waiting, e.g. when the server shuts down. */
  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((approvalId) => this.settle(approvalId, { approved: false, by: 'shutdown', reason: '服务已停止。' })));
  }

  private async settle(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    this.resolved.add(approvalId);
    if (this.resolved.size > APPROVAL_LIMITS.resolvedMemory) this.resolved.delete(this.resolved.values().next().value!);
    entry.resolve(decision);
    await this.emit(entry.approval.threadId, EVENT.APPROVAL_RESOLVED, {
      approvalId, runId: entry.approval.runId, tool: entry.approval.tool, approved: decision.approved, by: decision.by,
      ...(decision.reason ? { reason: decision.reason } : {}),
    }).catch(() => undefined);
  }
}
