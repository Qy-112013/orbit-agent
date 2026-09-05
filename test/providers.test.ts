import test from 'node:test';
import assert from 'node:assert/strict';
import { FallbackProvider, ProviderRegistry } from '../src/core/providers.ts';

test('clears a stale provider error after recovery', async () => {
  let attempts = 0;
  const primary = {
    async complete() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary outage');
      return { content: 'recovered', provider: 'test', model: 'fixture' };
    },
  };
  const fallback = { async complete() { return { content: 'fallback', provider: 'local' }; } };
  const provider = new FallbackProvider(primary, fallback);
  const input = { agent: { id: 'atlas', name: 'Atlas', role: 'architect', aliases: [] }, content: 'x', context: { recentMessages: [], memories: [], citations: [] } };
  await provider.complete(input);
  assert.equal(provider.lastError, 'temporary outage');
  await provider.complete(input);
  assert.equal(provider.lastError, null);
});

test('routes different agents to different registered providers', async () => {
  const calls: string[] = [];
  const registry = new ProviderRegistry()
    .register('default', { id: 'default-adapter', async complete() { calls.push('default'); return { content: 'default' }; } })
    .register('atlas', { id: 'atlas-adapter', async complete() { calls.push('atlas'); return { content: 'atlas' }; } });
  const base = { content: 'x', context: { recentMessages: [], memories: [], citations: [] } };
  const atlas = await registry.complete({ ...base, agent: { id: 'atlas', name: 'Atlas', role: 'architect', provider: 'auto', aliases: [] } });
  const lens = await registry.complete({ ...base, agent: { id: 'lens', name: 'Lens', role: 'reviewer', provider: 'auto', aliases: [] } });
  assert.equal(atlas.content, 'atlas');
  assert.equal(lens.content, 'default');
  assert.deepEqual(calls, ['atlas', 'default']);
});
