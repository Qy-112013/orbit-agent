# Orbit Agent 架构设计文档

## 1. 文档范围

本文描述 Orbit Agent 运行时的整体结构：分层、模块职责、领域模型、执行生命周期、事件契约、并发与失败模型、容量限额和安全边界。

- 想知道「有哪些能力、怎么用」→ [`CORE-FEATURES.md`](CORE-FEATURES.md)
- 想知道「代码具体怎么写的、怎么改」→ [`IMPLEMENTATION.md`](IMPLEMENTATION.md)
- 想知道「为什么只做这些」→ [`PRODUCT-SCOPE.md`](PRODUCT-SCOPE.md)
- 想知道「架构调研来源」→ [`ARCHITECTURE-AUDIT.md`](ARCHITECTURE-AUDIT.md)、[`ORIGIN-NOTES.md`](ORIGIN-NOTES.md)

代码规模参考：`src/` 下 9 个模块 + 1 个前端文件，零运行时依赖，Node.js 20+ 直接启动。

## 2. 设计目标与非目标

### 目标

1. **一次请求的链路完全可解释。** 用户发一条消息后，路由、上下文、模型调用、持久化四个环节各自留下可查询的记录，定位问题不需要读日志或加断点。
2. **模型是可替换的一步，不是系统的中心。** Provider 失败、超时、返回空结果都不能破坏线程状态。
3. **克隆即可运行。** 不需要密钥、数据库、缓存服务或包管理器安装步骤。
4. **边界优先于功能量。** 单一持久化写入者、单一编排入口、显式工具 allow-list，让后续替换存储或检索方案不需要改动编排和 HTTP 契约。

### 非目标（当前版本明确不做）

- 多用户认证、组织权限、租户隔离；
- 任意 shell/PTY 执行、自动改写用户仓库；
- 分布式部署、水平扩展、跨进程共享状态；
- 向量检索、embedding pipeline、模型 token 流式输出；
- 插件市场、审批工作流、定时调度。

这些不是「永远不做」，而是当前架构刻意留出的扩展位，见 §18。

## 3. 质量属性与对应机制

| 质量属性 | 具体要求 | 实现机制 | 代码位置 |
| --- | --- | --- | --- |
| 可观测性 | 每轮执行可回放，断线可续传 | 持久化事件 + 单调 sequence + SSE `after=` | `store.appendEvent` / `server.mjs:215-248` |
| 可恢复性 | 模型失败不丢历史 | Provider 降级 + 失败也写入 assistant 消息 | `providers.mjs:119-135` / `orchestrator.mjs:87-108` |
| 一致性 | 并发写不丢记录 | 单写入者 + 串行化写队列 + 临时文件 rename | `store.mjs:88-116` |
| 确定性 | 路由不依赖模型猜测 | 正则解析 mention/控制标签 | `router.mjs` |
| 有界性 | 上下文、事件、消息、请求体全部有上限 | 常量化限额（§14） | 各模块常量 |
| 可替换性 | 存储/检索/模型可单独替换 | 三个窄接口（store 方法、`search/buildContext`、`complete`） | §10-§12 |
| 可测试性 | 核心路径黑盒可测 | 5 个测试文件覆盖 router/memory/store/orchestrator/HTTP | `test/` |

## 4. 系统上下文

```text
                 ┌──────────────────────────────┐
                 │  Browser (vanilla JS)        │
                 │  唯一的用户入口，只做投影      │
                 └──────────┬───────────────────┘
                            │ HTTP JSON + SSE (127.0.0.1:3030)
                 ┌──────────▼───────────────────┐
    可选外部依赖  │  Orbit Agent (single Node    │   本地文件系统
  ┌─────────────►│  process, no deps)           ├──────────────►
  │  HTTPS       └──────────────────────────────┘   data/state.json
  │
┌─┴──────────────────────────┐
│ OpenAI-compatible gateway  │  只在配置了 OPENAI_API_KEY 时启用
└────────────────────────────┘
```

外部依赖只有两个，且都可失效：

