# Orbit Agent 实现文档

## 1. 文档范围

本文是代码级的实现说明：文件地图、启动装配顺序、逐模块走读、一轮请求的完整调用栈、扩展点改法、**已验证的已知问题清单**、测试与调试手册。

- 整体结构与边界 → [`ARCHITECTURE.md`](ARCHITECTURE.md)
- 能力清单与使用方式 → [`CORE-FEATURES.md`](CORE-FEATURES.md)

本文保留早期实现审计，其中 `.mjs` 文件地图、行数和 §8 问题清单对应当时版本。当前 TypeScript 入口、v0.3 新模块、API 与验证方法见 [SESSION-RAG-PLANNING.md](SESSION-RAG-PLANNING.md)。

## 2. 代码地图

```text
orbit-agent/
├── src/
│   ├── server.mjs                315 行  组装根 + HTTP/SSE 边界
│   └── core/
│       ├── types.mjs              48 行  枚举与基础校验
│       ├── ids.mjs                 6 行  带前缀 id
│       ├── agent-registry.mjs     82 行  身份与别名
│       ├── router.mjs             79 行  mention 解析与策略
│       ├── memory.mjs             91 行  分词、排序、上下文
│       ├── tools.mjs              65 行  工具 allow-list
│       ├── providers.mjs         152 行  模型适配与降级
│       ├── store.mjs             319 行  唯一持久化写入者
│       └── orchestrator.mjs      203 行  一轮执行的顺序拥有者
├── public/
│   ├── index.html                106 行  静态骨架
│   ├── app.js                    370 行  投影层
│   └── styles.css                        样式
├── scripts/check-syntax.mjs       29 行  对所有 .mjs + app.js 做 node --check
├── test/                                 5 个文件 · 11 个用例
└── data/state.json                       运行时状态（.gitignore）
```

依赖方向严格单向，无循环引用：

```text
server.mjs
  → orchestrator.mjs → router.mjs   ─┐
  → memory.mjs                       │
  → tools.mjs                        ├→ types.mjs
  → providers.mjs                    │  ids.mjs
  → agent-registry.mjs               │
  → store.mjs                       ─┘
```

`types.mjs` 和 `ids.mjs` 是叶子模块，不依赖任何项目内文件。改动它们会影响全部上层，改动 `server.mjs` 不影响任何人。

## 3. 启动与装配

唯一的组装根是 `createApp()`（`server.mjs:120-295`），装配顺序有依赖含义，不能随意调换：

```js
// ① 用默认 roster 建注册表
const registry = new AgentRegistry(DEFAULT_AGENTS);

// ② store 以注册表快照为播种数据（首次运行写入三个默认 Agent）
const store = new JsonStore(dataFile, { seedAgents: registry.list() });
await store.init();

// ③ 关键：把落盘的 Agent 反向灌回注册表
//    store 是跨重启的权威来源，DEFAULT_AGENTS 只负责首次引导
for (const agent of store.listAgents()) registry.register(agent);

// ④ 空仓库直接给一个可用线程，避免首屏空态
if (store.listThreads().length === 0) {
  await store.createThread({ title: '欢迎来到 Orbit Agent', activeAgentId: registry.default()?.id });
}

// ⑤ 上层服务
const memory = new MemoryService(store);
const tools  = createDefaultTools({ memory, store });
const orchestrator = new Orchestrator({ store, registry, memory, provider, tools });
```

③ 的顺序容易被误改。如果先建 Orchestrator 再灌回 Agent，通过 `POST /api/agents` 添加的身份在重启后会存在于 store 但不存在于内存注册表，路由会认不出它的 mention。

`createApp` 的两个注入点是测试的全部基础：

```js
createApp({
  dataFile: '/tmp/xxx/state.json',   // 隔离数据，不污染 data/state.json
  provider: { async complete() { … } },  // 假 Provider，不产生网络调用与费用
})
```

`start()` 只做监听并打印地址，默认绑定 `127.0.0.1`（`server.mjs:301`）。文件末尾的 `import.meta.url` 判断保证被 import 时不会自动起服务，这是 HTTP 测试能 import 本模块的前提。

## 4. 逐模块走读

### 4.1 `types.mjs` — 共享词汇

三个冻结枚举（`ROLE` / `EVENT` / `STRATEGY`）加三个工具函数。`asNonEmptyString(value, field)` 是全项目的入参校验原语：校验失败抛出带 `code: 'VALIDATION_ERROR'` 的 Error，由 `server.mjs` 统一映射为 400。返回值是 `trim()` 之后的字符串，调用方直接用返回值而不是原值。

