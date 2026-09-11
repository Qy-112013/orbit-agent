const EVENT_NAMES = [
  'message.accepted',
  'route.decided',
  'context.retrieved',
  'context.compacted',
  'knowledge.retrieved',
  'plan.created',
  'plan.updated',
  'plan.step.started',
  'plan.step.completed',
  'plan.step.failed',
  'plan.reviewed',
  'plan.replanned',
  'plan.completed',
  'skills.selected',
  'agent.step.started',
  'agent.step.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'provider.fallback',
  'agent.delegated',
  'agent.returned',
  'discussion.round.started',
  'discussion.round.completed',
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
  selectedThreadId: null,
  selectedPlanId: null,
  documents: [],
  knowledgeHits: [],
  plans: [],
  drafts: new Map(),
  draftModes: new Map(),
  pendingThreads: new Set(),
  threadRefresh: 0,
  listRefresh: 0,
  auxiliaryRefresh: 0,
  searchRefresh: 0,
  showArchived: false,
  threadQuery: '',
  threadAction: null,
  knowledgeImportThreadId: null,
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
  ).join('') + '<button class="mention-chip" type="button" id="discuss-mode" title="先独立分析，再互相复核，最后汇总">两轮讨论</button>';
  $('#discuss-mode').addEventListener('click', () => {
    if (state.busy || state.currentThread?.archived) return;
    const input = $('#message-input');
    const text = input.value.replace(/(^|\s)#(serial|parallel|discuss|plan)\b/gi, '$1').trim();
    $('#execution-mode').value = 'discuss';
    input.value = `${/@[\p{L}\p{N}_-]+/u.test(text) ? '' : '@all '}${text}`;
    input.focus();
  });
  document.querySelectorAll('[data-mention]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.busy || state.currentThread?.archived) return;
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
      <button class="thread-item ${thread.id === state.selectedThreadId ? 'active' : ''}" type="button" data-thread-id="${escapeHtml(thread.id)}">
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
  $('#archive-thread').textContent = thread.archived ? '恢复会话' : '归档';
  $('#thread-subtitle').textContent = thread.archived ? '此会话已归档。恢复后可继续对话。'
    : `${thread.metadata.parentThreadId ? '分支会话 · ' : ''}当前 Agent：${agentById(thread.activeAgentId)?.name ?? thread.activeAgentId ?? '未指定'} · 历史上下文与知识检索已启用`;
  $('#context-summary').classList.toggle('hidden', !thread.summary);
  $('#context-summary-label').textContent = thread.summary ? `历史摘录 · 已压缩 ${thread.summary.messageCount} 条消息` : '历史摘录';
  $('#context-summary-text').textContent = thread.summary?.text ?? '';
  $('#event-metric').textContent = String(state.events.length);
  const timeline = $('#timeline');
  const followTail = timeline.dataset.threadId !== thread.id || timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 100;
  timeline.dataset.threadId = thread.id;
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
    const phase = metadata.phase === 'planning' ? '计划草案' : metadata.phase === 'plan-review' ? '计划复核' : metadata.phase === 'plan-step' ? `计划步骤 ${metadata.planStepId}` : metadata.phase === 'delegated' ? '受委派回答' : metadata.phase === 'synthesis' ? '讨论汇总' : metadata.round ? `讨论第 ${metadata.round} 轮` : '';
    const interaction = phase ? `<span>${escapeHtml(phase)}</span>` : '';
    const outcome = metadata.status === 'degraded' ? '<span>本地降级回答</span>' : metadata.status === 'error' ? '<span>执行失败</span>' : '';
    const provider = metadata.provider ? `<span class="provider-tag">${escapeHtml(metadata.provider)}</span>` : '';
    const citations = (message.citations ?? []).slice(0, 12).map(citationMarkup).join('');
    const content = `<div class="message-content">${escapeHtml(message.content)}</div>`;
    const visibleContent = ['planning', 'plan-review'].includes(metadata.phase)
      ? `<details class="structured-message"><summary>${escapeHtml(phase)} · 查看原始回复</summary>${content}</details>` : content;
    return `<article class="message ${isUser ? 'user' : 'assistant'}">
      <div class="message-avatar" style="background:${escapeHtml(color)}">${escapeHtml(avatar)}</div>
      <div class="message-body">
        <div class="message-meta"><span class="message-author">${escapeHtml(name)}</span><span class="message-role">${escapeHtml(role)}</span><span class="message-time">${formatTime(message.createdAt)}</span></div>
        ${visibleContent}
        <div class="message-footer">${interaction}${outcome}${provider}${metadata.latencyMs ? `<span>· ${metadata.latencyMs}ms</span>` : ''}<button class="text-button" type="button" data-fork-message="${escapeHtml(message.id)}">从这里分支</button></div>
        ${citations ? `<div class="message-citations">${citations}</div>` : ''}
      </div>
    </article>`;
  }).join('');
  if (followTail) timeline.scrollTop = timeline.scrollHeight;
}