- **模型网关**：未配置或调用失败时降级到内置 `LocalProvider`，功能链路完整。
- **文件系统**：唯一持久化目标，路径可通过 `createApp({ dataFile })` 注入（测试即用此注入临时目录）。

进程默认只监听 `127.0.0.1`（`server.mjs:301`），不对外暴露。

## 5. 分层与模块

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Projection 层   public/index.html · app.js · styles.css                │
│ 线程列表 / 时间线 / Agent roster / Execution trace / Memory / Tasks     │
│ 不持有权威状态：所有写操作都走 API，读以服务端返回为准                    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP + SSE
┌───────────────────────────────▼───────────────────────────────────────┐
│ Transport 层   src/server.mjs                                          │
│ 组装根 · 路由分发 · 请求体上限 · 错误码映射 · 静态资源与目录穿越防护      │
│ SSE 生命周期（先订阅后补放 · 心跳 · 关闭清理）                           │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│ Orchestration 层   src/core/orchestrator.mjs                           │
│ 一轮执行的顺序拥有者：写入用户消息 → 路由 → 记忆写入 → 组装上下文        │
│ → 串行/并行调用 → 任务抽取 → 协作摘要 → 更新 active agent → 收尾事件    │
│ 每线程至多一个在途 run                                                  │
└──┬──────────┬──────────┬───────────┬──────────────┬───────────────────┘
   │          │          │           │              │
┌──▼───────┐ ┌▼────────┐ ┌▼────────┐ ┌▼───────────┐ ┌▼────────────────┐
│ Router   │ │ Memory  │ │ Tool    │ │ Provider   │ │ AgentRegistry   │
│ 目标+策略 │ │ 召回+   │ │ Registry│ │ 模型适配   │ │ 稳定身份+别名    │
│          │ │ 上下文  │ │ allow-  │ │ + 降级     │ │                 │
│          │ │         │ │ list    │ │            │ │                 │
└──────────┘ └───┬─────┘ └───┬─────┘ └────────────┘ └─────────────────┘
                 │           │
              ┌──▼───────────▼──────────────────────────────────────┐
              │ Persistence 层   src/core/store.mjs (JsonStore)      │
              │ 唯一持久化写入者 · 串行化写队列 · 原子落盘 · 限额裁剪  │
              └─────────────────────────────────────────────────────┘
```

### 模块职责边界

| 模块 | 拥有 | 不拥有 |
| --- | --- | --- |
| `types.mjs` | 角色、事件类型、策略枚举与基础校验 | 任何状态 |
| `ids.mjs` | 带前缀的短 id 生成 | 序号（序号由 store 管理） |
| `agent-registry.mjs` | Agent 身份、别名索引、默认 Agent | 模型调用、对话历史 |
| `router.mjs` | mention 解析、执行策略、清洗后的正文 | 模型参与的决策、状态写入 |
| `memory.mjs` | 词法排序、引用生成、上下文窗口裁剪 | 除 `addMemory` 外的持久化写 |
| `tools.mjs` | 能力 allow-list 与输入分发 | 任意 shell / 网络访问 |
| `providers.mjs` | 模型适配契约、超时、降级 | 线程与消息的修改 |
| `store.mjs` | 全部持久化状态与限额裁剪 | 路由决策、UI 状态 |
| `orchestrator.mjs` | 执行顺序与事件发布 | 渲染、传输细节 |
| `server.mjs` | HTTP/SSE 边界、依赖组装、输入校验 | 业务决策 |

判断一个改动是否越界的规则：**新增能力必须落在已有边界之内**。如果它需要第二个持久化写入者，或第二套事件词汇表，先重新审视设计（见 `ARCHITECTURE-AUDIT.md` 的复杂度预算）。

## 6. 领域模型

六种实体，全部存在同一个 JSON 文档里，无外键约束，靠 id 字符串关联。

```text
Agent ──owner──► Task
  ▲                ▲
  │ agentId        │ threadId
  │                │
Message ──threadId──► Thread ◄──threadId── Memory
  │                     ▲
  │                     │ threadId
  └──────► Event ───────┘
