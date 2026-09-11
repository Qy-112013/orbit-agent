import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture } from './workflow-fixture.ts';
import { parsePlan, parseReview, PLAN_LIMITS } from '../src/core/planner.ts';
import { FallbackProvider, LocalProvider } from '../src/core/providers.ts';
import { JsonStore } from '../src/core/store.ts';
import { createApp } from '../src/server.ts';

const step = (id, owner = 'atlas', dependsOn = []) => ({ id, title: id, owner, dependsOn, acceptance: 'Return the requested evidence and state what was verified.' });
const draft = (steps) => ({ content: JSON.stringify({ steps }) });
const review = (verdict, feedback) => ({ content: JSON.stringify({ verdict, feedback }) });

test('review feedback changes the next plan, preserves old results and executes dependencies before review', async (t) => {
  const invoked = [];
  const fixture = await workflowFixture(t, { async complete(input) {
    assert.ok(!input.tools.some((tool) => tool.name === 'delegate_to_agent'));
    const workflow = input.context.workflow;
    if (workflow?.kind === 'planning') {
      assert.equal(input.agent.id, 'atlas');
      if (workflow.revision === 0) return draft([step('initial-summary', 'forge')]);
      assert.match(input.content, /explicit checksum/);
      return draft([step('verify-checksum'), step('summarize', 'forge', ['verify-checksum'])]);
    }
    if (workflow?.kind === 'review') {
      assert.equal(input.agent.id, 'lens');
      if (workflow.revision === 0) return review('revise', 'Need an explicit checksum from evidence.txt.');
      assert.match(input.content, /checksum: b12/);
      return review('pass', 'Checksum b12 was read from evidence.txt and included in the final summary.');
    }
    if (input.content.includes('执行当前步骤：summarize')) {
      assert.match(input.content, /verified checksum: b12/);
      invoked.push('summarize');
      return { content: 'Final summary with verified checksum: b12.' };
    }
    const result = input.transcript.find((message) => message.role === 'tool');
    if (!result) return { content: '', toolCalls: [{ id: 'read', name: 'workspace_read', arguments: JSON.stringify({ path: 'evidence.txt' }) }] };
    assert.match(JSON.parse(result.content).content, /checksum: b12/);
    if (input.content.includes('执行当前步骤：initial-summary')) {
      invoked.push('initial-summary');
      return { content: 'Initial summary: Release Quartz.' };
    }
    invoked.push('verify-checksum');
    return { content: 'Read evidence.txt; verified checksum: b12.' };
  } });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan @atlas @forge @lens Verify the Quartz release');
  assert.equal(result.plan.status, 'completed');
  assert.equal(result.plan.replanCount, 1);
  assert.equal(result.plan.stepRunCount, 3);
  assert.deepEqual(invoked, ['initial-summary', 'verify-checksum', 'summarize']);
  assert.equal(result.plan.revisions[0].review.verdict, 'revise');
  assert.equal(result.plan.revisions[0].steps[0].owner, 'forge');
  assert.equal(result.plan.revisions[1].steps[0].owner, 'atlas');
  assert.equal(result.plan.revisions[1].review.verdict, 'pass');
  assert.equal(result.collaboration.delegations, 0);
  const events = fixture.store.listEvents({ threadId: fixture.threadId, limit: 500 });
  assert.match(events.find((event) => event.type === 'plan.replanned').payload.reason, /explicit checksum/);
  assert.ok(result.messages.filter((message) => message.metadata.phase === 'plan-step').every((message) => message.metadata.planId === result.plan.id && message.metadata.planStepId));
  const restored = await new JsonStore(fixture.dataFile).init();
  assert.deepEqual(restored.getPlan(result.plan.id).revisions, result.plan.revisions);
});

test('a failed step produces a new plan with failure feedback and leaves the next conversation turn usable', async (t) => {
  const fixture = await workflowFixture(t, { async complete(input) {
    const workflow = input.context.workflow;
    if (workflow?.kind === 'planning') {
      if (workflow.revision) assert.match(input.content, /temporary execution outage/);
      return draft([step(workflow.revision ? 'recover' : 'fail-once')]);
    }
    if (workflow?.kind === 'review') return review('pass', 'Recovery result was checked.');
    if (input.content.includes('执行当前步骤：fail-once')) throw new Error('temporary execution outage');
    return { content: 'Recovered test result.' };
  } });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan Recover a failed operation');
  assert.deepEqual(result.plan.participants, ['atlas']);
  assert.equal(result.plan.status, 'completed');
  assert.equal(result.plan.replanCount, 1);
  assert.equal(result.plan.revisions[0].steps[0].status, 'failed');
  assert.equal(result.plan.revisions[1].steps[0].status, 'completed');
  assert.ok(result.messages.some((message) => message.failed));
  const next = await fixture.orchestrator.submitMessage(fixture.threadId, '普通后续问题');
  assert.equal(next.plan, null);
  assert.equal(next.messages.length, 1);
  assert.equal(fixture.orchestrator.activeRuns.size, 0);
});