function citationMarkup(citation) {
  if (!citation || typeof citation !== 'object') return `<span class="citation">${escapeHtml(citation)}</span>`;
  const location = citation.startLine ? ` · 第 ${citation.startLine}–${citation.endLine} 行` : '';
  return `<details class="citation-detail"><summary>${escapeHtml(citation.title ?? citation.source ?? citation.id)}${escapeHtml(location)}</summary><div class="citation-meta">${escapeHtml(citation.id)} · ${escapeHtml(citation.source)}</div><pre>${escapeHtml(citation.text ?? '')}</pre></details>`;
}

const TRACE_LABELS = {
  'context.compacted': ['History compacted', '较早消息已压缩为摘录'],
  'knowledge.retrieved': ['Knowledge retrieved', '检索可引用的原文'],
  'plan.created': ['Plan created', '开始制定计划'],
  'plan.updated': ['Plan updated', '步骤状态已保存'],
  'plan.step.started': ['Plan step started', '执行计划步骤'],
  'plan.step.completed': ['Plan step returned', '步骤结果等待整体复核'],
  'plan.step.failed': ['Plan step failed', '记录失败并评估下一版'],
  'plan.reviewed': ['Plan reviewed', '已记录验收反馈'],
  'plan.replanned': ['Replan', '根据反馈修订步骤'],
  'plan.completed': ['Plan stopped', '已记录最终状态'],
  'skills.selected': ['Skills selected', '已加载相关工作方法'],
  'agent.step.started': ['Model step', '开始下一步推理'],
  'agent.step.completed': ['Model returned', '模型返回回答或工具请求'],
  'tool.started': ['Tool started', '开始处理工具请求'],
  'tool.completed': ['Tool completed', '结果将返回给模型'],
  'tool.failed': ['Tool failed', '失败信息将返回给模型'],
  'provider.fallback': ['Provider fallback', '已切换为本地演示回答'],
  'agent.delegated': ['Agent delegated', '已委派协作任务'],
  'agent.returned': ['Agent returned', '协作结果已回传'],
  'discussion.round.started': ['Discussion started', '开始一轮讨论'],
  'discussion.round.completed': ['Discussion completed', '本轮观点已收齐'],
  'message.accepted': ['Message accepted', '输入已写入线程'],
  'route.decided': ['Route decided', '解析 mention，确定执行策略'],
  'context.retrieved': ['Context retrieved', '组装最近消息与长期记忆'],
  'agent.started': ['Agent started', '开始调用模型适配器'],
  'agent.completed': ['Agent completed', '结果已持久化'],
  'agent.failed': ['Agent failed', '已记录失败并保持线程可用'],
  'tool.called': ['Tool called', '安全工具完成一次调用'],
  'execution.completed': ['Turn completed', '本轮协作闭环完成'],
};

function traceClass(event) {
  const type = event.type;
  if (type === 'plan.completed' && event.payload?.status !== 'completed') return 'error';
  if (type.endsWith('failed')) return 'error';
  if (type.endsWith('completed') || type === 'tool.called') return 'success';
  return '';
}

