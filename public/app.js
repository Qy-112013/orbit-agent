const EVENT_NAMES = [
  'message.accepted',
  'route.decided',
  'context.retrieved',
  'agent.started',
  'agent.completed',
  'agent.failed',
  'tool.called',
  'execution.completed',
];

const state = {
  agents: [],
  threads: [],
  currentThread: null,
  events: [],
  memories: [],
  tasks: [],
  stats: {},
  provider: null,
  source: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function relativeTime(value) {
  const age = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(age) || age < 60_000) return '刚刚';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前`;
  return `${Math.floor(age / 86_400_000)} 天前`;
}

function agentById(agentId) {
  return state.agents.find((agent) => agent.id === agentId) ?? null;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
  return payload;
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 3600);
}

function renderAgents() {
  $('#agent-list').innerHTML = state.agents.map((agent) => `
    <div class="agent-row" title="@${escapeHtml(agent.id)} · ${escapeHtml(agent.description ?? '')}">
      <div class="agent-avatar" style="background:${escapeHtml(agent.color ?? '#a695ff')}">${escapeHtml(agent.emoji ?? agent.name.slice(0, 1))}</div>
      <div class="agent-info"><div class="agent-name">${escapeHtml(agent.name)}</div><div class="agent-role">${escapeHtml(agent.role)}</div></div>
      <span class="agent-status" aria-label="available"></span>
    </div>`).join('');
  $('#mention-hints').innerHTML = state.agents.map((agent) =>
    `<button class="mention-chip" type="button" data-mention="${escapeHtml(agent.id)}">@${escapeHtml(agent.id)}</button>`,
  ).join('');
  document.querySelectorAll('[data-mention]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $('#message-input');
      const token = `@${button.dataset.mention} `;
      const start = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, start)}${token}${input.value.slice(input.selectionEnd ?? start)}`;
      input.focus();
      input.selectionStart = input.selectionEnd = start + token.length;
    });
  });
}

function renderThreads() {
  $('#thread-list').innerHTML = state.threads.length
    ? state.threads.map((thread) => `
      <button class="thread-item ${thread.id === state.currentThread?.id ? 'active' : ''}" type="button" data-thread-id="${escapeHtml(thread.id)}">
        ${escapeHtml(thread.title)}
        <span class="thread-item-meta">${thread.messageCount ?? 0} 条消息 · ${relativeTime(thread.updatedAt)}</span>
      </button>`).join('')
    : '<div class="empty-state compact">还没有线程</div>';
  document.querySelectorAll('[data-thread-id]').forEach((button) => {
    button.addEventListener('click', () => selectThread(button.dataset.threadId));
  });
  $('#thread-count').textContent = String(state.threads.length);
}

function renderThread() {
  const thread = state.currentThread;
  if (!thread) return;
  $('#topbar-thread-title').textContent = thread.title;
  $('#thread-title').textContent = thread.title;
  $('#thread-id-label').textContent = `#${thread.id.slice(-6)}`;
  $('#message-metric').textContent = String(thread.messages.length);
  $('#event-metric').textContent = String(state.events.length);
  const timeline = $('#timeline');
  if (!thread.messages.length) {
    timeline.innerHTML = '<div class="empty-state">这是一个空线程。<br />试试输入一个问题，或使用 <code>@all</code> 让多个 Agent 独立协作。</div>';
    return;
  }
  timeline.innerHTML = thread.messages.map((message) => {
    if (message.role === 'system') {
      return `<article class="message system"><div class="message-content">${escapeHtml(message.content)}</div></article>`;
    }
    const agent = message.agentId ? agentById(message.agentId) : null;
    const isUser = message.role === 'user';
    const name = isUser ? 'You' : (agent?.name ?? message.agentId ?? 'Agent');
    const role = isUser ? 'operator' : (agent?.role ?? 'assistant');
    const color = isUser ? '#342d61' : (agent?.color ?? '#a695ff');
    const avatar = isUser ? 'YOU' : (agent?.emoji ?? name.slice(0, 1));
    const metadata = message.metadata ?? {};
    const provider = metadata.provider ? `<span class="provider-tag">${escapeHtml(metadata.provider)}</span>` : '';
    const citations = (message.citations ?? []).slice(0, 4).map((citation) =>
      `<span class="citation">${escapeHtml(citation.id ?? citation)}</span>`).join(' ');
    return `<article class="message ${isUser ? 'user' : 'assistant'}">
      <div class="message-avatar" style="background:${escapeHtml(color)}">${escapeHtml(avatar)}</div>
      <div class="message-body">
        <div class="message-meta"><span class="message-author">${escapeHtml(name)}</span><span class="message-role">${escapeHtml(role)}</span><span class="message-time">${formatTime(message.createdAt)}</span></div>
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-footer">${provider}${citations ? `<span>·</span><span>${citations}</span>` : ''}${metadata.latencyMs ? `<span>· ${metadata.latencyMs}ms</span>` : ''}</div>
      </div>
    </article>`;
  }).join('');
  timeline.scrollTop = timeline.scrollHeight;
}