新增事件类型必须先在 `EVENT` 里登记，再在 `app.js` 的 `EVENT_NAMES` 与 `TRACE_LABELS` 里补齐（§7.5）。

### 4.2 `ids.mjs` — 标识

```js
id('msg')  // → msg_3f9a1c2b8e7d4a06
```

`randomUUID()` 去掉连字符后取前 16 位（64 位随机）。前缀让日志和状态文件可读。**id 里不含序号**，序号由 store 单独维护，两者职责分离。

### 4.3 `agent-registry.mjs` — 身份

`DEFAULT_AGENTS` 是三个纯数据对象（Atlas / Forge / Lens），字段含 `systemPrompt` 与 `aliases`。`register()` 做规范化：

```js
id: asNonEmptyString(input.id).toLowerCase()          // id 强制小写
name: input.name ?? input.id
role: input.role ?? 'Agent'
aliases: [...new Set([id, ...aliases].map(lowercase))] // id 自动成为别名
```

维护两张表：`agents`（id → agent）与 `aliases`（别名 → id）。`get()` 先剥掉 `@`、trim、小写，再查别名表，未命中则把 key 当 id 直查。所以 `@ATLAS`、`@atlas`、`@架构师`、`@architect` 全部命中同一身份（已验证）。

`default()` 返回 `Map` 的第一个值——依赖 JS Map 的插入顺序，即 `DEFAULT_AGENTS[0]`（Atlas）。这是隐式约定：**改动 `DEFAULT_AGENTS` 的数组顺序会改变系统默认 Agent**。

### 4.4 `router.mjs` — 确定性路由

三个正则加一组广播别名：

```js
MENTION_RE = /@([\p{L}\p{N}_-]+)/gu        // Unicode 属性，支持中文别名
CONTROL_RE = /(^|\s)#(parallel|serial)\b/iu
ALL_ALIASES = new Set(['all', 'team', '全体', '所有人'])
```

`isMentionBoundary()` 是防误判的关键：检查 `@` 前一个字符，若是字母/数字/下划线/点/连字符则不算 mention。这让 `foo@forge.com`、`a@atlas` 都不会被当成路由指令（已验证）。

策略判定（`router.mjs:50-55`）的优先级：

```text
#serial 显式        → serial   （最高优先级，能压制 @all）
#parallel 显式      → parallel
broadcast(@all)     → parallel
targets.length > 1  → parallel
其余                → serial
```

已验证：`#serial @all 逐个来` → targets 三个、strategy `serial`；`#parallel @atlas …` → 单目标但 strategy `parallel`（单目标并行等价于串行，无害）。

`cleanContent` 的构造顺序：去控制标签 → 去**已识别的** mention → 压缩连续空格与空行 → trim。末尾有个 `|| text` 兜底：清洗后为空时回退原文。副作用是只发 `#parallel` 时 `cleanContent` 等于 `"#parallel"`（已验证），标签会漏进模型输入。见 §8 P3-3。

未识别的 mention 进 `unknown[]` 且**不从正文剥离**，模型能看到原始 `@xxx`。这是有意的：系统不猜用户意图，但保留上下文。

### 4.5 `memory.mjs` — 分词、排序、上下文

`terms(input)` 是零依赖分词器：

```js
// 拉丁：至少两字符的词
text.match(/[a-z0-9][a-z0-9_-]{1,}/g)
// CJK：单字 + 相邻双字（bigram）
'部署必须' → {部, 署, 必, 须, 部署, 署必, 必须}
```

bigram 让「部署」这类双字词能精确命中，不需要词典。停用词表只有 22 项，刻意小。

`rank()` 三项加权，命中数为 0 直接淘汰：

```js
overlap / q.size  +  importance * 0.18  +  exp(-ageDays/45) * 0.12
```

分母是**查询词数**而非记忆词数，所以长记忆不因长度受罚。`recencyBoost` 有个细节：`Date.parse` 失败时 `ageDays` 为 `NaN`，`Math.max(0, NaN)` 仍是 `NaN`，`Number.isFinite` 检查随后返回 0，不会污染总分。

`buildContext()` 返回三段：`recentMessages`（末 N 条，正文各截 6000 字符）、`memories`（检索结果）、`citations`（`memory:<id>` 形式）。线程不存在时返回三个空数组而非抛错——调用方无需额外判空。

