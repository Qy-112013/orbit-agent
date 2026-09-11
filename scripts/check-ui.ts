import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.ts';
import { createWorkflowDemoProvider } from './workflow-demo-provider.ts';

// Uses an installed Chromium browser and its local DevTools protocol. No npm
// browser dependency, real provider, personal browser profile or user data.
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(project, '.orbit-artifacts', 'ui');
const root = await mkdtemp(join(tmpdir(), 'orbit-ui-check-'));
let browser;
let server;
let cdp;
let browserError = '';

async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let cause;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch (error) { cause = error; }
    await delay(70);
  }
  throw new Error(`Timed out: ${label}${cause ? ': ' + cause.message : ''}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const errors = [];
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(JSON.stringify(message.params.args));
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('DevTools socket closed')); }
    pending.clear();
  });
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return { errors, close: () => socket.close(), send: (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: done, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  }) };
}

try {
  const candidates = [process.env.ORBIT_BROWSER_COMMAND, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  let command;
  for (const candidate of candidates) { try { await access(candidate); command = candidate; break; } catch { /* next installation */ } }
  if (!command) throw new Error('Install Chrome/Edge/Chromium or set ORBIT_BROWSER_COMMAND to its executable path.');
  await mkdir(output, { recursive: true });
  const app = await createApp({ dataFile: join(root, 'state.json'), workspaceRoot: root, provider: createWorkflowDemoProvider(), loopOptions: { toolsEnabled: true } });
  server = app.server;
  const threadA = app.runtime.store.listThreads()[0].id;
  await app.runtime.store.updateThread(threadA, { title: '会话 A · Quartz 发布' });
  const threadB = (await app.runtime.store.createThread({ title: '会话 B · 草稿隔离' })).id;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = join(root, 'browser-profile');
  browser = spawn(command, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-breakpad', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', (chunk) => { browserError = (browserError + chunk.toString()).slice(-3000); });
  browser.on('error', (error) => { browserError = error.message; });
  const debugPort = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'browser startup');
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  cdp = await connect(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const state = 'window.__orbitAgent.state';
  const when = (expression, label) => until(() => evaluate(`Boolean(${expression})`), label);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const set = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const selectThread = async (id) => {
    await click(`[data-thread-id="${id}"]`);
    await when(`${state}.currentThread?.id === ${JSON.stringify(id)} && !${state}.busy`, 'selected thread ' + id);
  };
  const capture = async (name) => {
    await evaluate('window.scrollTo(0, 0)');
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 1800), scale: 1 } });
    await writeFile(join(output, name), Buffer.from(image.data, 'base64'));
  };
  await cdp.send('Page.navigate', { url: base });
  await when('window.__orbitAgent?.state.currentThread && !window.__orbitAgent.state.busy', 'initial page load');
  await selectThread(threadA);

  console.log('UI: importing a scoped document and checking source rendering');
  await click('#import-knowledge');
  await set('#knowledge-title', 'Quartz 发布说明');
  await set('#knowledge-source', 'release.md');
  const documentText = 'Quartz 发布预算：48000 元。\n发布校验码 checksum: b12。\n<script>window.__orbitUnsafe=true</script>';
  await set('#knowledge-content', documentText);
  await evaluate('document.querySelector("#knowledge-form").requestSubmit()');
  await when(`${state}.documents.length === 1`, 'document import');
  await set('#knowledge-query', '预算');
  await evaluate('document.querySelector("#knowledge-search").requestSubmit()');
  await when(`${state}.knowledgeHits.length > 0`, 'knowledge search');
  await click('[data-document-id]');
  await when('document.querySelector("#source-dialog").open', 'source dialog');
  assert.equal(await evaluate('document.querySelector("#source-text").textContent'), documentText);
  assert.equal(await evaluate('Boolean(window.__orbitUnsafe)'), false);
  await click('[data-close="source-dialog"]');
  await set('#message-input', 'Quartz 预算是多少？');
  await evaluate('document.querySelector("#composer").requestSubmit()');
  await when(`${state}.currentThread.messages.length === 2 && !${state}.busy`, 'cited chat answer');
  assert.equal(await evaluate('document.querySelectorAll("#timeline .citation-detail").length'), 1);

  console.log('UI: switching threads during an active request and preserving drafts');
  await set('#message-input', 'SLOW_TURN 会话 A 的慢请求');
  await evaluate('document.querySelector("#composer").requestSubmit()');
  await when(`${state}.pendingThreads.has(${JSON.stringify(threadA)})`, 'pending request');
  await selectThread(threadB);
  await set('#message-input', '只属于会话 B 的草稿');
  await when(`!${state}.pendingThreads.has(${JSON.stringify(threadA)})`, 'late response settled');
  assert.equal(await evaluate(`${state}.currentThread.id`), threadB);
  assert.equal(await evaluate('document.querySelector("#message-input").value'), '只属于会话 B 的草稿');
  assert.equal(await evaluate(`${state}.currentThread.messages.length`), 0);
  await selectThread(threadA);
  await set('#message-input', '会话 A 暂未发送的草稿');
  await selectThread(threadB);
  assert.equal(await evaluate('document.querySelector("#message-input").value'), '只属于会话 B 的草稿');
  await selectThread(threadA);
  assert.equal(await evaluate('document.querySelector("#message-input").value'), '会话 A 暂未发送的草稿');

  console.log('UI: exercising plan, review feedback and a revised plan');
  await set('#execution-mode', 'plan');
  await set('#message-input', '@atlas @forge @lens 核对 Quartz 发布说明');
  await evaluate('document.querySelector("#composer").requestSubmit()');
  await when(`${state}.plans[0]?.status === 'completed' && !${state}.busy`, 'completed revised plan');
  assert.equal(await evaluate(`${state}.plans[0].replanCount`), 1);
  assert.equal(await evaluate(`${state}.plans[0].revisions.length`), 2);
  assert.match(await evaluate('document.querySelector("#plan-list").textContent'), /已通过复核/);
  const viewport = await evaluate('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
  assert.ok(viewport.scrollWidth <= viewport.width + 1, `horizontal overflow: ${JSON.stringify(viewport)}`);
  await capture('desktop.png');

  console.log('UI: renaming, branching, archiving and restoring a conversation');
  await click('#rename-thread');
  await set('#thread-name', '重命名后的 Quartz 会话');
  await evaluate('document.querySelector("#thread-form").requestSubmit()');
  await when(`${state}.currentThread.title === '重命名后的 Quartz 会话'`, 'thread rename');
  await click('#timeline [data-fork-message]');
  await set('#thread-name', '第一问的独立分支');
  await evaluate('document.querySelector("#thread-form").requestSubmit()');
  await when(`${state}.currentThread?.metadata.parentThreadId === ${JSON.stringify(threadA)} && !${state}.busy`, 'conversation branch');
  await when(`${state}.documents.length === 0`, 'branch scope');
  assert.equal(await evaluate(`${state}.currentThread.messages.length`), 1);
  await click('#archive-thread');
  await when(`${state}.currentThread.archived === true`, 'archive');
  assert.equal(await evaluate('document.querySelector("#message-input").disabled'), true);
  await click('#archive-thread');
  await when(`${state}.currentThread.archived === false && !document.querySelector('#message-input').disabled`, 'restore');
  await set('#thread-search', '独立分支');
  await evaluate('document.querySelector("#thread-search").dispatchEvent(new Event("input", { bubbles: true }))');
  await when(`${state}.threads.length === 1`, 'thread search');
  assert.equal(await evaluate('Boolean(window.__orbitUnsafe)'), false);
  assert.deepEqual(cdp.errors, [], 'browser console must have no uncaught exceptions');
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, provider: 'scripted-demo', realModelCalls: 0, checks: ['document import', 'source escaping', 'retrieval citations', 'late-response isolation', 'per-thread drafts', 'plan/review/replan', 'desktop layout', 'rename', 'branch', 'archive/restore', 'thread search'], screenshots: ['desktop.png'], consoleErrors: cdp.errors }, null, 2));
  console.log(`UI smoke passed. Artifacts: ${output}`);
} catch (error) {
  if (browserError && !cdp) console.error(browserError);
  throw error;
} finally {
  if (cdp) { await cdp.send('Browser.close').catch(() => undefined); cdp.close(); }
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise((done) => browser.once('exit', done)), delay(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('orbit-ui-check-'));
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
