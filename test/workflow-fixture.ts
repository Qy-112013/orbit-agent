import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../src/server.ts';
import { LocalProvider } from '../src/core/providers.ts';

export async function workflowFixture(t, provider = new LocalProvider({ latencyMs: 0 }), embeddingProvider = null) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-workflow-test-'));
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('orbit-workflow-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'evidence.txt'), 'Release Quartz\nchecksum: b12\n预算上限：48000 元\n');
  const dataFile = join(root, 'state.json');
  const app = await createApp({ dataFile, workspaceRoot: root, provider, embeddingProvider });
  server = app.server;
  return { ...app.runtime, server, root, dataFile, threadId: app.runtime.store.listThreads()[0].id };
}