`parseRememberCommand()` 用 `^` 锚定 + `s` 标志，要求命令位于消息开头。已验证 `@atlas 记住：x` 返回 `null`。见 §8 P2-2。

### 4.6 `tools.mjs` — 能力 allow-list

`ToolRegistry` 是 `Map` 加三个方法。两个约束写在 `register()` 里：名字必须非空、`execute` 必须是函数。

`list()` 用解构剥离 `execute` 再返回元数据，所以 `GET /api/tools` 不会泄漏实现引用：

```js
[...this.tools.values()].map(({ execute, ...metadata }) => metadata)
```

四个默认工具全部只触达 `memory` / `store`，每个都用 `asNonEmptyString` 校验必填参数。`execute()` 对未注册名抛 `TOOL_NOT_FOUND`，不做模糊匹配。

工具的 `context` 参数（`{ threadId, agentId }`）由 Orchestrator 传入，决定记忆/任务归属哪个线程。`remember` 会把 `agentId` 编码进 `source`：Orchestrator 传 `agentId: 'user'`，所以用户显式记忆的 source 是 `agent:user`（已验证）。

### 4.7 `providers.mjs` — 模型边界

三个类，一个工厂。

`LocalProvider.complete()` 按关键词分三支（架构/设计类、审查/风险类、其他），拼接固定文本并附上下文提示。它**不读 `agent.systemPrompt`**，只用 `agent.role` 做口吻区分——本地 Provider 的目标是链路可演示，不是回答质量。

`OpenAICompatibleProvider.complete()` 的失败判定比默认严格，三种都抛错：

```js
if (!this.apiKey) throw …                    // 未配置
if (!response.ok) throw …                    // 非 2xx，优先用网关的 error.message
if (!text.trim()) throw …                    // 空正文也算失败
```

超时用 `AbortController` + `setTimeout(45s)`，`finally` 里必定 `clearTimeout`，不泄漏定时器。响应 `content` 兼容字符串与分段数组两种形态。请求只发两条消息：system（agent 的 prompt）+ user（正文 + 最近对话 + 记忆），不做多轮 messages 数组——上下文由服务端显式拼装，模型侧无状态。

`FallbackProvider.complete()` 是组合器，主实现抛错则记 `lastError` 并转本地。`lastError` **成功后不会清空**，见 §8 P2-3。

`createProviderFromEnv()` 仅以 `OPENAI_API_KEY` 是否非空决定组合方式，`baseUrl` 末尾斜杠会被剥掉。

### 4.8 `store.mjs` — 唯一持久化写入者

**状态形状**（`emptyState()`）：`schemaVersion` / `meta` / 六个数组 / `eventSequence`。

**`normalizeState()`** 是向前兼容层：合并默认值、强制六个键为数组、`eventSequence` 非法时从事件里重算最大值。这让手工改坏的状态文件仍能启动。

**`init()`** 读文件 → `ENOENT` 视为空状态（其他错误上抛）→ 播种缺失的默认 Agent → 条件持久化。播种用 id 去重，已存在的 Agent 不会被默认值覆盖，用户改过的 `systemPrompt` 得以保留。

**`mutate()`** 是所有写操作的唯一通道（`store.mjs:107-116`）：

```js
const operation = this.writeChain.then(async () => {
  const result = await mutator(this.state);
  this.state.meta.updatedAt = nowIso();
  await this.persist();
  return clone(result);            // 深拷贝，调用方拿不到内部引用
});
this.writeChain = operation.catch(() => undefined);   // 失败不毒化写链
return operation;                  // 但错误照常抛给调用方
```

两个 Promise 的分叉是核心技巧：`writeChain` 拿被 `catch` 消化的版本（后续写不受阻），调用方拿原始版本（错误正常传播）。

**`persist()`** 写临时文件再 rename。Windows 上杀毒软件持有目标文件时 rename 会失败，退化为直接写并清理临时文件。catch 块末尾的 `if (!error) return;` 是死代码——catch 里 `error` 必然为真值。

**读方法**（`getAgent` / `listX` / `getThread` / `stats`）全部同步、直接读内存、返回 `structuredClone`。`getThread()` 顺带按 `sequence` 排序并附上全部消息。

**限额裁剪**发生在写入路径内，不是后台任务：消息超 500 条时剔除最旧（并修正 `messageCount`），事件超 1200 条时 `splice` 头部，记忆超 1000 条时截断尾部。

**`listMemories()` 的 limit 被 clamp 到最大 200**（`store.mjs:239`）——这行与 `MemoryService.search` 的 `limit: 1000` 冲突，是当前最严重的 bug，见 §8 P1。