```

| 实体 | id 前缀 | 关键字段 | 生命周期 |
| --- | --- | --- | --- |
| Agent | 无（人类可读 id，如 `atlas`） | `name` `role` `emoji` `color` `systemPrompt` `aliases[]` | 由默认 roster 播种，可通过 API 新增；不删除 |
| Thread | `thr_` | `title` `activeAgentId` `messageCount` `updatedAt` `metadata` | 手动创建；不删除；按 `updatedAt` 倒序列出 |
| Message | `msg_` | `sequence`（线程内递增）`role` `agentId?` `content` `citations[]` `metadata` | 追加写；单线程超过 500 条时裁剪最旧 |
| Memory | `mem_` | `text` `source` `threadId?` `importance` `tags[]` | 追加写（新在前）；超过 1000 条截断尾部 |
| Task | `task_` | `title` `status(todo/doing/done)` `owner?` `threadId?` | 可 PATCH 更新标题/负责人/状态 |
| Event | `evt_` | `sequence`（**全局**递增）`threadId` `type` `payload` | 追加写；超过 1200 条丢弃最旧 |

两个容易踩的语义点：

- **Message.sequence 是线程内序号，Event.sequence 是全局序号。** 因此单个线程的事件序号并不连续，`after=` 续传只要求「严格大于」，不假设连续。
- **`threadId` 为空的 Memory / Task 是全局记录**，在任何线程都会被列出；带 `threadId` 的只在该线程可见（`store.mjs:238` / `store.mjs:283`）。

## 7. 一轮执行的生命周期

以 `POST /api/threads/:id/messages` 为例（`orchestrator.mjs:111-201`）：

```text
① server.readJson         请求体 ≤ 1MB，非法 JSON → 400 VALIDATION_ERROR
② submitMessage           内容非空校验；线程不存在 → 404 NOT_FOUND
                          线程已有在途 run → 直接复用该 Promise（不排队、不报错）
③ appendMessage(user)     持久化用户消息  ─────► message.accepted
④ router.route()          解析 @mention / #serial|#parallel
                          → targets[] + strategy + cleanContent ──► route.decided
⑤ parseRememberCommand    命中「记住：…」→ tools.execute('remember') ──► tool.called
⑥ memory.buildContext()   最近 14 条消息 + 命中的 6 条记忆 ──► context.retrieved
⑦ 执行
   parallel(且 targets>1)  Promise.all，各 Agent 相互不可见
   serial                  依次执行，把前序结果摘要注入下一个 Agent 的输入
   每个 Agent：            ──► agent.started
                          provider.complete() → appendMessage(assistant)
                          成功 ──► agent.completed / 失败 ──► agent.failed