function traceDetail(event) {
  const payload = event.payload ?? {};
  if (event.type === 'context.compacted') return `${payload.messageCount} 条消息 · 截至 #${payload.throughSequence}`;
  if (event.type === 'knowledge.retrieved') return `${payload.count} 个片段 · ${(payload.sources ?? []).map((source) => source.title).join('、')}`;
  if (event.type.startsWith('plan.')) return `第 ${(payload.revision ?? 0) + 1} 版 · ${payload.stepId ?? ''} ${payload.owner ?? ''} · ${payload.verdict ?? payload.status ?? ''}${payload.reason ? ' · ' + payload.reason : ''}`;
  if (event.type === 'agent.delegated' || event.type === 'agent.returned') return `${payload.fromAgentId} → ${payload.toAgentId}${payload.status ? ` · ${payload.status}` : ''}`;
  if (event.type.startsWith('discussion.round.')) return `第 ${payload.round} 轮`;
  if (event.type.startsWith('agent.step.')) return `${payload.agentId} · 第 ${payload.step} 步${payload.toolCount !== undefined ? ` · ${payload.toolCount} 个工具请求` : ''}`;
  if (event.type === 'provider.fallback') return `${payload.from} → ${payload.provider} · ${payload.error ?? ''}`;
  if (event.type === 'skills.selected') return (payload.skills ?? []).map((skill) => skill.name).join(', ');
  if (event.type.startsWith('tool.') && event.type !== 'tool.called') return `${payload.agentId} · ${payload.tool}${payload.error ? ` · ${payload.error}` : ''}${payload.truncated ? ' · 结果已裁剪' : ''}`;
  if (event.type === 'route.decided') return `${payload.strategy ?? 'serial'} · ${(payload.targets ?? []).join(', ')}`;
  if (event.type === 'context.retrieved') return `${payload.messageCount ?? 0} 条近期消息 · ${payload.summaryMessages ?? 0} 条历史摘录 · ${payload.memoryCount ?? 0} 条记忆 · ${payload.knowledgeCount ?? 0} 个文档片段`;
  if (event.type === 'agent.failed') return `${payload.agentName ?? payload.agentId ?? ''}: ${payload.error ?? 'unknown error'}`;
  if (event.type === 'agent.started' || event.type === 'agent.completed') return payload.agentName ?? payload.agentId ?? '';
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
      return `<div class="trace-item ${traceClass(event)}"><span class="trace-dot"></span><div><div class="trace-title"><strong>${escapeHtml(title)}</strong> · ${escapeHtml(subtitle)}</div><div class="trace-meta">${escapeHtml(traceDetail(event))} · ${formatTime(event.createdAt)}</div></div></div>`;
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

const PLAN_STATUS = { planning: '制定计划', running: '执行中', reviewing: '复核中', replanning: '重规划中', completed: '已通过复核', blocked: '未通过 / 待处理', interrupted: '已中断' };
const STEP_STATUS = { pending: '待执行', running: '执行中', completed: '已输出', failed: '失败', skipped: '未执行' };
const REVIEW_STATUS = { pass: '通过', revise: '需要修订', blocked: '待处理' };

function planStepsMarkup(revision) {
  const steps = (revision?.steps ?? []).map((step) => `<li class="plan-step ${escapeHtml(step.status)}"><div><div class="plan-step-title">${escapeHtml(step.title)}</div><div class="plan-step-meta">${escapeHtml(agentById(step.owner)?.name ?? step.owner)} · ${escapeHtml(STEP_STATUS[step.status] ?? step.status)}${step.dependsOn.length ? ' · 依赖 ' + escapeHtml(step.dependsOn.join(', ')) : ''}</div><details><summary>验收与结果</summary><p>${escapeHtml(step.acceptance)}</p>${step.result ? `<pre>${escapeHtml(step.result)}</pre>` : '<p>尚无步骤结果。</p>'}</details></div></li>`).join('');
  const review = revision?.review;
  return `${steps ? `<ol class="plan-steps">${steps}</ol>` : '<p class="plan-meta">等待规划回复…</p>'}${review ? `<div class="plan-review">复核：${escapeHtml(REVIEW_STATUS[review.verdict])} · ${escapeHtml(agentById(review.reviewerId)?.name ?? review.reviewerId)}<pre>${escapeHtml(review.feedback)}</pre></div>` : ''}`;
}

function renderPlans() {
  $('#plan-count').textContent = String(state.plans.length);
  const select = $('#plan-select');
  select.classList.toggle('hidden', !state.plans.length);
  if (!state.plans.length) {
    state.selectedPlanId = null;
    $('#plan-list').innerHTML = '<div class="empty-state compact">需要拆分工作时，选择“计划与复核”模式。每一步会记录负责人、结果与复核反馈。</div>';
    return;
  }
  const plan = state.plans.find((item) => item.id === state.selectedPlanId) ?? state.plans[0];
  state.selectedPlanId = plan.id;
  select.innerHTML = state.plans.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.goal.slice(0, 35))} · ${escapeHtml(PLAN_STATUS[item.status])}</option>`).join('');
  select.value = plan.id;
  const current = plan.revisions.at(-1);
  const history = plan.revisions.slice(0, -1).map((revision) => `<details class="plan-revision"><summary>第 ${revision.revision + 1} 版 · 查看旧步骤与反馈</summary><pre>${escapeHtml(revision.reason)}</pre>${planStepsMarkup(revision)}</details>`).join('');
  $('#plan-list').innerHTML = `<div class="plan-topline"><span class="plan-status ${escapeHtml(plan.status)}">${escapeHtml(PLAN_STATUS[plan.status])}</span><span class="plan-meta">重规划 ${plan.replanCount}/2 · 步骤执行 ${plan.stepRunCount}/8</span></div><p class="plan-goal">${escapeHtml(plan.goal.slice(0, 240))}</p><p class="plan-meta">规划 ${escapeHtml(agentById(plan.plannerId)?.name ?? plan.plannerId)} · ${plan.participants.length === 1 ? '同一 Agent 自检' : '复核 ' + escapeHtml(agentById(plan.reviewerId)?.name ?? plan.reviewerId)} · 第 ${(current?.revision ?? 0) + 1} 版</p>${current?.revision ? `<details class="plan-revision"><summary>本次调整原因</summary><pre>${escapeHtml(current.reason)}</pre></details>` : ''}${planStepsMarkup(current)}${history}${plan.outcome ? `<p class="plan-outcome">${escapeHtml(plan.outcome)}</p>` : ''}${['blocked', 'interrupted'].includes(plan.status) ? `<button class="text-button plan-retry" type="button" data-plan-retry="${escapeHtml(plan.id)}">用此目标重新规划</button>` : ''}`;
}

function renderKnowledge() {
  $('#knowledge-count').textContent = String(state.documents.length);
  $('#knowledge-documents').innerHTML = state.documents.length ? state.documents.map((document) => `<div class="knowledge-document"><button class="text-button knowledge-document-title" type="button" data-document-id="${escapeHtml(document.id)}">${escapeHtml(document.title)}</button><div class="knowledge-document-meta"><span>${document.threadId ? '本会话' : '工作区'} · ${document.chunkCount} 个片段</span><button class="text-button" type="button" data-delete-document="${escapeHtml(document.id)}" aria-label="移除 ${escapeHtml(document.title)}">移除</button></div></div>`).join('') : '<div class="empty-state compact">导入 TXT 或 Markdown，回答时可引用原文。</div>';
  $('#knowledge-results').innerHTML = $('#knowledge-query').value.trim() ? state.knowledgeHits.length
    ? state.knowledgeHits.map((hit) => `<div class="knowledge-result">${citationMarkup(hit.citation)}<div class="citation-meta">检索分数 ${Number(hit.score).toFixed(2)}</div></div>`).join('')
    : '<div class="empty-state compact">没有匹配片段，试试文档中的关键词。</div>' : '';
}

async function searchKnowledge(event) {
  event?.preventDefault();
  const query = $('#knowledge-query').value.trim();
  const threadId = state.selectedThreadId;
  const requestId = ++state.searchRefresh;
  if (!query || !threadId) { state.knowledgeHits = []; renderKnowledge(); return; }
  const payload = await api(`/api/knowledge/search?threadId=${encodeURIComponent(threadId)}&q=${encodeURIComponent(query)}`);
  if (state.selectedThreadId !== threadId || requestId !== state.searchRefresh) return;
  state.knowledgeHits = payload.hits ?? [];
  renderKnowledge();
}

function openKnowledgeDialog() {
  if (!state.selectedThreadId) return;
  state.knowledgeImportThreadId = state.selectedThreadId;
  $('#knowledge-form').reset();
  $('#knowledge-dialog').showModal();
}

async function loadKnowledgeFile() {
  const file = $('#knowledge-file').files[0];
  if (!file) return;
  if (!/\.(txt|md|markdown)$/i.test(file.name) || file.size > 800_000) throw new Error('请选择不超过 800 KB 的 TXT 或 Markdown 文本文件。');
  const content = await file.text();
  if (content.length > 200_000) throw new Error('单个文档最多 20 万字符。');
  if ($('#knowledge-file').files[0] !== file) return;
  $('#knowledge-title').value = file.name.slice(0, 200);
  $('#knowledge-source').value = file.name;
  $('#knowledge-content').value = content;
}

async function importKnowledge(event) {
  event.preventDefault();
  $('#knowledge-save').disabled = true;
  try {
    const payload = await api('/api/knowledge/documents', { method: 'POST', body: JSON.stringify({
      title: $('#knowledge-title').value.trim(), content: $('#knowledge-content').value,
      ...($('#knowledge-source').value.trim() ? { source: $('#knowledge-source').value.trim() } : {}),
      ...($('#knowledge-scope').value === 'thread' ? { threadId: state.knowledgeImportThreadId } : {}),
    }) });
    $('#knowledge-dialog').close();
    showToast(payload.duplicate ? '相同正文已存在，沿用已有文档。' : `已导入 ${payload.document.chunkCount} 个文档片段。`);
    await refreshAuxiliary();
  } finally { $('#knowledge-save').disabled = false; }
}

async function showDocument(documentId) {
  const threadId = state.selectedThreadId;
  const { document } = await api(`/api/knowledge/documents/${encodeURIComponent(documentId)}?threadId=${encodeURIComponent(threadId)}`);
  if (state.selectedThreadId !== threadId) return;
  $('#source-title').textContent = document.title;
  $('#source-meta').textContent = `${document.source} · ${document.chunkCount} 个片段 · ${document.threadId ? '本会话' : '工作区'}`;
  $('#source-text').textContent = document.content;
  if (!$('#source-dialog').open) $('#source-dialog').showModal();
}

async function deleteDocument(documentId) {
  const document = state.documents.find((item) => item.id === documentId);
  if (!document || !window.confirm(`移除知识文档“${document.title}”？已有回答中的引用摘录仍会保留。`)) return;
  await api(`/api/knowledge/documents/${encodeURIComponent(documentId)}?threadId=${encodeURIComponent(state.selectedThreadId)}`, { method: 'DELETE' });
  state.knowledgeHits = [];
  await refreshAuxiliary();
}

function openThreadDialog(type, messageId) {
  const thread = state.currentThread;
  if (!thread || thread.id !== state.selectedThreadId) return;
  state.threadAction = { type, threadId: thread.id, messageId };
  $('#thread-dialog-title').textContent = type === 'fork' ? '创建会话分支' : '重命名会话';
  $('#thread-name').value = type === 'fork' ? `${thread.title} · 分支`.slice(0, 120) : thread.title;
  $('#thread-dialog').showModal();
}

async function saveThreadDialog(event) {
  event.preventDefault();
  const action = state.threadAction;
  if (!action) return;
  const button = $('#thread-form button[type=submit]');
  button.disabled = true;
  try {
    const payload = await api(`/api/threads/${encodeURIComponent(action.threadId)}${action.type === 'fork' ? '/fork' : ''}`, {
      method: action.type === 'fork' ? 'POST' : 'PATCH', body: JSON.stringify({ title: $('#thread-name').value.trim(), ...(action.messageId ? { messageId: action.messageId } : {}) }),
    });
    $('#thread-dialog').close();
    if (action.type === 'fork') {
      state.showArchived = false;
      state.threadQuery = '';
      $('#show-archived').checked = false;
      $('#thread-search').value = '';
      await selectThread(payload.thread.id);
    } else {
      if (state.selectedThreadId === action.threadId) await refreshThread(action.threadId, false);
      await refreshThreads();
    }
  } finally { button.disabled = false; }
}

async function archiveThread() {
  const thread = state.currentThread;
  if (!thread || thread.id !== state.selectedThreadId || state.busy) return;
  await api(`/api/threads/${encodeURIComponent(thread.id)}`, { method: 'PATCH', body: JSON.stringify({ archived: !thread.archived }) });
  if (state.selectedThreadId === thread.id) await refreshThread(thread.id, false);
  await refreshThreads();
}

function setBusy(value, label = 'Agent 正在处理…') {
  state.busy = Boolean(value);
  const loading = !state.currentThread || state.currentThread.id !== state.selectedThreadId;
  const disabled = state.busy || loading || state.currentThread?.archived;
  $('#send-button').disabled = disabled;
  $('#message-input').disabled = disabled;
  $('#execution-mode').disabled = disabled;
  $('#archive-thread').disabled = state.busy || loading;
  $('#rename-thread').disabled = loading;
  $('#fork-thread').disabled = loading;
  $('#run-indicator').classList.toggle('hidden', !value);
  $('#run-label').textContent = label;
}

let refreshTimer;
function scheduleRefresh(threadId) {
  if (threadId !== state.selectedThreadId) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (threadId !== state.selectedThreadId) return;
    Promise.all([refreshThread(threadId, false), refreshAuxiliary()]).catch((error) => showToast(error.message, 'error'));
  }, 150);
}

function connectEvents(threadId) {
  state.source?.close();
  const after = state.events.at(-1)?.sequence ?? 0;
  const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?after=${after}&stream=1`);
  state.source = source;
  for (const eventName of EVENT_NAMES) {
    source.addEventListener(eventName, async (event) => {
      if (state.source !== source || state.selectedThreadId !== threadId) return;
      try {
        const record = JSON.parse(event.data);
        if (!state.events.some((item) => item.id === record.id)) state.events.push(record);
        state.events.sort((a, b) => a.sequence - b.sequence);
        state.events = state.events.slice(-500);
        renderTrace();
        if (eventName === 'agent.started') setBusy(true, `${record.payload?.agentName ?? 'Agent'} is thinking…`);
        if (eventName === 'plan.created') state.selectedPlanId = record.payload.planId;
        if (eventName === 'execution.completed') setBusy(state.pendingThreads.has(threadId));
        if (eventName.startsWith('plan.') || ['message.accepted', 'agent.completed', 'agent.failed', 'execution.completed'].includes(eventName)) scheduleRefresh(threadId);
      } catch {
        // Ignore malformed stream frames; the next HTTP refresh remains the
        // source of truth.
      }
    });
  }
  source.addEventListener('ready', (event) => {
    if (state.source !== source || state.selectedThreadId !== threadId) return;
    try { setBusy(Boolean(JSON.parse(event.data).busy) || state.pendingThreads.has(threadId)); } catch { /* next refresh restores the state */ }
  });
  source.onerror = () => {
    if (state.source !== source || state.selectedThreadId !== threadId) return;
    // EventSource reconnects automatically. Keep the UI usable while it does.
    if (!state.busy) $('#run-label').textContent = '实时轨迹重连中…';
    scheduleRefresh(threadId);
  };
}