### 4.9 `orchestrator.mjs` — 顺序拥有者

**`emit()`** 严格「先持久化后广播」：

```js
const event = await this.store.appendEvent({ threadId, type, payload });
this.events.emit(`thread:${threadId}`, event);
this.events.emit('event', event);
```

所以 SSE 推出去的事件一定已落盘，不存在「客户端看到了但重启后消失」。第二个 `'event'` 通道当前无订阅者，是留给全局审计的挂点。

**`subscribe()`** 按 `thread:<id>` 分频道，返回退订函数。`setMaxListeners(100)` 防止多标签页触发 Node 的 listener 泄漏警告。

**`submitMessage()`** 是并发闸门：

```js
const priorRun = this.activeRuns.get(threadId);
if (priorRun) return priorRun;          // 复用，不排队、不报错
const run = this._submit(…).finally(() => this.activeRuns.delete(threadId));
this.activeRuns.set(threadId, run);
```

`finally` 保证无论成败都清理，不会永久锁死线程。已验证：并发提交两条，第二条内容从未落盘，两次调用返回同一个结果对象。见 §8 P2-1。

**`runAgent()`** 的两条分支都写消息：成功写正文 + `agent.completed`；失败写一条中文说明 + `agent.failed`，并给返回值打 `failed: true`。**它不重新抛错**，所以并行分支里一个 Agent 挂掉不会让 `Promise.all` 整体 reject。串行模式下 `priorResults` 会把前序结果压缩到 500 字符注入下一个 Agent 的输入。

**`_submit()`** 按 §7 的顺序推进。三个易忽略的点：

- `parseRememberCommand` 和 `taskFromPrompt` 都作用于 **`safeContent`（原始输入，含 mention）**，而非 `route.cleanContent`。这是 §8 P2-2 的直接原因。
- 送给 Provider 的是 `route.cleanContent`（已剥离 mention 与控制标签）。
- `touchThread` 把 `activeAgentId` 设为 `route.targets.at(-1)`，所以广播后的默认 Agent 是 roster 最后一个（Lens）。

### 4.10 `server.mjs` — HTTP/SSE 边界

`headers()` 统一给出 `no-store` 与 CORS 头。`sendError()` 做错误码 → 状态码映射。

`readJson()` 边读边累加长度，超 1MB 立即抛 `VALIDATION_ERROR`，不等读完；空 body 返回 `{}` 而非报错。

`serveStatic()` / `serveDoc()` 的防穿越用 `normalize` + 前缀比较，分隔符按平台切换：

```js
if (!candidate.startsWith(`${PUBLIC_DIR}${process.platform === 'win32' ? '\\' : '/'}`))
```

已用原始 socket 发送未规范化路径验证（`/docs/../package.json`、`/docs/..%2fpackage.json`、`/..%2f..%2fpackage.json` 等 6 个变体）：**没有任何变体泄漏 `package.json`**。多数返回 200 是因为 Node 在路由前已规范化 `..`，随后落入 `index.html` 兜底。

路由用 `if` 链顺序匹配，先精确 `pathname` 再按 `parts` 段匹配。SSE 分支是唯一不立即结束响应的路径，它的顺序刻意为「先订阅、后补放」：

```js
const unsubscribe = orchestrator.subscribe(threadId, writeEvent);
for (const event of store.listEvents({ threadId, after })) writeEvent(event);   // 默认 limit 200
response.write(`event: ready\n…`);
const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
```

反过来（先补放后订阅）会丢掉两步之间产生的事件；当前顺序可能重复，由客户端按 `event.id` 去重。`close` 回调同时清理定时器与订阅，是防泄漏的必要一步。

### 4.11 `public/app.js` — 投影层

单个 `state` 对象 + 一组 `renderX()` 函数，无框架、无虚拟 DOM，每次全量重渲染对应区块。

`escapeHtml()` 覆盖 5 个字符，**所有**插入 DOM 的用户与模型文本都经过它。这是纯字符串拼 HTML 方案下唯一的 XSS 防线，改动渲染函数时必须保持。

`connectEvents()` 为 8 个事件类型各注册监听，收到后按 `id` 去重、按 `sequence` 排序、重渲染轨迹。`agent.started` 切换忙碌文案，`execution.completed` 触发重新拉取。

`submitMessage()` 的关键注释解释了为什么不直接用 HTTP 响应体拼时间线：SSE 的 `execution.completed` 可能先到，手工合并会产生重复消息。所以统一「重新读线程」为准。

