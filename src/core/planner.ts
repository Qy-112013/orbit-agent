import { id } from './ids.ts';
import { EVENT, nowIso, type ExecutionPlan, type Message, type PlanReview, type PlanStep, type ProviderContext } from './types.ts';
import type { StoragePort } from './contracts.ts';
import type { RouteDecision } from './router.ts';
import { validateToolInput } from './tools.ts';

export const PLAN_LIMITS = Object.freeze({ maxSteps: 5, maxReplans: 2, maxStepRuns: 8, maxStructuredChars: 12_000 });

function parseObject(text: string): Record<string, any> {
  if (text.length > PLAN_LIMITS.maxStructuredChars) throw new Error('structured response exceeds size limit');
  const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  let result;
  try { result = JSON.parse(clean); } catch { throw new Error('response must be a JSON object without additional prose'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('response must be a JSON object');
  return result;
}

export function parsePlan(text: string, participants: string[]): PlanStep[] {
  const result = parseObject(text);
  validateToolInput({ type: 'object', properties: { steps: { type: 'array', maxItems: PLAN_LIMITS.maxSteps, items: {
    type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 32 }, title: { type: 'string', minLength: 1, maxLength: 300 },
      owner: { type: 'string', enum: participants }, dependsOn: { type: 'array', maxItems: PLAN_LIMITS.maxSteps, items: { type: 'string' } },
      acceptance: { type: 'string', minLength: 1, maxLength: 1200 },
    }, required: ['id', 'title', 'owner', 'dependsOn', 'acceptance'], additionalProperties: false,
  } } }, required: ['steps'], additionalProperties: false }, result);
  if (!result.steps.length) throw new Error('plan must have at least one step');
  const seen = new Set<string>();
  return result.steps.map((step) => {
    if (!/^[a-z0-9_-]+$/i.test(step.id) || seen.has(step.id)) throw new Error('step IDs must be unique letters, digits, underscores or hyphens');
    if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some((dependency) => !seen.has(dependency))) {
      throw new Error('dependencies must refer to earlier steps; forward, missing and cyclic dependencies are invalid');
    }
    seen.add(step.id);
    return { ...step, status: 'pending' };
  });
}

export function parseReview(text: string): Pick<PlanReview, 'verdict' | 'feedback'> {
  const result = parseObject(text);
  validateToolInput({ type: 'object', properties: {
    verdict: { type: 'string', enum: ['pass', 'revise', 'blocked'] }, feedback: { type: 'string', minLength: 1, maxLength: 4000 },
  }, required: ['verdict', 'feedback'], additionalProperties: false }, result);
  return { verdict: result.verdict, feedback: result.feedback };
}

function unavailable(message: Message): boolean {
  return message.metadata.status === 'degraded' || message.metadata.provider === 'local';
}
function failed(message: Message): boolean { return Boolean(message.failed) || message.metadata.status === 'error'; }
function detail(error: unknown): string { return String(error instanceof Error ? error.message : error).slice(0, 1500); }

interface PlanInput {
  threadId: string;
  content: string;
  context: ProviderContext;
  route: RouteDecision;
  requestMessageId: string;
  collaboration: { delegations: number; failed: number };
}

