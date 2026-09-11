import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, DEFAULT_AGENTS } from '../src/core/agent-registry.ts';
import { createRouter } from '../src/core/router.ts';

const router = createRouter(new AgentRegistry(DEFAULT_AGENTS));

test('routes an explicit mention to one agent and strips the routing marker', () => {
  const result = router.route('@forge 请把这个方案落成一个最小实现');
  assert.deepEqual(result.targets, ['forge']);
  assert.equal(result.strategy, 'serial');
  assert.equal(result.cleanContent, '请把这个方案落成一个最小实现');
  assert.equal(result.reason, 'explicit_mention');
});

test('broadcast mention selects all agents and uses parallel strategy', () => {
  const result = router.route('@all 先独立分析，再汇总风险');
  assert.deepEqual(result.targets, ['atlas', 'forge', 'lens']);
  assert.equal(result.strategy, 'parallel');
  assert.equal(result.broadcast, true);
});

test('falls back to the thread active agent and ignores email-like mentions', () => {
  const result = router.route('联系 foo@forge.com 后继续处理', { activeAgentId: 'lens' });
  assert.deepEqual(result.targets, ['lens']);
  assert.equal(result.strategy, 'serial');
  assert.equal(result.mentions.length, 0);
});

test('supports an explicit parallel control tag', () => {
  const result = router.route('#parallel 请从多个角度给出意见', { activeAgentId: 'atlas' });
  assert.equal(result.strategy, 'parallel');
  assert.equal(result.targets[0], 'atlas');
});

test('routes discussion participants and removes controls before model invocation', () => {
  const result = router.route('#discuss @forge @lens compare risks');
  assert.equal(result.strategy, 'discuss');
  assert.deepEqual(result.targets, ['forge', 'lens']);
  assert.equal(result.cleanContent, 'compare risks');
});