`onerror` 只改文案不重连——`EventSource` 自带重连。但 `connectEvents` 固定用 `after=0`，浏览器自动重连时也不带 `Last-Event-ID`，所以每次重连都重放最近 200 条事件，靠去重消化。功能正确，代价是冗余传输。

## 5. 一轮请求的完整调用栈

用户输入 `@all 设计一个可测试的执行闭环\n任务：写测试`：

```text
app.js  submitMessage()
  └─ POST /api/threads/thr_x/messages  { content, clientRequestId }
      │
      server.mjs  readJson()                      ≤1MB 校验
      └─ orchestrator.submitMessage(threadId, content, { clientRequestId })
          ├─ asNonEmptyString(content)
          ├─ store.getThread()                     不存在 → 404
          ├─ activeRuns 检查                       已有在途 → 复用 Promise 并返回
          └─ _submit()
              ├─ store.appendMessage(role=user)   ─► mutate → persist
              │   └─ emit(message.accepted)       ─► appendEvent → SSE
              ├─ router.route()                    → targets[atlas,forge,lens] strategy=parallel
              │   └─ emit(route.decided)
              ├─ memory.parseRememberCommand()     → null（本例无记忆命令）
              ├─ memory.buildContext(threadId, cleanContent, {14, 6})
              │   ├─ store.getThread()             → 末 14 条消息
              │   ├─ memory.search()               → store.listMemories({limit:1000}) ⚠ 被 clamp 到 200
              │   └─ emit(context.retrieved)
              ├─ Promise.all([
              │     runAgent(atlas) ─► emit(agent.started) → provider.complete()
              │                        → store.appendMessage(assistant) → emit(agent.completed)
              │     runAgent(forge) ─► 同上（并发，相互不可见）
              │     runAgent(lens)  ─► 同上
              │   ])
              ├─ taskFromPrompt()                  → "写测试"
              │   └─ tools.execute('create_task', { title, owner: 'atlas' })
              │       └─ store.createTask() → emit(tool.called)
              ├─ store.appendMessage(role=system)  协作摘要（targets>1）
              ├─ store.touchThread({ activeAgentId: 'lens' })
              └─ emit(execution.completed)         含 latencyMs / failedCount / taskId
      │
      └─ HTTP 200 { userMessage, route, context, messages, coordinationMessage, task }
          │
          app.js  refreshThread()                  重新读线程（不拼响应体）
               └─ refreshAuxiliary()               刷新记忆 / 任务 / 线程列表
```

已验证的事件顺序（`@all` 三目标）：

```text
message.accepted → route.decided → context.retrieved
→ agent.started ×3 → agent.completed ×3 → execution.completed
```

注意本例中 `agent.started` 三条连续出现在 `agent.completed` 之前，因为假 Provider 无延迟；真实场景下两者会交错。

## 6. 扩展点改法

### 6.1 加一个 Agent

改 `DEFAULT_AGENTS`（`agent-registry.mjs:8-45`）追加对象，或运行时 `POST /api/agents`。必填 `id` / `name` / `role`，建议给 `aliases`、`emoji`、`color`、`systemPrompt`。

注意三点：`id` 会被强制小写；`DEFAULT_AGENTS[0]` 是系统默认 Agent，插入位置有语义；`@all` 会把新 Agent 纳入广播，扇出成本随 roster 线性增长。

### 6.2 加一个工具

在 `createDefaultTools()`（`tools.mjs:30-64`）链上追加：

```js
.register({
  name: 'summarize_thread',
  description: '给当前线程生成结论摘要',
  inputSchema: { type: 'object' },
  execute: async ({ limit = 20 } = {}, context = {}) => {
    const thread = store.getThread(context.threadId);
    return thread.messages.slice(-limit).map((m) => m.content);
  },
})
```

约束：只能触达注入的 `memory` / `store`，不要引入 shell、`fs`、`fetch`；必填参数用 `asNonEmptyString` 校验；`inputSchema` 目前只作元数据展示，**不做运行时校验**，参数检查得自己写。

工具注册后不会被自动调用——Orchestrator 只在固定点调工具。要接入新触发条件，得在 `_submit()` 里加解析分支并配 `tool.called` 事件。

### 6.3 换 Provider

实现一个方法即可：

```js
class MyProvider {
  async complete({ agent, content, context }) {
    return { content: '…', citations: [], provider: 'mine', model: 'x', usage: null };
  }
}
createApp({ provider: new FallbackProvider(new MyProvider(), new LocalProvider()) });
```