⑧ taskFromPrompt          命中「任务：…」→ tools.execute('create_task') ──► tool.called
⑨ 协作摘要                targets > 1 时追加一条 system 消息
⑩ touchThread             activeAgentId := targets.at(-1)
⑪ 收尾                    ──► execution.completed（含 latencyMs / failedCount / taskId）
⑫ HTTP 200                { userMessage, route, context, messages, coordinationMessage, task }
```

关键设计选择：

- **用户消息先落盘再路由。** 即使后续全部失败，用户输入也不会丢。
- **事件在每一步之后立即持久化并广播**，而不是在结束时批量写，所以 UI 能看到中间态（"Atlas is thinking…"）。
- **HTTP 响应与 SSE 事件是同一份数据的两个投影。** 前端不依赖响应体拼接时间线，而是在 `execution.completed` 后重新拉取线程（`app.js:313-318`），避免两条通道竞态导致消息重复。

## 8. 事件契约

事件类型集中定义在 `types.mjs:16-25`，前端标签映射在 `app.js:147-156`。

| 顺序 | 类型 | payload | 用途 |
| --- | --- | --- | --- |
| 1 | `message.accepted` | `messageId` `contentLength` | 确认输入已持久化 |
| 2 | `route.decided` | `targets[]` `strategy` `mentions[]` `unknown[]` `reason` | 解释「为什么是这些 Agent」 |
| — | `tool.called` | `tool` + 工具相关 id | 记忆写入 / 任务创建 |
| 3 | `context.retrieved` | `memoryCount` `messageCount` `citations[]` | 解释「模型看到了什么」 |
| 4a | `agent.started` | `runId` `agentId` `agentName` `strategy` | 每个目标一次 |
| 4b | `agent.completed` | `messageId` `agentId` `agentName` `provider` `latencyMs` | 成功分支 |
| 4c | `agent.failed` | `messageId` `agentId` `agentName` `latencyMs` `error` | 失败分支，线程仍可用 |
| 5 | `execution.completed` | `strategy` `targets[]` `messageIds[]` `failedCount` `taskId` `latencyMs` | 一轮闭环 |

保证与不保证：

- **保证**：`sequence` 全局单调递增；每个事件先持久化后广播（`orchestrator.mjs:40-45`），所以 SSE 收到的事件一定已经落盘；每轮以 `message.accepted` 开始、以 `execution.completed` 结束。
- **保证**：并行分支内 `agent.started/completed` 的相对顺序不确定，但都在 `context.retrieved` 之后、`execution.completed` 之前。
- **不保证**：事件永久保留。全局只保留最近 1200 条，历史轨迹会被裁剪，消息本身不会。
- **不保证**：`runId` 与后续事件关联。当前每次 `runAgent` 只在 `agent.started` 里生成一个 `runId`，完成事件用 `messageId` 关联（见 `IMPLEMENTATION.md` 已知问题）。

### 断线续传语义

```text
GET /api/threads/:id/events            → 一次性读取（最多 500 条）
GET /api/threads/:id/events?stream=1   → SSE
GET /api/threads/:id/events?stream=1&after=42
    ① 先注册订阅，再补放 sequence > 42 的历史（最多 200 条）
    ② 补放期间新产生的事件会同时进入订阅通道
    ③ 客户端按 event.id 去重
```

顺序是「先订阅、后补放」而不是反过来，这样处于读取与订阅之间的事件不会消失；代价是可能重复，由客户端去重消化（`server.mjs:236-240`、`app.js:233`）。SSE 每 15 秒发一个注释行心跳，防止中间层空闲断连。

## 9. 状态与并发模型

### 单写入者

`JsonStore` 是唯一能修改持久状态的对象。所有变更都走 `mutate(mutator)`：

```js
mutate(mutator) {
  const operation = this.writeChain.then(async () => {
    const result = await mutator(this.state);   // 在内存状态上修改
    this.state.meta.updatedAt = nowIso();
    await this.persist();                       // 整份文档落盘
    return clone(result);                       // 返回深拷贝，调用方改不动内部状态
  });
  this.writeChain = operation.catch(() => undefined);  // 失败不阻塞后续写
  return operation;
}
```

三个性质：

1. **串行化**：`writeChain` 把所有写操作排成一条链，`Promise.all` 并发提交 12 条记忆不会互相覆盖（`test/store.test.mjs:28-35`）。
2. **读不加锁**：`getThread` / `listX` 直接读内存并深拷贝，永远不返回内部引用。
3. **失败隔离**：某次 mutator 抛错只影响它自己的调用方，写链继续可用。

### 原子落盘

`persist()` 写 `<file>.<pid>.<timestamp>.tmp` 再 `rename` 覆盖目标文件。Windows 上杀毒软件持有目标文件时 rename 可能失败，此时退化为直接写并清理临时文件（`store.mjs:88-105`）。这条降级路径牺牲了原子性以保证可用性，是有意的平台妥协。

### 每线程单个在途 run

`Orchestrator.activeRuns` 是 `threadId → Promise` 的映射。同一线程的第二次提交**不排队也不报错，而是复用第一次的 Promise**（`orchestrator.mjs:121-125`）。

- 优点：防止两轮执行竞争同一个消息游标；前端重复点击不会造成双份对话。
- 代价：第二个请求拿到的是第一轮的结果，它自己的 `content` 被丢弃。`clientRequestId` 目前只写进 metadata，不参与幂等判断。
- 不同线程之间完全独立并行。

### 进程模型

单进程、单文件、内存状态 + 落盘。**不支持多进程共享同一个 `data/state.json`**：两个进程会各自持有内存副本并互相覆盖。需要多实例时，先替换 `JsonStore`（§18）。

## 10. Provider 边界与降级

Provider 是唯一的外部模型出口，接口只有一个方法：

```js
complete({ agent, content, context })
  → { content, citations, provider, model, usage }