async function refreshThread(threadId, connect = true) {
  const requestId = ++state.threadRefresh;
  const [payload, trace] = await Promise.all([
    api(`/api/threads/${encodeURIComponent(threadId)}`),
    api(`/api/threads/${encodeURIComponent(threadId)}/events`),
  ]);
  if (state.selectedThreadId !== threadId || requestId !== state.threadRefresh) return;
  state.currentThread = payload.thread;
  state.events = [...new Map([...(trace.events ?? []), ...state.events].filter((event) => event.threadId === threadId).map((event) => [event.id, event])).values()].sort((a, b) => a.sequence - b.sequence).slice(-500);
  renderThread();
  renderTrace();
  renderThreads();
  setBusy(Boolean(payload.busy) || state.pendingThreads.has(threadId));
  if (connect || !state.source) connectEvents(threadId);
}

async function refreshThreads() {
  const requestId = ++state.listRefresh;
  const filter = `${state.showArchived}|${state.threadQuery}`;
  const payload = await api(`/api/threads?archived=${state.showArchived ? '1' : '0'}&q=${encodeURIComponent(state.threadQuery)}`);
  if (requestId !== state.listRefresh || filter !== `${state.showArchived}|${state.threadQuery}`) return;
  state.threads = payload.threads ?? [];
  renderThreads();
}