`content` 必须非空字符串（下游 `appendMessage` 会校验）。包一层 `FallbackProvider` 就自动获得降级能力。

### 6.4 换存储

`JsonStore` 的公开契约是 17 个方法（`getAgent` / `listAgents` / `saveAgent` / `createThread` / `getThread` / `listThreads` / `touchThread` / `appendMessage` / `addMemory` / `listMemories` / `createTask` / `updateTask` / `listTasks` / `appendEvent` / `listEvents` / `stats` / `init`）。换 SQLite 需保持：

- 读方法同步（当前调用方都不 await 读操作）——这是最强的约束；改成异步需同步修改 `server.mjs`、`memory.mjs`、`orchestrator.mjs` 的全部读点。
- `appendEvent` 的 `sequence` 全局单调递增。
- `appendMessage` 的 `sequence` 线程内递增。
- 返回值是拷贝，调用方修改不影响存储。

### 6.5 加一个事件类型

四处同步改：

1. `types.mjs` 的 `EVENT` 加常量；
2. Orchestrator 在正确位置 `emit`；
3. `app.js` 的 `EVENT_NAMES` 加字符串（否则 SSE 监听不到）；
4. `app.js` 的 `TRACE_LABELS` 加标签（否则轨迹显示原始类型名）。

漏掉 3 是最常见的错误：事件正常落盘，`GET /events` 能读到，但实时轨迹里不出现。

## 7. 测试

```bash
npm test        # node --test，11 个用例
npm run check   # node --check 语法校验 11 个文件
```

无需密钥或外部服务。`test/` 的通用套路：

```js
const root = await mkdtemp(join(tmpdir(), 'orbit-agent-xxx-'));
t.after(() => rm(root, { recursive: true, force: true }));   // 必须清理
const store = new JsonStore(join(root, 'state.json'), { seedAgents });
await store.init();
```

三条约定：数据文件永远放 `mkdtemp` 目录，绝不用 `data/state.json`；`t.after` 注册清理；需要模型时注入假 Provider，不依赖 `LocalProvider` 的具体文案。

HTTP 测试用 `server.listen(0)` 取随机端口，避免并行冲突：

```js
const { server } = await createApp({ dataFile: join(root, 'state.json') });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
t.after(() => new Promise((resolve) => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
```

当前覆盖与缺口：

| 已覆盖 | 未覆盖 |
| --- | --- |
| mention 解析、策略、邮箱防误判 | SSE 流式与断线续传 |
| 记忆排序、中文命令解析 | Provider 降级路径（`FallbackProvider`） |
| 重启持久性、并发写 | 限额裁剪（500/1200/1000 条边界） |
| 广播扇出、任务创建、失败恢复 | 同线程并发提交语义 |
| health / bootstrap / 一轮消息 / 任务 PATCH | 静态资源与路径穿越防护 |

§8 的问题里，P1 与 P2-1 都属于「未覆盖」区域，这不是巧合——补测试的优先级应对齐这张表的右列。

## 8. 已知问题清单

按严重程度排序。每条都标了验证方式；「已验证」指我在当前代码上实际跑出该行为。

### P1 — 超过 200 条后的记忆永久无法召回

**现象**：`MemoryService.search()` 调用 `store.listMemories({ limit: 1000 })`（`memory.mjs:56`），但 `listMemories` 把 limit clamp 到最大 200（`store.mjs:239`：`clamp(Number(limit) || 50, 1, 200)`）。记忆以「新在前」插入，因此**只有最新 200 条参与检索**。存储上限是 1000 条，第 201–1000 条仍占空间、仍在 `GET /api/memories` 里可见，但永远不会被召回，也不会进入模型上下文。

**验证**：写入 200 条填充记忆 + 1 条含 `deploy review` 的旧记忆（位于第 201 位之后），`search('deploy review')` 命中 0 条；把同一条记忆改为最新写入则立即命中。另外确认 `listMemories({limit:1000})` 在存有 300 条时只返回 200 条。

**影响**：这是核心卖点「有限记忆 + 可召回」的静默失效。用户会认为记忆已保存（UI 确实显示），但它不再影响任何回答。到达阈值前无任何提示。

**修复方向**：给 `listMemories` 增加不 clamp 的内部读取路径（例如 `listAllMemories()` 或让 `search` 直读 `state.memories`），把 200 的 clamp 保留在 HTTP 边界而不是领域读取上。修复后应补一条测试：写入 250 条，断言第 1 条仍可被召回。