```

三个实现：

| 实现 | 作用 | 失败行为 |
| --- | --- | --- |
| `LocalProvider` | 确定性离线回答，让空仓库 + 无密钥也能演示完整链路 | 不失败 |
| `OpenAICompatibleProvider` | 真实模型；45s 超时（`AbortController`）；HTTP 非 2xx、空正文均视为失败 | 抛错 |
| `FallbackProvider` | 组合器：主实现抛错则记录 `lastError` 并转本地 | 不失败 |

`createProviderFromEnv()` 根据 `OPENAI_API_KEY` 是否存在决定组合方式；`/api/bootstrap` 把当前模式与 `lastError` 暴露给 UI（`server.mjs:112-118`）。

降级的分层含义：

- **Provider 层降级**（网关错误/超时/空返回）：用户仍得到一条可用回答，`provider` 字段显示 `local`。
- **Agent 层失败**（Provider 组合器之外的异常，例如 Agent 不存在）：写入一条说明失败的 assistant 消息 + `agent.failed` 事件，其余目标继续执行，线程保持可重试（`test/orchestrator.test.mjs:37-57`）。

任何一层都不会让整轮 HTTP 请求以 5xx 结束。

## 11. 上下文与记忆边界

送进模型的上下文是**显式构造、有上限**的，不是「历史全塞」：

```text
buildContext(threadId, query, { messageLimit: 14, memoryLimit: 6 })
  ├─ recentMessages  线程最后 14 条，每条正文截断到 6000 字符
  └─ memories        对 query 做词法检索，取前 6 条，附 citation
```

排序公式（`memory.mjs:30-38`）：

```text
score = 命中词数 / 查询词数
      + importance × 0.18
      + exp(-年龄天数 / 45) × 0.12       // 半衰约 31 天
命中词数为 0 的记忆直接淘汰
```

分词是刻意透明的实现：拉丁词按 `[a-z0-9][a-z0-9_-]+` 取，中文按「单字 + 相邻双字」取，配一份小停用词表。它不追求召回率最优，追求**结果可解释**——用户能理解为什么这条记忆被召回。

引用以 `memory:<id>` 形式随消息持久化（最多 12 条），前端在消息脚注渲染，形成「回答 → 依据」的可追溯链。

这一层的替换点很窄：只要新的实现保持 `search()` 和 `buildContext()` 的返回形状，换成 SQLite FTS 或向量检索不影响编排和 HTTP 契约。

## 12. 工具与能力边界

`ToolRegistry` 是显式 allow-list（`tools.mjs`），默认四个工具：

| 工具 | 作用 | 副作用范围 |
| --- | --- | --- |
| `search_memory` | 线程内 + 全局记忆的词法检索 | 只读 |
| `remember` | 写入长期记忆 | 只写 memories |
| `create_task` | 创建可追踪任务 | 只写 tasks |
| `list_tasks` | 列出线程待办 | 只读 |

设计约束：

- **没有 shell、文件、网络工具。** 工具只能触达 store 暴露的领域操作。
- **`list()` 剥离 `execute` 函数**后才返回给 API，避免实现细节外泄。
- **未注册的工具名抛 `TOOL_NOT_FOUND`**，不做模糊匹配。
- 当前工具由 Orchestrator 在确定的位置调用（记忆命令、任务命令），**模型不能自主决定调用工具**。这是有意的：先把可审计的执行链路做实，再开放模型驱动的工具调用（§18）。

## 13. 传输层契约

### 错误码映射

`server.mjs:45-48` 把领域错误码映射为 HTTP 状态：

| 错误 `code` | HTTP | 触发场景 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 空内容、非法 JSON、请求体超限、非法 status/role |
| `NOT_FOUND` | 404 | 线程/任务不存在、未匹配的 API 路径 |
| `BAD_PATH` | 400 | 静态资源或文档路径穿越 |
| 其他 | 500 | 未预期异常 |

响应体统一为 `{ error: { code, message } }`。

### 端点一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/bootstrap` | 首屏聚合：agents / threads / tasks / stats / tools / provider |
| GET POST | `/api/agents` | 列出 / 注册 Agent |
| GET POST | `/api/threads` | 列出 / 新建线程 |
| GET | `/api/threads/:id` | 线程 + 全量消息（按 sequence 排序） |
| POST | `/api/threads/:id/messages` | 提交一轮编排 |
| GET | `/api/threads/:id/events` | 事件读取；`stream=1` 转 SSE，`after=N` 续传 |
| GET POST | `/api/memories` | 检索（`q`）/ 列出 / 写入 |
| GET POST | `/api/tasks` | 列出 / 创建 |
| PATCH | `/api/tasks/:id` | 更新 title / owner / status |
| GET | `/api/tools` | 工具 allow-list 元数据 |