async function refreshAuxiliary() {
  const threadId = state.selectedThreadId;
  if (!threadId) return;
  const requestId = ++state.auxiliaryRefresh;
  const [memoryPayload, taskPayload, documentPayload, planPayload] = await Promise.all([
    api(`/api/memories?threadId=${encodeURIComponent(threadId)}`),
    api(`/api/tasks?threadId=${encodeURIComponent(threadId)}`),
    api(`/api/knowledge/documents?threadId=${encodeURIComponent(threadId)}`),
    api(`/api/threads/${encodeURIComponent(threadId)}/plans`),
    refreshThreads(),
  ]);
  if (state.selectedThreadId !== threadId || requestId !== state.auxiliaryRefresh) return;
  state.memories = memoryPayload.memories ?? [];
  state.tasks = taskPayload.tasks ?? [];
  state.documents = documentPayload.documents ?? [];
  state.plans = planPayload.plans ?? [];
  renderMemories();
  renderTasks();
  renderKnowledge();
  renderPlans();
}

async function selectThread(threadId) {
  if (!threadId) return;
  try {
    if (state.currentThread?.id === state.selectedThreadId) {
      state.drafts.set(state.selectedThreadId, $('#message-input').value);
      state.draftModes.set(state.selectedThreadId, $('#execution-mode').value);
    }
    state.source?.close();
    state.source = null;
    clearTimeout(refreshTimer);
    state.selectedThreadId = threadId;
    state.selectedPlanId = null;
    state.currentThread = null;
    state.events = [];
    state.plans = [];
    state.documents = [];
    state.memories = [];
    state.tasks = [];
    state.knowledgeHits = [];
    state.searchRefresh += 1;
    $('#knowledge-query').value = '';
    $('#timeline').innerHTML = '<div class="empty-state">正在加载会话…</div>';
    $('#context-summary').classList.add('hidden');
    $('#message-input').value = state.drafts.get(threadId) ?? '';
    $('#execution-mode').value = state.draftModes.get(threadId) ?? 'chat';
    setBusy(true, '加载会话…');
    renderPlans();
    renderKnowledge();
    renderMemories();
    renderTasks();
    renderThreads();
    await refreshThread(threadId);
    await refreshAuxiliary();
    if (state.selectedThreadId === threadId) {
      try { localStorage.setItem('orbit.currentThread', threadId); } catch { /* storage may be disabled */ }
    }
  } catch (error) {
    if (state.selectedThreadId === threadId) {
      setBusy(false);
      $('#timeline').innerHTML = '<div class="empty-state">会话加载失败，请点击顶部刷新重试。</div>';
    }
    showToast(error.message, 'error');
  }
}