### P2-1 — 同线程并发提交静默丢弃第二条内容

**现象**：`submitMessage` 发现线程已有在途 run 时直接 `return priorRun`（`orchestrator.mjs:121-123`）。第二个请求拿到第一轮的结果，**它自己的 `content` 从未被持久化，也没有任何错误返回**。

**验证**：并发提交 `FIRST message` 与 `SECOND message`，两次调用返回同一个对象，线程里只有 1 条 user 消息（内容为 `FIRST message`）；第一轮结束后再提交则正常开启新 run。

**影响**：前端因为 `setBusy()` 禁用输入框，正常操作不会触发；但多标签页、API 直调、或前端状态失步时会静默丢消息——用户看到 200 与一份回答，误以为自己那条已被处理。

**修复方向**：三个选项。(a) 返回 409 让调用方重试；(b) 真正排队而非复用；(c) 用已有但未使用的 `clientRequestId` 做幂等键——相同 id 复用结果，不同 id 排队。选 (c) 时注意 `clientRequestId` 目前只写进 metadata，不参与任何判断。

### P2-2 — 记忆与任务命令必须位于消息开头

**现象**：`parseRememberCommand` 用 `^…$` 加 `s` 标志锚定整串（`memory.mjs:85`），且 Orchestrator 传入的是**原始 `safeContent`（含 mention）**而非 `route.cleanContent`。`taskFromPrompt` 用 `(?:^|\n)` 加 `m` 标志，容忍独立行但同样不容忍前置 mention。

**验证**：

| 输入 | 记忆命令 | 任务命令 |
| --- | --- | --- |
| `记住：部署必须先通过 review` | ✅ 命中 | — |
| `@atlas 记住：部署必须先通过 review` | ❌ null | — |
| `先说一句\n记住：…` | ❌ null | — |
| `任务：补充测试` | — | ✅ 命中 |
| `@atlas 任务：补充测试` | — | ❌ null |
| `先说一句\n任务：补充测试` | — | ✅ 命中 |
| `任务：第一行\n任务：第二行` | — | 仅命中「第一行」 |

**影响**：`@atlas 记住：X` 是很自然的写法，但它会被当作普通消息发给模型，记忆没有写入且无提示。两个命令的锚定规则还不一致，用户难以形成稳定心智模型。

**修复方向**：改为解析 `route.cleanContent`（mention 已被剥离），并统一两者的锚定规则为 `(?:^|\n)` + `m`。多条任务命令是否全部创建属于产品决策，需先定义。

### P2-3 — `FallbackProvider.lastError` 成功后不清空

**现象**：`lastError` 只在 catch 里赋值（`providers.mjs:131`），成功路径不重置。一次网关抖动后，`/api/bootstrap` 会永久返回那条旧错误。

**验证**：代码路径审查（无成功分支的重置语句）。

**影响**：UI 的 Provider 状态出现误导性的持久告警，用户无法区分「仍在故障」与「早已恢复」。

**修复方向**：`complete()` 成功后 `this.lastError = null`；若想保留历史，改为 `lastErrorAt` 时间戳加连续失败计数。

### P3 — 小瑕疵

1. **轨迹里看不到失败原因**（`app.js:168-169`）：`traceDetail()` 的 `agent.started || agent.completed || agent.failed` 分支先命中并返回 `agentName`，下一行专门处理 `agent.failed` 的 `return payload.error` 成为**不可达代码**。错误信息已在事件 payload 里，UI 却从不显示。调换两个 `if` 即可。
2. **未匹配的静态路径返回 200 + `index.html`**（`server.mjs:88-90`）：为将来的前端路由预留，代价是拼错的资源路径不以 404 暴露。已验证 `/definitely-not-here.css` 返回 200 且正文为 HTML。
3. **单独使用控制标签时标签会漏进模型输入**：只发 `#parallel` 时清洗结果为空，`|| text` 兜底把原文（含 `#parallel`）还给了 Provider。已验证。
4. **`runId` 无法关联**（`orchestrator.mjs:52`）：`id('run')` 在 `agent.started` 的 payload 里现场生成，`agent.completed` / `agent.failed` 都用 `messageId` 关联。已验证：一轮 `@all` 中只有 3 条 `agent.started` 携带 `runId`。要么把 `runId` 提到 `runAgent` 顶部并贯穿三个事件，要么删掉这个字段。
5. **`persist()` 里的死代码**（`store.mjs:103`）：`if (!error) return;` 位于 catch 块内，`error` 必然为真值。
6. **SSE 补放与一次性读取的 limit 不一致**：SSE 走 `listEvents` 默认 200，`GET /events` 显式传 500。重连时可能少补 300 条；因为紧接着会 `refreshThread` 全量拉取，实际不出错，但两处应对齐。
7. **重连总是重放**：`connectEvents` 固定 `after=0` 且不使用 `Last-Event-ID`，每次重连重传最近 200 条事件，靠客户端去重消化。