test('invalid review output cannot pass a plan and stops after the replan budget', async (t) => {
  let drafts = 0;
  const fixture = await workflowFixture(t, { async complete(input) {
    if (input.context.workflow?.kind === 'planning') { drafts += 1; return draft([step('check')]); }
    if (input.context.workflow?.kind === 'review') return { content: 'Looks good, probably PASS.' };
    return { content: 'Step result ready for review.' };
  } });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan Validate evidence');
  assert.equal(result.plan.status, 'blocked');
  assert.equal(result.plan.replanCount, PLAN_LIMITS.maxReplans);
  assert.equal(drafts, PLAN_LIMITS.maxReplans + 1);
  assert.ok(result.plan.revisions.every((revision) => !revision.review));
  assert.match(result.plan.outcome, /复核失败/);
});

test('the total step budget bounds work even when reviews keep requesting new plans', async (t) => {
  const fixture = await workflowFixture(t, { async complete(input) {
    if (input.context.workflow?.kind === 'planning') return draft(Array.from({ length: 5 }, (_, index) => step('s' + index)));
    if (input.context.workflow?.kind === 'review') return review('revise', 'Recheck the remaining evidence.');
    return { content: 'Step result.' };
  } });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan Repeated checks');
  assert.equal(result.plan.status, 'blocked');
  assert.equal(result.plan.stepRunCount, PLAN_LIMITS.maxStepRuns);
  assert.equal(result.messages.filter((message) => message.metadata.phase === 'plan-step').length, PLAN_LIMITS.maxStepRuns);
  assert.ok(result.plan.revisions.at(-1).steps.some((item) => item.status === 'skipped'));
});

test('invalid owners and dependency graphs are rejected before any plan step can execute', async (t) => {
  for (const invalid of [[], [step('s1', 'not-a-participant')], [step('s1', 'atlas', ['s1'])], [step('s1', 'atlas', ['s2']), step('s2')], [step('s1'), step('s1')]]) {
    assert.throws(() => parsePlan(JSON.stringify({ steps: invalid }), ['atlas']));
  }
  assert.throws(() => parseReview(JSON.stringify({ verdict: 'pass' })));
  let executions = 0;
  const fixture = await workflowFixture(t, { async complete(input) {
    if (input.context.workflow?.kind === 'planning') return draft([step('s1', 'atlas', ['missing'])]);
    executions += 1;
    return { content: 'must not execute' };
  } });
  const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan Invalid dependencies');
  assert.equal(result.plan.status, 'blocked');
  assert.equal(result.plan.stepRunCount, 0);
  assert.equal(executions, 0);
});

test('local fallback during planning or review is blocked instead of reported as successful execution', async (t) => {
  for (const outageAt of ['planning', 'review']) {
    await t.test(outageAt, async (subtest) => {
      const primary = { id: 'fixture-api', async complete(input) {
        if (input.context.workflow?.kind === outageAt) throw new Error('fixture API unavailable');
        if (input.context.workflow?.kind === 'planning') return draft([step('check')]);
        return { content: 'Observed result.' };
      } };
      const fixture = await workflowFixture(subtest, new FallbackProvider(primary, new LocalProvider({ latencyMs: 0 })));
      const result = await fixture.orchestrator.submitMessage(fixture.threadId, '#plan Verify a task');
      assert.equal(result.plan.status, 'blocked');
      assert.equal(result.plan.replanCount, 0);
      assert.ok(result.messages.some((message) => message.metadata.status === 'degraded'));
      assert.ok(!result.coordinationMessage.content.includes('已通过复核'));
    });
  }
});

test('restart marks an in-flight plan interrupted, keeps completed evidence and never auto-runs it', async (t) => {
  const fixture = await workflowFixture(t);
  const now = new Date().toISOString();
  await fixture.store.savePlan({ id: 'plan_crash', threadId: fixture.threadId, requestMessageId: 'msg_crash', goal: 'recover', participants: ['atlas'], plannerId: 'atlas', reviewerId: 'atlas', status: 'running', revisions: [{ revision: 0, reason: 'initial', createdAt: now, steps: [{ ...step('done'), status: 'completed', result: 'persisted evidence' }, { ...step('inflight', 'atlas', ['done']), status: 'running' }] }], replanCount: 0, stepRunCount: 2, outcome: '', createdAt: now, updatedAt: now });
  let calls = 0;
  const restored = await createApp({ dataFile: fixture.dataFile, workspaceRoot: fixture.root, provider: { async complete() { calls += 1; return { content: 'unexpected invocation' }; } } });
  const plan = restored.runtime.store.getPlan('plan_crash');
  assert.equal(plan.status, 'interrupted');
  assert.equal(plan.revisions[0].steps[0].result, 'persisted evidence');
  assert.equal(plan.revisions[0].steps[1].status, 'failed');
  assert.equal(calls, 0);
});