const TRACE_LABELS = {
  'message.accepted': ['Message accepted', '输入已写入线程'],
  'route.decided': ['Route decided', '解析 mention，确定执行策略'],
  'context.retrieved': ['Context retrieved', '组装最近消息与长期记忆'],
  'agent.started': ['Agent started', '开始调用模型适配器'],
  'agent.completed': ['Agent completed', '结果已持久化'],
  'agent.failed': ['Agent failed', '已记录失败并保持线程可用'],
  'tool.called': ['Tool called', '安全工具完成一次调用'],
  'execution.completed': ['Turn completed', '本轮协作闭环完成'],
};

function traceClass(type) {
  if (type.endsWith('failed')) return 'error';
  if (type.endsWith('completed') || type === 'tool.called') return 'success';
  return '';
}

function traceDetail(event) {
  const payload = event.payload ?? {};
  if (event.type === 'route.decided') return `${payload.strategy ?? 'serial'} · ${(payload.targets ?? []).join(', ')}`;
  if (event.type === 'context.retrieved') return `${payload.messageCount ?? 0} messages · ${payload.memoryCount ?? 0} memories`;
  if (event.type === 'agent.failed') return `${payload.agentName ?? payload.agentId ?? ''}: ${payload.error ?? 'unknown error'}`;
  if (event.type === 'agent.started' || event.type === 'agent.completed') return payload.agentName ?? payload.agentId ?? '';
  if (event.type === 'agent.failed') return payload.error ?? '';
  if (event.type === 'tool.called') return payload.tool ?? '';
  if (event.type === 'execution.completed') return `${payload.strategy ?? 'serial'} · ${payload.latencyMs ?? 0}ms`;
  return '';
}

function renderTrace() {
  const events = state.events.slice(-28).reverse();
  $('#event-metric').textContent = String(state.events.length);
  $('#trace-list').innerHTML = events.length
    ? events.map((event) => {
      const [title, subtitle] = TRACE_LABELS[event.type] ?? [event.type, ''];
      return `<div class="trace-item ${traceClass(event.type)}"><span class="trace-dot"></span><div><div class="trace-title"><strong>${escapeHtml(title)}</strong> · ${escapeHtml(subtitle)}</div><div class="trace-meta">${escapeHtml(traceDetail(event))} · ${formatTime(event.createdAt)}</div></div></div>`;
    }).join('')
    : '<div class="empty-state compact">发送一条消息后，这里会显示路由、记忆检索和 Agent 执行轨迹。</div>';
}

function renderMemories() {
  $('#memory-count').textContent = String(state.memories.length);
  $('#memory-list').innerHTML = state.memories.length
    ? state.memories.slice(0, 8).map((memory) => `<div class="memory-item"><div class="memory-text">${escapeHtml(memory.text)}</div><div class="memory-meta"><span>${escapeHtml(memory.source ?? 'manual')}</span><span class="memory-score">${memory.score ? `${Math.round(memory.score * 100)}% match` : relativeTime(memory.createdAt)}</span></div></div>`).join('')
    : '<div class="empty-state compact">暂无记忆。可发送 <code>记住：…</code> 建立一条。</div>';
}

function renderTasks() {
  const openTasks = state.tasks.filter((task) => task.status !== 'done');
  $('#task-count').textContent = String(openTasks.length);
  $('#task-total').textContent = String(openTasks.length);
  $('#task-list').innerHTML = openTasks.length
    ? openTasks.slice(0, 8).map((task) => `<button class="task-item" type="button" data-task-id="${escapeHtml(task.id)}" title="点击将任务标记为完成"><span class="task-check"></span><span>${escapeHtml(task.title)}<span class="task-owner">${task.owner ? `owner · ${escapeHtml(agentById(task.owner)?.name ?? task.owner)}` : 'unassigned'}</span></span></button>`).join('')
    : '<div class="empty-state compact">用 <code>任务：…</code> 创建可追踪任务。</div>';
  document.querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/tasks/${encodeURIComponent(button.dataset.taskId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'done' }),
        });
        await refreshAuxiliary();
      } catch (error) {
        button.disabled = false;
        showToast(error.message, 'error');
      }
    });
  });
}

