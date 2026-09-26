import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { LocalProvider } from '../src/core/providers.ts';

async function appFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-hardening-test-'));
  const app = await createApp({ dataFile: join(root, 'state.json'), workspaceRoot: root, provider: new LocalProvider({ latencyMs: 0 }) });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((done) => app.server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  return app.server.address().port;
}

/** node:http lets tests set Host and Origin, which fetch treats as forbidden headers. */
function send(port: number, { method = 'GET', path = '/api/health', headers = {}, body }: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('API responses carry no CORS headers', async (t) => {
  const port = await appFixture(t);
  const response = await send(port, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('foreign Host headers are rejected to block DNS rebinding', async (t) => {
  const port = await appFixture(t);
  const rebinding = await send(port, { headers: { host: `attacker.example:${port}` } });
  assert.equal(rebinding.status, 403);
  assert.equal(JSON.parse(rebinding.body).error.code, 'HOST_NOT_ALLOWED');
  assert.equal((await send(port, { headers: { host: `localhost:${port}` } })).status, 200);
});

test('cross-origin writes are rejected while same-origin and origin-less writes pass', async (t) => {
  const port = await appFixture(t);
  const body = JSON.stringify({ title: 'hardening' });
  const cross = await send(port, { method: 'POST', path: '/api/threads', headers: { origin: 'https://attacker.example' }, body });
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(cross.body).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal((await send(port, { method: 'POST', path: '/api/threads', headers: { origin: `http://127.0.0.1:${port}` }, body })).status, 201);
  assert.equal((await send(port, { method: 'POST', path: '/api/threads', body })).status, 201);
});