### 不是问题（已验证的正确行为）

避免被误报：

- **路径穿越防护有效**。6 个变体（含 `..%2f`、`%2e%2e`）均未泄漏 `package.json`。
- **邮箱与标识符不误判为 mention**。`foo@forge.com`、`a@atlas` 都不触发路由。
- **重复 mention 会去重**。`@atlas @atlas` → 单目标。
- **大小写与中文别名正常**。`@ATLAS`、`@架构师` 均命中 Atlas。
- **`#serial` 能压制 `@all`**。三目标 + 串行策略。
- **并发写不丢记录**。12 条并发 `addMemory` 全部落盘。
- **单 Agent 失败不影响其余目标**。三目标中一个抛错，仍返回 3 条消息、`execution.completed` 正常。

## 9. 调试手册

**先看状态文件。** `data/state.json` 是人类可读的完整真相，比加日志快：

```bash
node -e "const s=require('./data/state.json');console.log(s.threads.length,'threads',s.messages.length,'messages',s.events.length,'events')"
```

**按事件类型定位故障域**，这是可观测性设计的直接回报：

| 症状 | 最后出现的事件 | 结论 |
| --- | --- | --- |
| 消息没进时间线 | 无 `message.accepted` | 传输/校验层，看 HTTP 状态码 |
| 回答来自错误的 Agent | 有 `route.decided` | 看 payload 的 `targets` / `unknown` / `reason` |
| 模型看不到应有的记忆 | 有 `context.retrieved` | 看 `memoryCount`；为 0 且记忆总数 > 200 → §8 P1 |
| 回答内容异常 | 有 `agent.completed` | Provider 侧，看消息 metadata 的 `provider` / `model` |
| 回答是失败说明 | 有 `agent.failed` | 看事件 payload 的 `error`（注意 UI 不显示，见 P3-1） |
| 一轮没有收尾 | 无 `execution.completed` | Orchestrator 抛错，看服务端 stderr |

**确认 Provider 实际走了哪条路**：

```bash
curl -s http://127.0.0.1:3030/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).provider))"
```

`mode: 'local-demo'` 说明没读到 `OPENAI_API_KEY`；`lastError` 非空说明至少发生过一次降级（但可能早已恢复，见 P2-3）。也可以看消息 metadata 里的 `provider` 字段，`local` 表示这条回答是降级产物。

**重置状态**：停进程后删 `data/state.json`，下次启动会重建默认 Agent 与欢迎线程。删除前确认没有要留的对话——没有回收站。

**排查前端**：`window.__orbitAgent` 暴露了 `state`、`selectThread`、`submitMessage`，可在控制台直接查当前投影与手工触发一轮。

**注意开发模式的副作用**：`npm run dev` 用 `node --watch`，改动 `src/` 会重启进程。重启会重读状态文件，但会**丢掉内存里的 SSE 订阅**，前端需等自动重连。

## 10. 编码约定

从现有代码归纳，改动时保持一致：

- **纯 ESM**，`.mjs` 扩展名，`package.json` 声明 `"type": "module"`。
- **零运行时依赖。** 只用 Node 内置模块。加依赖前先确认标准库无法解决。
- **入参校验用 `asNonEmptyString`**，抛带 `code` 的 Error（`VALIDATION_ERROR` / `NOT_FOUND`），由 `server.mjs` 统一映射状态码。
- **限额用模块顶层常量**并加数字分隔符（`1_000_000`），不要散落魔法数字。
- **注释解释「为什么」，不解释「是什么」。** 现有注释几乎都在说明某个非显然选择的原因（Windows rename 降级、先订阅后补放、不拼响应体），密度低但信息量高。保持这个风格。
- **面向用户的文本用中文，代码标识符、事件类型、日志用英文。**
- **读方法同步、写方法 async。** 这是 store 契约的一部分。
- **返回拷贝不返回内部引用。** store 全部读方法都 `structuredClone`。
- 改完跑 `npm test && npm run check`。