function setBusy(value, label = 'Agents are thinking…') {
  state.busy = value;
  $('#send-button').disabled = value;
  $('#message-input').disabled = value;
  $('#run-indicator').classList.toggle('hidden', !value);
  $('#run-label').textContent = label;
}

function connectEvents(threadId) {
  state.source?.close();
  const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?after=0&stream=1`);
  state.source = source;
  for (const eventName of EVENT_NAMES) {
    source.addEventListener(eventName, async (event) => {
      try {
        const record = JSON.parse(event.data);
        if (!state.events.some((item) => item.id === record.id)) state.events.push(record);
        state.events.sort((a, b) => a.sequence - b.sequence);
        renderTrace();
        if (eventName === 'agent.started') setBusy(true, `${record.payload?.agentName ?? 'Agent'} is thinking…`);
        if (eventName === 'execution.completed') {
          setBusy(false);
          await refreshThread(threadId, false);
          await refreshAuxiliary();
        }
      } catch {
        // Ignore malformed stream frames; the next HTTP refresh remains the
        // source of truth.
      }
    });
  }
  source.onerror = () => {
    // EventSource reconnects automatically. Keep the UI usable while it does.
    if (!state.busy) $('#run-label').textContent = '实时轨迹重连中…';
  };
}

async function refreshThread(threadId, connect = true) {
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  state.currentThread = payload.thread;
  const trace = await api(`/api/threads/${encodeURIComponent(threadId)}/events?after=0`);
  state.events = trace.events ?? [];
  renderThread();
  renderTrace();
  renderThreads();
  if (connect) connectEvents(threadId);
}

async function refreshAuxiliary() {
  const [memoryPayload, taskPayload, threadPayload] = await Promise.all([
    api(`/api/memories?threadId=${encodeURIComponent(state.currentThread?.id ?? '')}`),
    api(`/api/tasks?threadId=${encodeURIComponent(state.currentThread?.id ?? '')}`),
    api('/api/threads'),
  ]);
  state.memories = memoryPayload.memories ?? [];
  state.tasks = taskPayload.tasks ?? [];
  state.threads = threadPayload.threads ?? state.threads;
  renderMemories();
  renderTasks();
  renderThreads();
}

async function selectThread(threadId) {
  if (!threadId) return;
  try {
    setBusy(false);
    await refreshThread(threadId);
    await refreshAuxiliary();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function createThread() {
  try {
    const payload = await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: '未命名协作线程' }) });
    state.threads.unshift(payload.thread);
    await selectThread(payload.thread.id);
    $('#message-input').focus();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitMessage(event) {
  event?.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content || state.busy || !state.currentThread) return;
  input.value = '';
  setBusy(true, 'Routing and assembling context…');
  try {
    await api(`/api/threads/${encodeURIComponent(state.currentThread.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientRequestId: crypto.randomUUID?.() ?? String(Date.now()) }),
    });
    // Re-read the canonical thread instead of blindly appending the response:
    // an SSE `execution.completed` frame can arrive before this HTTP response,
    // and merging by hand would duplicate messages in that race.
    await refreshThread(state.currentThread.id, false);
    setBusy(false);
    await refreshAuxiliary();
  } catch (error) {
    setBusy(false);
    input.value = content;
    showToast(error.message, 'error');
  }
}

async function boot() {
  try {
    const payload = await api('/api/bootstrap');
    state.agents = payload.agents ?? [];
    state.threads = payload.threads ?? [];
    state.stats = payload.stats ?? {};
    state.provider = payload.provider ?? null;
    renderAgents();
    renderThreads();
    renderMemories();
    renderTasks();
    $('#provider-label').textContent = state.provider?.mode === 'provider-registry' ? `${state.provider.providers?.length ?? 0} provider routes` : state.provider?.mode === 'local-demo' ? 'Local demo provider' : 'OpenAI-compatible provider';
    const first = state.threads[0];
    if (first) await selectThread(first.id);
    else showToast('没有可用线程', 'error');
  } catch (error) {
    showToast(`无法连接运行时：${error.message}`, 'error');
  }
}

$('#new-thread').addEventListener('click', createThread);
$('#composer').addEventListener('submit', submitMessage);
$('#refresh-button').addEventListener('click', async () => {
  if (!state.currentThread) return;
  await selectThread(state.currentThread.id);
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#clear-memory-filter').addEventListener('click', () => refreshAuxiliary().catch((error) => showToast(error.message, 'error')));
document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const target = button.dataset.view === 'memory' ? $('#memory-list') : button.dataset.view === 'tasks' ? $('#task-list') : $('#timeline');
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

window.__orbitAgent = { state, selectThread, submitMessage };
boot();