async function createThread() {
  try {
    const payload = await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: '未命名协作线程' }) });
    state.showArchived = false;
    state.threadQuery = '';
    $('#show-archived').checked = false;
    $('#thread-search').value = '';
    await selectThread(payload.thread.id);
    $('#message-input').focus();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitMessage(event) {
  event?.preventDefault();
  const input = $('#message-input');
  const draft = input.value.trim();
  const threadId = state.selectedThreadId;
  if (!draft || state.busy || !state.currentThread || state.currentThread.id !== threadId || state.currentThread.archived) return;
  let content = draft;
  const mode = $('#execution-mode').value;
  if (mode !== 'chat') {
    content = content.replace(/(^|\s)#(serial|parallel|discuss|plan)\b/gi, '$1').trim();
    content = `#${mode} ${mode === 'discuss' && !/@[\p{L}\p{N}_-]+/u.test(content) ? '@all ' : ''}${content}`;
  }
  input.value = '';
  state.drafts.delete(threadId);
  state.pendingThreads.add(threadId);
  setBusy(true, 'Routing and assembling context…');
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientRequestId: crypto.randomUUID?.() ?? String(Date.now()) }),
    });
  } catch (error) {
    state.drafts.set(threadId, draft);
    if (state.selectedThreadId === threadId) input.value = draft;
    showToast(error.message, 'error');
  } finally {
    state.pendingThreads.delete(threadId);
    // A late response for one thread must never replace another thread or draft.
    if (state.selectedThreadId === threadId) {
      try { await refreshThread(threadId, false); await refreshAuxiliary(); }
      catch (error) { setBusy(false); showToast(error.message, 'error'); }
    }
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
    renderKnowledge();
    renderPlans();
    $('#provider-label').textContent = state.provider?.mode === 'provider-registry' ? `${state.provider.providers?.length ?? 0} provider routes` : state.provider?.mode === 'local-demo' ? 'Local demo provider' : 'OpenAI-compatible provider';
    let savedThreadId;
    try { savedThreadId = localStorage.getItem('orbit.currentThread'); } catch { /* storage may be disabled */ }
    const first = state.threads.find((thread) => thread.id === savedThreadId) ?? state.threads[0];
    if (first) await selectThread(first.id);
    else showToast('没有可用线程', 'error');
  } catch (error) {
    showToast(`无法连接运行时：${error.message}`, 'error');
  }
}