非 `/api/` 请求走静态资源；`/docs/*` 映射到项目 `docs/` 目录（两者都做前缀校验防目录穿越）。未匹配的静态路径回退到 `index.html` 并返回 200——这是为将来的前端路由留的行为，代价是拼错的资源路径不会以 404 暴露。

## 14. 容量与限额

所有上限都是模块内常量，集中列出便于评估容量：

| 限额 | 值 | 位置 |
| --- | --- | --- |
| 请求体 | 1,000,000 字节 | `server.mjs:18` |
| 单条消息正文 | 30,000 字符（前端 textarea 同步限制） | `store.mjs:198` |
| 单线程消息 | 500 条（超出裁剪最旧） | `store.mjs:8` |
| 全局事件 | 1,200 条（超出裁剪最旧） | `store.mjs:7` |
| 记忆总量 | 1,000 条 | `store.mjs:232` |
| 单条记忆文本 | 12,000 字符 | `store.mjs:224` |
| 消息引用数 | 12 | `store.mjs:200` |
| 记忆标签数 | 20 | `store.mjs:227` |
| 任务标题 | 240 字符 | `store.mjs:249` |
| 上下文最近消息 | 14 条 × 6,000 字符 | `orchestrator.mjs:153` / `memory.mjs:68` |
| 上下文记忆 | 6 条 | `orchestrator.mjs:153` |
| 检索结果上限 | 20 | `memory.mjs:61` |
| 事件查询上限 | 500（一次性）/ 200（SSE 补放默认值） | `store.mjs:305` |
| Provider 超时 | 45,000 ms | `providers.mjs:68` |
| SSE 心跳 | 15,000 ms | `server.mjs:242` |
| 事件监听者上限 | 100 | `orchestrator.mjs:30` |

有界性是安全属性的一部分：模型返回、用户输入、事件累积都不能无限增长为内存或磁盘压力。

## 15. 安全边界

### 已经建立的边界

- **密钥只存在于服务端环境变量**，不出现在 `/api/bootstrap` 或任何浏览器载荷里；UI 只知道模式名和最后一次错误信息。
- **工具是 allow-list**，不含 shell/文件/网络能力。
- **所有用户与模型文本在插入 DOM 前转义**（`app.js:27-34`），消息、记忆、任务、事件详情统一走 `escapeHtml`。
- **静态与文档路径做前缀校验**，阻断 `../` 穿越（`server.mjs:76-110`）。
- **请求体与各类文本有硬上限**，模型输出被视为不可信数据先截断再持久化。
- **默认只监听 `127.0.0.1`**，不绑定 `0.0.0.0`。
- **写入原子化**，避免崩溃时留下半份状态文件。
- **`data/state.json` 在 `.gitignore` 中**，个人对话不会被提交。

### 刻意留下的空缺（部署前必须知道）