/** A bounded plan → execute → review → replan state machine, above AgentLoop. */
export class PlanExecutor {
  private store: Pick<StoragePort, 'savePlan'>;
  private invoke: (input: Record<string, any>) => Promise<Message>;
  private emit: (threadId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;

  constructor({ store, invoke, emit }: { store: Pick<StoragePort, 'savePlan'>;
    invoke: (input: Record<string, any>) => Promise<Message>;
    emit: (threadId: string, type: string, payload: Record<string, unknown>) => Promise<unknown> }) {
    this.store = store;
    this.invoke = invoke;
    this.emit = emit;
  }

  async run(input: PlanInput): Promise<{ plan: ExecutionPlan; messages: Message[] }> {
    const plan: ExecutionPlan = {
      id: id('plan'), threadId: input.threadId, requestMessageId: input.requestMessageId, goal: input.content,
      participants: [...input.route.targets], plannerId: input.route.targets[0], reviewerId: input.route.targets.at(-1)!,
      status: 'planning', revisions: [], replanCount: 0, stepRunCount: 0, outcome: '', createdAt: nowIso(), updatedAt: nowIso(),
    };
    const messages: Message[] = [];
    const evidence: Message[] = [];
    const publish = async (type: string, payload: Record<string, unknown> = {}) => {
      plan.updatedAt = nowIso();
      await this.store.savePlan(plan);
      await this.emit(input.threadId, type, { planId: plan.id, revision: plan.replanCount, status: plan.status, ...payload });
    };
    const invoke = async (agentId: string, phase: string, content: string, stepId?: string) => {
      const workflow = phase === 'planning' || phase === 'plan-review'
        ? { kind: phase === 'planning' ? 'planning' as const : 'review' as const, goal: plan.goal, participants: plan.participants, revision: plan.replanCount }
        : undefined;
      const message = await this.invoke({ ...input, agentId, phase, content, allowDelegation: false, priorResults: evidence,
        planId: plan.id, planRevision: plan.replanCount, planStepId: stepId ?? null,
        context: { ...input.context, ...(workflow ? { workflow } : {}) } });
      messages.push(message);
      return message;
    };
    const finish = async (status: 'completed' | 'blocked', outcome: string) => {
      plan.status = status;
      plan.outcome = outcome.slice(0, 5000);
      for (const step of plan.revisions.at(-1)?.steps ?? []) {
        if (step.status === 'pending') step.status = 'skipped';
        if (step.status === 'running') step.status = 'failed';
      }
      await publish(EVENT.PLAN_COMPLETED, { outcome: plan.outcome, replanCount: plan.replanCount, stepRunCount: plan.stepRunCount });
      return { plan: structuredClone(plan), messages };
    };
    await publish(EVENT.PLAN_CREATED, { plannerId: plan.plannerId, reviewerId: plan.reviewerId });
    let reason = '初始计划';
    try {
      for (let revision = 0; revision <= PLAN_LIMITS.maxReplans; revision += 1) {
        plan.replanCount = revision;
        if (revision > 0) {
          plan.status = 'replanning';
          await publish(EVENT.PLAN_REPLANNED, { reason });
        }
        const current = { revision, reason, steps: [] as PlanStep[], createdAt: nowIso() } as ExecutionPlan['revisions'][number];
        plan.revisions.push(current);
        plan.status = 'planning';
        await publish(EVENT.PLAN_UPDATED);
        const previous = plan.revisions.at(-2);
        const prompt = [
          `为以下目标制定可验证的执行计划：\n${plan.goal}`,
          `只能把步骤分配给这些 Agent：${plan.participants.join(', ')}。最多 ${PLAN_LIMITS.maxSteps} 步；步骤依次执行，依赖只能指向前面的步骤。`,
          '只返回 JSON：{"steps":[{"id":"s1","title":"具体工作","owner":"允许的 Agent ID","dependsOn":[],"acceptance":"可检查的验收标准"}]}。不要添加其他字段或说明。',
          '仅承诺当前工具能完成的工作。需要文件修改或外部操作但没有对应能力时，应说明限制，不要把建议当作已执行。',
          revision ? `根据执行或复核反馈调整步骤：${reason}\n上一版：${JSON.stringify(previous?.steps.map(({ result, ...step }) => ({ ...step, result: result?.slice(0, 600) })))}` : '',
        ].filter(Boolean).join('\n\n');
        const draft = await invoke(plan.plannerId, 'planning', prompt);
        current.plannerMessageId = draft.id;
        if (unavailable(draft)) {
          try { current.steps = parsePlan(draft.content, plan.participants); } catch { /* retain the unvalidated draft message for inspection */ }
          return finish('blocked', '当前规划回复来自本地演示或降级 Provider，不能作为真实任务完成的依据。请配置可用模型后重新规划。');
        }
        try {
          if (failed(draft)) throw new Error(`规划调用失败：${draft.content.slice(0, 1000)}`);
          current.steps = parsePlan(draft.content, plan.participants);
        } catch (error) {
          reason = `规划格式或依赖校验失败：${detail(error)}`;
          current.reason += '\n' + reason;
          await publish(EVENT.PLAN_UPDATED, { error: reason });
          continue;
        }
        plan.status = 'running';
        await publish(EVENT.PLAN_UPDATED, { stepCount: current.steps.length });
        let executionFailed = false;
        for (const step of current.steps) {
          if (plan.stepRunCount >= PLAN_LIMITS.maxStepRuns) return finish('blocked', `已达到 ${PLAN_LIMITS.maxStepRuns} 次步骤执行上限；请缩小目标后重试。`);
          if (step.dependsOn.some((dependency) => current.steps.find((item) => item.id === dependency)?.status !== 'completed')) {
            throw new Error('step dependencies have not completed');
          }
          step.status = 'running';
          plan.stepRunCount += 1;
          await publish(EVENT.PLAN_STEP_STARTED, { stepId: step.id, owner: step.owner, title: step.title });
          const answer = await invoke(step.owner, 'plan-step', `总体目标：${plan.goal}\n\n执行当前步骤：${step.title}\n验收标准：${step.acceptance}\n依赖步骤：${step.dependsOn.join(', ') || '无'}\n\n请用现有工具和已取得的证据完成本步骤，给出结果、来源与尚未验证的部分。未执行的操作必须明确说明。`, step.id);
          evidence.push(answer);
          step.messageId = answer.id;
          step.result = answer.content.slice(0, 6000) + (answer.content.length > 6000 ? '\n…（完整回复见会话）' : '');
          if (failed(answer) || unavailable(answer)) {
            step.status = 'failed';
            reason = `步骤 ${step.id}（${step.title}）执行失败：${answer.content.slice(0, 1200)}`;
            await publish(EVENT.PLAN_STEP_FAILED, { stepId: step.id, owner: step.owner, reason });
            if (unavailable(answer)) return finish('blocked', '执行中 Provider 降级为本地演示，无法继续真实验收。已保留本轮结果。');
            executionFailed = true;
            for (const pending of current.steps) if (pending.status === 'pending') pending.status = 'skipped';
            break;
          }
          step.status = 'completed';
          await publish(EVENT.PLAN_STEP_COMPLETED, { stepId: step.id, owner: step.owner, messageId: answer.id });
        }
        if (executionFailed) continue;
        plan.status = 'reviewing';
        await publish(EVENT.PLAN_UPDATED);
        const reviewMessage = await invoke(plan.reviewerId, 'plan-review', [
          `复核目标是否完成：${plan.goal}`,
          `逐项核对步骤验收标准和实际证据：\n${JSON.stringify(current.steps.map((step) => ({ ...step, result: step.result?.slice(0, 2000) })))}`,
          '必要时使用只读工具核验结果。文字建议、计划描述和多数意见不是执行证据。',
          '只返回 JSON：{"verdict":"pass|revise|blocked","feedback":"依据、未解决的问题或下一版需要改变的工作"}。pass 仅用于证据支持全部验收标准；revise 表示可通过调整步骤修正；blocked 表示需要当前无法获得的能力或信息。',
        ].join('\n\n'));
        evidence.push(reviewMessage);
        if (unavailable(reviewMessage)) return finish('blocked', '复核 Provider 不可用或处于本地演示模式，计划未通过验收。');
        try {
          if (failed(reviewMessage)) throw new Error(reviewMessage.content);
          const review = parseReview(reviewMessage.content);
          current.review = { ...review, reviewerId: plan.reviewerId, messageId: reviewMessage.id, createdAt: nowIso() };
          await publish(EVENT.PLAN_REVIEWED, { ...review, reviewerId: plan.reviewerId, selfReview: plan.participants.length === 1 });
          if (review.verdict === 'pass') return finish('completed', review.feedback);
          if (review.verdict === 'blocked') return finish('blocked', review.feedback);
          reason = `复核要求修订：${review.feedback}`;
        } catch (error) {
          reason = `复核失败，不能认定完成：${detail(error)}`;
        }
      }
      return finish('blocked', `已达到 ${PLAN_LIMITS.maxReplans} 次重规划上限。${reason}`);
    } catch (error) {
      return finish('blocked', `计划停止：${detail(error)}`);
    }
  }
}