const handleAction = (action) => async (...args) => {
  try { await action(...args); } catch (error) { showToast(error.message, 'error'); }
};

$('#new-thread').addEventListener('click', createThread);
$('#composer').addEventListener('submit', submitMessage);
$('#refresh-button').addEventListener('click', handleAction(async () => {
  if (!state.selectedThreadId) return;
  await selectThread(state.selectedThreadId);
}));
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#rename-thread').addEventListener('click', () => openThreadDialog('rename'));
$('#fork-thread').addEventListener('click', () => openThreadDialog('fork'));
$('#archive-thread').addEventListener('click', handleAction(archiveThread));
$('#thread-form').addEventListener('submit', handleAction(saveThreadDialog));
$('#timeline').addEventListener('click', (event) => {
  const button = event.target.closest('[data-fork-message]');
  if (button) openThreadDialog('fork', button.dataset.forkMessage);
});
let threadSearchTimer;
$('#thread-search').addEventListener('input', () => {
  state.threadQuery = $('#thread-search').value.trim();
  clearTimeout(threadSearchTimer);
  threadSearchTimer = setTimeout(handleAction(refreshThreads), 250);
});
$('#show-archived').addEventListener('change', handleAction(async (event) => { state.showArchived = event.target.checked; await refreshThreads(); }));
$('#import-knowledge').addEventListener('click', openKnowledgeDialog);
$('#knowledge-file').addEventListener('change', handleAction(loadKnowledgeFile));
$('#knowledge-form').addEventListener('submit', handleAction(importKnowledge));
$('#knowledge-search').addEventListener('submit', handleAction(searchKnowledge));
$('#knowledge-documents').addEventListener('click', handleAction(async (event) => {
  const view = event.target.closest('[data-document-id]');
  const remove = event.target.closest('[data-delete-document]');
  if (view) await showDocument(view.dataset.documentId);
  if (remove) await deleteDocument(remove.dataset.deleteDocument);
}));
$('#plan-select').addEventListener('change', (event) => { state.selectedPlanId = event.target.value; renderPlans(); });
$('#plan-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-plan-retry]');
  const plan = button && state.plans.find((item) => item.id === button.dataset.planRetry);
  if (!plan || state.busy || state.currentThread?.archived) return;
  $('#execution-mode').value = 'plan';
  $('#message-input').value = `${plan.participants.map((agentId) => '@' + agentId).join(' ')} ${plan.goal}`;
  $('#message-input').focus();
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#clear-memory-filter').addEventListener('click', () => refreshAuxiliary().catch((error) => showToast(error.message, 'error')));
document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const targets = { memory: '#memory-list', tasks: '#task-list', knowledge: '#knowledge-panel', plans: '#plan-panel', threads: '#timeline' };
    const target = $(targets[button.dataset.view] ?? '#timeline');
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

window.__orbitAgent = { state, selectThread, submitMessage };
boot();