| 空缺 | 影响 | 什么时候必须补 |
| --- | --- | --- |
| 无认证、无授权 | 任何能访问端口的人可读写全部数据 | 一旦绑定到非 loopback 地址 |
| `access-control-allow-origin: *` | 浏览器里的任意页面都能调用本机 API 并读到响应 | 同上，或需要防范本地恶意页面时 |
| `POST /api/agents` 不校验字段语义 | 可注入任意 `systemPrompt` 的身份 | 开放给非本人使用时 |
| 无速率限制 | 可被无限触发模型调用（产生费用） | 配置真实 Provider 且非独占使用时 |

结论：**当前形态是单人本地工作台**。README 与本文都不把它描述为可直接暴露到公网的服务。

## 16. 可测试性

架构上的三个决定让核心路径可以黑盒测试：

1. **依赖注入的组装根。** `createApp({ dataFile, provider })` 允许注入临时目录和假 Provider，HTTP 测试不需要真实模型或污染开发数据（`test/server.test.mjs`）。
2. **确定性的默认 Provider。** CI 无密钥也能跑通完整一轮。
3. **状态在文件里。** 重启durability 直接用「新建第二个 `JsonStore` 指向同一文件」验证（`test/store.test.mjs:9-26`）。

| 行为 | 测试 |
| --- | --- |
| mention 解析、策略选择、邮箱误判防护 | `test/router.test.mjs` |
| 记忆排序、中文记忆命令解析 | `test/memory.test.mjs` |
| 重启持久性、并发写不丢记录 | `test/store.test.mjs` |
| 广播扇出、任务创建、失败可恢复、事件轨迹 | `test/orchestrator.test.mjs` |
| health / bootstrap / 一轮消息 / 任务状态更新 | `test/server.test.mjs` |

`npm test`（node:test，11 个用例）+ `npm run check`（对 11 个文件做 `node --check` 语法校验）。

## 17. 已知取舍与限制

架构层面的取舍，实现层面的细节问题见 [`IMPLEMENTATION.md`](IMPLEMENTATION.md) 的已知问题清单。

| 取舍 | 得到 | 失去 |
| --- | --- | --- |
| 整份 JSON 全量落盘 | 零依赖、可读、易调试、易迁移 | 写放大随状态线性增长，不适合大数据量 |
| 内存状态 + 单进程 | 简单、读操作零成本 | 无法多进程/多实例共享 |
| 词法检索 | 结果可解释、无模型依赖 | 语义相近但用词不同的记忆召回不到 |
| 每线程复用在途 run | 天然防重复提交 | 并发提交的第二条内容被静默丢弃 |
| 事件环形裁剪（1200） | 状态文件有界 | 长期审计需要外部落地 |
| 工具由编排器在固定点调用 | 执行链路完全可预测 | 模型无法自主选择工具 |
| 非流式 Provider 调用 | 实现简单、事件语义清晰 | 首字延迟等于整段生成时间 |

## 18. 演进路径

演进顺序按「保持契约不变」排列，每一步只替换一个适配器：

1. **`JsonStore` → SQLite。** 保持相同的方法签名与事件序号语义；获得增量写入与更大数据量。编排层零改动。
2. **`MemoryService` 加 embedding + rerank，保留词法兜底。** 只要 `search()`/`buildContext()` 返回形状不变，Provider 与 UI 不用改。
3. **Provider 升级为 token streaming。** 复用现有 SSE 通道，新增 `agent.delta` 事件类型，`agent.started/completed` 语义不变。
4. **工具加 capability policy 与人工确认态。** 在 `ToolRegistry.execute` 前插入策略检查，并把待确认状态表达为新的事件类型。
5. **模型驱动的工具调用。** 在 Orchestrator 内加入受限的工具调用循环（带最大轮数），事件里记录每一次调用。
6. **只有出现真实多用户需求时**，才引入认证、租户隔离和 CORS 收紧——此时 §15 的四个空缺必须一并补齐。

判断新需求是否值得做的两条线：它能落在现有五层里吗？它需要第二个持久化写入者吗？第一个答案是「否」或第二个答案是「是」时，先改架构，再写功能。
