# Orbit Agent 核心功能文档

## 1. 文档范围

本文按「能力」组织，说明每项功能解决什么问题、怎么触发、边界行为是什么、以及它由哪些代码支撑。

- 想知道「系统怎么分层、为什么这么分」→ [`ARCHITECTURE.md`](ARCHITECTURE.md)
- 想知道「代码逐行怎么写、怎么改」→ [`IMPLEMENTATION.md`](IMPLEMENTATION.md)
- 想知道「哪些能力刻意不做」→ [`PRODUCT-SCOPE.md`](PRODUCT-SCOPE.md) 与本文 §13

阅读顺序建议：先看 §2 总览，再看 §11 输入语法速查，然后按需查具体章节。

## 2. 能力总览

| 能力 | 解决的问题 | 触发方式 | 支撑模块 |
| --- | --- | --- | --- |
| 稳定 Agent 身份 | 结果有明确的角色归属，不是匿名的「AI 说」 | 内置 roster，可 API 扩展 | `agent-registry.mjs` |
| 持久协作线程 | 关掉浏览器、重启进程后还能接着做 | 自动 | `store.mjs` |
| 确定性 mention 路由 | 明确指定谁来答，不靠模型猜 | `@atlas` `@all` | `router.mjs` |
| 串行/并行编排 | 要么多视角独立判断，要么逐步接力 | 自动推断或 `#serial` `#parallel` | `orchestrator.mjs` |
| 长期记忆与引用 | 确认过的事实可复用，来源可追溯 | `记住：…` / API | `memory.mjs` |
| 任务抽取与追踪 | 讨论产出的行动项不丢 | `任务：…` / API | `tools.mjs` + `store.mjs` |
| 工具 allow-list | Agent 可扩展但能力可审计 | 内置四个工具 | `tools.mjs` |
| 可观测执行轨迹 | 出问题时能定位在哪一环 | 自动，Inspector 实时显示 | 事件 + SSE |
| Provider 可替换与降级 | 不锁死某家模型，离线也能演示 | 环境变量 | `providers.mjs` |

## 3. 稳定 Agent 身份

### 解决的问题

多视角协作最容易退化成「同一个模型换个提示词自言自语」。Orbit 把身份做成一等公民：每个 Agent 有稳定 id、固定角色、专属 system prompt 和视觉标识，消息永久携带 `agentId`，回答的责任归属是明确的。

### 内置 roster

| id | 名称 | 角色 | 定位 | 别名 |
| --- | --- | --- | --- | --- |
| `atlas` | Atlas | 架构师 | 拆解问题、设计边界、给出可执行方案 | `architect` `架构师` |
| `forge` | Forge | 执行工程师 | 把方案落成代码、命令或操作步骤 | `builder` `engineer` `工程师` |
| `lens` | Lens | 独立审查员 | 从正确性、安全性、可维护性角度挑错 | `reviewer` `review` `审查员` |

三个身份不是随意凑数，对应的是一个真实任务的三个必要视角：**要做什么 → 怎么做 → 哪里会错**。默认 Agent 是 roster 中的第一个（Atlas）。

### 别名与大小写

`@Atlas`、`@atlas`、`@architect`、`@架构师` 都命中同一个身份。id 与别名在注册时统一转小写，查询时也会去掉前导 `@` 并转小写，所以书写形式不影响路由结果。

### 扩展身份

```bash
curl -X POST http://127.0.0.1:3030/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "id": "scribe",
    "name": "Scribe",
    "role": "文档工程师",
    "emoji": "S",
    "color": "#6aa9ff",
    "description": "把结论写成可交付的文档",
    "systemPrompt": "你是 Scribe，负责把讨论结论整理成结构清晰的文档。",
    "aliases": ["writer", "文档"]
  }'
```

新身份立即参与路由，并被 `@all` 纳入广播范围。重启后从 `data/state.json` 恢复——store 是身份的权威来源，内置 roster 只负责首次播种。

### 边界

- **只增不删。** 没有删除或停用 Agent 的接口，`@all` 会包含所有已注册身份。
- **字段语义不校验。** 只强制 `id`/`name`/`role` 为非空字符串，`systemPrompt` 内容不做任何检查。作为单人本地工具可接受，开放给他人使用前需要补校验。
- **`provider` 字段目前是装饰性的。** roster 里写着 `provider: 'auto'`，但当前实现下所有 Agent 共用同一个 Provider 实例，不支持按 Agent 分配不同模型。

## 4. 持久协作线程

### 解决的问题

Agent 工具最常见的挫败感是「上下文没了」。Orbit 的线程是持久化的协作现场：消息、active Agent、消息计数、更新时间全部跨重启保留。

### 行为

- 首次启动自动创建一个名为「欢迎来到 Orbit Agent」的线程，不需要任何配置向导。
- 线程按 `updatedAt` 倒序排列，最近活跃的在最上面。
- 每条消息在线程内有递增的 `sequence`，读取线程时按它排序，顺序稳定。
- 一轮执行结束后，线程的 `activeAgentId` 会被设为**本轮最后一个执行的 Agent**。下一条不带 mention 的消息就交给它——这让「继续追问同一个 Agent」不需要反复打 `@`。

### 消息角色

| 角色 | 来源 | 用途 |
| --- | --- | --- |
| `user` | 用户输入 | 原始请求（保留完整原文，含 mention 和控制标签） |
| `assistant` | Agent 回答 | 携带 `agentId`、`citations`、`metadata`（provider/model/latencyMs/usage/strategy） |
| `system` | 编排器 | 多 Agent 协作摘要 |
| `tool` | 预留 | 当前未使用 |

失败的 Agent 调用也会写入一条 `assistant` 消息，内容是失败说明加「线程状态已保留，可以重试或切换到其他 Agent」，`metadata.status` 为 `error`。**失败留痕而不是静默消失**是有意的设计。

### 边界

- **单线程保留最近 500 条消息**，超出后裁剪最旧的。
- **没有删除线程、重命名线程、删除单条消息的接口。** 新建线程默认标题「未命名协作线程」（前端）或「新的协作线程」（store 默认值）。
- **同一线程同时只有一轮执行在跑。** 详见 §5 的并发说明。

## 5. 确定性 mention 路由

### 解决的问题

「让模型决定该谁处理」听起来聪明，但结果不可预测、不可测试、出错时无法解释。Orbit 的路由是纯正则解析：给定输入和线程状态，输出永远相同。

### 语法

| 输入 | 目标 | 策略 |
| --- | --- | --- |
| `帮我看下这段代码` | 线程当前 active Agent | serial |
| `@forge 落成最小实现` | Forge | serial |
| `@atlas @lens 设计并审查` | Atlas + Lens | parallel（多目标自动并行） |
| `@all 独立分析风险` | 全部已注册 Agent | parallel |
| `#parallel 从多个角度看` | active Agent | parallel |
| `#serial @all 逐步接力` | 全部 Agent | serial（显式标签优先于广播） |

`@all` 的等价写法：`@team`、`@全体`、`@所有人`。

### 策略优先级

判定顺序（`router.mjs:50-55`）：

```
① 文本中第一个出现的 #serial   → serial（能覆盖 @all）
② 文本中第一个出现的 #parallel → parallel
③ @all 广播                    → parallel
④ 命中的目标数 > 1             → parallel
⑤ 其余                        → serial
```

同时写了 `#serial` 和 `#parallel` 时，**文本中先出现的那个生效**。

### 边界行为

这些是用户实际会撞到的情况：

| 输入 | 实际行为 | 原因 |
| --- | --- | --- |
| `联系 foo@forge.com 后继续` | 不路由到 Forge，交给 active Agent | mention 前一个字符是字母，判定为邮箱/标识符而非路由指令 |
| `@atals 帮我看看`（拼错） | 静默交给 active Agent | 未知 token 记入 `route.decided` 事件的 `unknown[]`，但界面上没有提示 |
| `@all @atlas 分析` | 全部 Agent | 广播优先，`@atlas` 不额外生效 |
| `@atlas` 单独一条消息 | 交给 Atlas，正文回退为 `@atlas` | 清洗后正文为空时回退到原文，避免把空内容送进模型 |
| `@forge` 出现两次 | 只执行一次 | 目标去重 |

**mention 与控制标签会从送进模型的正文里剥离**，但用户消息保存的是完整原文。也就是说模型看到的是「落成最小实现」，而线程历史里留的是「@forge 落成最小实现」——路由意图可追溯，模型输入干净。

### 并发提交

同一线程已有执行在跑时，第二次提交**不排队也不报错，而是直接返回第一轮的结果**。这是防重复点击的设计，但有代价：第二条消息的内容会被静默丢弃。前端在执行期间会禁用输入框，正常操作路径下遇不到；用 API 直接并发提交时需要注意。不同线程之间完全独立并行。

## 6. 串行与并行编排

### 两种模式的语义差别

**并行**：所有目标同时收到**完全相同**的输入，彼此看不到对方的回答。适合要独立判断的场景——你想知道三个视角是否自发地指向同一个风险，而不是后面的 Agent 顺着前面的说。

**串行**：依次执行，从第二个 Agent 开始，输入里会追加一段前序结果摘要：

```
<原始正文>

前序 Agent 已给出以下结果，请在此基础上补充或指出分歧：
- Atlas: <摘要，最多 500 字符>
- Forge: <摘要，最多 500 字符>
```

摘要会把连续空白压缩成单空格并在 500 字符处截断。适合「设计 → 实现 → 审查」这类有依赖顺序的接力。

### 协作摘要

目标多于一个时，编排器在末尾追加一条 `system` 消息，列出参与的 Agent 名称，`metadata.kind` 为 `coordination-summary`。它是给人看的分隔标记，不参与后续的上下文组装。

注意：这条摘要的文案目前固定写作「并行协作完成」，即使实际策略是串行（`#serial @all`）。真实策略记录在 `metadata.strategy` 里。这是已知的文案问题，见 [`IMPLEMENTATION.md`](IMPLEMENTATION.md) 已知问题清单。

### 失败隔离

一个 Agent 失败不影响其他 Agent：

- 失败的那个写入错误说明消息 + `agent.failed` 事件；
- 其余目标继续执行；
- `execution.completed` 的 `failedCount` 记录失败数量；
- 整轮 HTTP 请求仍返回 200，线程保持可重试。

这条行为有专门的测试覆盖（`test/orchestrator.test.mjs:37-57`：三个 Agent 中让 Lens 抛错，断言仍得到 3 条消息、其中 1 条失败、且轮次正常收尾）。

## 7. 长期记忆与引用

### 解决的问题

「上次说过部署要先过 review」这类约束，不该每次重新输入，也不该指望模型从几百条历史里自己捞出来。记忆是显式写入、可检索、带来源的独立记录。

### 写入

```
记住：部署必须先通过 review
remember: deploys need review approval
```

要求 `记住：` / `remember:` 出现在**消息最开头**（前面只允许空白），冒号支持中英文。命中后：

- 冒号之后的**全部内容**成为记忆文本，包括换行——所以多行消息用这个前缀时会把整段都记下来；
- `importance` 默认 0.7，`source` 记为 `agent:user`；
- 发出一条 `tool.called` 事件；
- **原消息仍然正常路由给 Agent**。写入记忆和获得回答同时发生，不是二选一。

也可以绕过对话直接写：

```bash
curl -X POST http://127.0.0.1:3030/api/memories \
  -H 'content-type: application/json' \
  -d '{"text":"生产环境只在周二和周四发布","importance":0.9,"tags":["release"]}'
```

### 检索与排序

每轮执行都会用清洗后的正文做一次检索，取前 6 条注入上下文。排序公式（`memory.mjs:30-38`）：

```
score = 命中词数 / 查询词数
      + importance × 0.18
      + exp(-年龄天数 / 45) × 0.12
命中词数为 0 → 直接淘汰
```

三项的权重意图：词法重叠是主项，重要度是次要偏好，新鲜度只做微调（衰减半衰期约 31 天）。

分词刻意做得透明：拉丁词取 `[a-z0-9][a-z0-9_-]+`（**单字符词会被丢弃**），中文取「单字 + 相邻双字」，配一份小停用词表（`的 了 和 是 在 请 帮 the a an and or to of in is it this that` 等）。它不追求召回率最优，追求**你能理解为什么这条被召回**。

### 作用域

- **不带 `threadId` 的记忆是全局的**，在任何线程都会被检索到；
- **带 `threadId` 的记忆只在该线程可见**；
- 通过对话 `记住：` 写入的记忆自动绑定当前线程。

### 引用

命中的记忆以 `memory:<id>` 形式随回答持久化（每条消息最多 12 条），前端在消息脚注渲染成 citation 标签。Inspector 的 Relevant memory 卡片显示命中记忆及其匹配度百分比。这形成「回答 → 依据」的可追溯链：你能看出模型这次是基于哪些既有事实作答的。

### 边界

- **最多 1000 条记忆**，超出后丢弃最旧的；单条文本上限 12,000 字符，标签上限 20 个。
- **纯语义相似召回不到。** 「上线流程」和「部署规范」用词不重叠时匹配为零。这是词法检索的固有限制，也是 §13 里排在第一位的演进项。
- **没有编辑或删除记忆的接口。** 写错了只能再写一条更重要的覆盖认知。

## 8. 任务抽取与追踪

### 触发

```
任务：补充失败重试的测试
task: add retry coverage
```

与记忆命令不同，任务命令**可以出现在消息的任意一行**（不必在开头），匹配到该行结尾。所以一条消息可以既提问、既写记忆、又建任务：

```
记住：所有对外接口都要有速率限制
任务：给 /api/threads/:id/messages 加速率限制
@lens 这个改动有什么风险
```

### 行为

- `owner` 自动设为本轮的第一个目标 Agent，责任有归属；
- 状态初始为 `todo`，可流转到 `doing` / `done`；
- 绑定当前 `threadId`；
- 发出 `tool.called` 事件，`execution.completed` 的 `taskId` 记录本轮创建的任务。

### 管理

Inspector 的 Open tasks 卡片列出未完成任务，点击即标记完成。也可以用 API：

```bash
curl -X PATCH http://127.0.0.1:3030/api/tasks/task_xxx \
  -H 'content-type: application/json' -d '{"status":"doing"}'
```

`status` 只接受 `todo` / `doing` / `done`，其他值返回 400。

### 边界

- 标题上限 240 字符；每条消息只抽取**第一个**匹配的任务行；
- 没有删除任务的接口，只能标记完成；
- 不带 `threadId` 的任务是全局的，在所有线程可见。

## 9. 工具 allow-list

### 设计立场

「Agent 能执行任意命令」是最快出效果也最快出事的做法。Orbit 采用显式白名单：工具必须在启动时注册，未注册的名字直接抛 `TOOL_NOT_FOUND`，不做模糊匹配。

### 内置工具

| 工具 | 作用 | 副作用范围 |
| --- | --- | --- |
| `search_memory` | 线程内 + 全局记忆的词法检索 | 只读 |
| `remember` | 写入长期记忆 | 只写 memories |
| `create_task` | 创建可追踪任务 | 只写 tasks |
| `list_tasks` | 列出线程待办 | 只读 |

`GET /api/tools` 返回工具元数据（name / description / inputSchema），**不返回 `execute` 函数**，实现细节不外泄。

### 当前的关键约束

**模型不能自主决定调用工具。** 工具由编排器在确定的位置调用：命中记忆命令时调 `remember`，命中任务命令时调 `create_task`。这意味着执行链路完全可预测——每一次副作用都对应用户输入里的一个显式指令。

代价是灵活性：Agent 不能自己决定「我需要先搜一下记忆」。这是有意的排序选择，先把可审计的链路做实，再开放模型驱动的工具循环（§13 第 5 项）。

### 没有的能力

没有 shell、没有文件读写、没有对外网络请求。工具只能触达 store 暴露的领域操作。

## 10. 可观测执行轨迹

### 解决的问题

Agent 系统出问题时，最难回答的是「哪一步错了」——是路由选错了 Agent？上下文没召回该有的记忆？模型返回异常？还是持久化失败？Orbit 让每一步都留下持久化的事件记录。

### 一轮完整轨迹

```
message.accepted      输入已写入线程                    messageId, contentLength
route.decided         解析 mention，确定执行策略         targets[], strategy, mentions[], unknown[], reason
tool.called           （可选）记忆写入                   tool, memoryId
context.retrieved     组装最近消息与长期记忆             messageCount, memoryCount, citations[]
agent.started         开始调用模型适配器                 runId, agentId, agentName, strategy
agent.completed       结果已持久化                       messageId, provider, latencyMs
  或 agent.failed     已记录失败并保持线程可用            messageId, error, latencyMs
tool.called           （可选）任务创建                   tool, taskId, owner
execution.completed   本轮闭环完成                       strategy, targets[], messageIds[], failedCount, taskId, latencyMs
```

`agent.started` / `agent.completed` 每个目标各一对。并行执行时这些事件的相对顺序不确定，但都落在 `context.retrieved` 之后、`execution.completed` 之前。

### 实时与回放

Inspector 的 Execution trace 卡片通过 SSE 实时更新，`agent.started` 到达时顶部状态变成「Atlas is thinking…」。断线后：

```
GET /api/threads/:id/events?stream=1&after=42
```

服务端先注册订阅、再补放 `sequence > 42` 的历史事件，所以处于「读取」与「订阅」之间产生的事件不会丢；代价是可能重复，客户端按 `event.id` 去重。SSE 每 15 秒发一次心跳注释行，防止中间层因空闲断连。

### 用它排查问题

| 症状 | 看哪个事件 | 判断 |
| --- | --- | --- |
| 回答的 Agent 不是我想要的 | `route.decided` | `targets` 与 `reason`；`reason=active_agent_fallback` 说明 mention 没被识别，查 `unknown[]` |
| Agent 好像不知道我之前说过的事 | `context.retrieved` | `memoryCount=0` 说明检索没命中，是词法不重叠而非模型问题 |
| 回答质量突然下降 | `agent.completed` | `provider` 字段是 `local` 说明降级了，查 bootstrap 的 `lastError` |
| 某个 Agent 没有回答 | `agent.failed` | `error` 字段（注意当前界面未展示该文案，需查 API） |
| 整体很慢 | `execution.completed` | `latencyMs` 与各 `agent.completed` 的 `latencyMs` 对比 |

### 边界

- **全局只保留最近 1200 条事件**，超出后裁剪最旧的。老线程的早期轨迹会消失，但消息本身不会。需要长期审计要外部落地。
- **一次性读取上限 500 条，SSE 补放默认 200 条。**
- `runId` 目前只出现在 `agent.started`，后续事件靠 `messageId` 关联。

## 11. Provider 可替换与降级

### 三种模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| 本地演示 | 未配置 `OPENAI_API_KEY` | 确定性离线回答，链路完整 |
| 真实模型 | 配置了密钥且调用成功 | 走 OpenAI 兼容网关 |
| 自动降级 | 配置了密钥但调用失败 | 记录 `lastError`，本轮转本地回答 |

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # 任意 OpenAI 兼容网关
OPENAI_MODEL=gpt-4o-mini
npm start
```

### 降级的触发条件

任一情况都视为失败并转本地：HTTP 非 2xx、45 秒超时、返回正文为空。**降级是静默的、逐次的**——不熔断、不重试、不影响下一次请求再试真实网关。用户仍得到一条可用回答，消息 `metadata.provider` 显示 `local`，据此可以判断这条回答的来源。

### 本地 Provider 的回答策略

`LocalProvider` 按关键词分三类回答：命中 `架构|设计|拆解|方案|architecture|design` 给拆解型答案；命中 `审查|review|风险|安全|bug|漏洞` 给审查型答案；其余给通用答案。每条回答都附上一行上下文提示（命中了几条记忆、有多少条最近消息），并注明当前是 LocalProvider。

它的价值不在回答质量，而在于**让整条链路在无密钥环境下可演示、可测试**：CI 跑得通，新克隆的仓库第一次启动就能看到完整的路由 → 记忆 → 执行 → 轨迹。

### 送给模型的内容

```
system:  <Agent 的 systemPrompt>
user:    <清洗后的正文>
         Recent thread context:   最近 8 条消息，每条截断到 1200 字符
         Relevant memory:         命中的记忆列表
```

`temperature` 固定 0.2（偏确定性）。注意：请求里**没有设置 `max_tokens`**，输出长度由网关默认值决定。

### 边界

- **非流式。** 首字延迟等于整段生成时间，界面上表现为「thinking…」直到回答完整出现。
- **所有 Agent 共用一个 Provider 实例**，不支持按 Agent 配不同模型。
- **`lastError` 一旦记录不会清除**，网关恢复后 bootstrap 里仍显示上次的错误信息。判断当前状态应看最新消息的 `metadata.provider`，而不是 `lastError`。

## 12. 工作台界面

四个区域，对应四个关注点：

| 区域 | 内容 | 作用 |
| --- | --- | --- |
| **Threads**（左栏） | 线程列表、Agent roster、Provider 状态 | 切换协作现场，确认身份与运行模式 |
| **Conversation**（中栏） | 时间线、mention 快捷芯片、输入框 | 主工作区。Enter 发送，Shift+Enter 换行 |
| **Inspector**（右栏） | Execution trace / Relevant memory / Open tasks | 三个投影，把「系统做了什么」显性化 |
| **Topbar** | 线程标题、消息数、事件数、刷新、架构文档入口 | 状态概览 |

前端是零依赖的原生 JS，只做投影：**所有写操作都走 API，读以服务端返回为准**。提交消息后不是把响应体拼进时间线，而是重新拉取线程——因为 SSE 的 `execution.completed` 可能比 HTTP 响应先到，手工合并会导致消息重复。

所有用户与模型文本在插入 DOM 前统一转义。

界面上的已知限制：左栏 Memory / Tasks 导航项目前只是滚动定位，不切换视图；未命中的静态资源路径会回退到首页而不是报 404。

## 13. 刻意不做的能力

排除这些不是「永远不做」，是为了让当前版本的叙事聚焦在「可观测的协作基础设施」上。

| 不做 | 原因 |
| --- | --- |
| 多用户账号、组织权限、租户隔离 | 没有真实多用户需求前，认证体系会淹没核心链路 |
| 任意 shell / PTY 执行、自动改写仓库 | 与「能力可审计」的立场直接冲突 |
| 向量数据库、embedding pipeline | 词法检索已能演示「有界召回 + 可解释引用」，向量检索是替换项不是前置项 |
| 分布式部署、水平扩展 | 单进程单文件是当前的容量假设，见架构文档 §9 |
| 插件市场、审批工作流、定时调度 | 都需要先有稳定的工具策略层 |
| 桌面安装器、语音、第三方 IM 连接器 | 与核心问题无关 |

### 演进顺序

每一步只替换一个适配器，保持契约不变：

1. `JsonStore` → SQLite（方法签名与事件序号语义不变，编排层零改动）
2. `MemoryService` 加 embedding + rerank，保留词法兜底
3. Provider 升级为 token streaming，复用现有 SSE 通道，新增 `agent.delta` 事件
4. 工具加 capability policy 与人工确认态
5. 开放模型驱动的工具调用循环（带最大轮数限制）
6. 出现真实多用户需求时才引入认证、租户隔离与 CORS 收紧

## 14. 输入语法速查

| 写法 | 效果 |
| --- | --- |
| `<任意文本>` | 交给线程当前 active Agent |
| `@atlas` `@forge` `@lens` | 指定单个 Agent（支持别名与任意大小写） |
| `@atlas @lens` | 多个 Agent 并行 |
| `@all` `@team` `@全体` `@所有人` | 全部 Agent 并行 |
| `#parallel` | 强制并行 |
| `#serial` | 强制串行（优先级高于 `@all`） |
| `记住：<内容>` | 写入长期记忆（必须在消息开头，吃掉后面全部内容） |
| `remember: <内容>` | 同上，英文形式 |
| `任务：<标题>` | 创建任务（可在任意一行，匹配到行尾） |
| `task: <标题>` | 同上，英文形式 |

组合示例：

```
#serial @all
记住：数据库迁移必须可回滚
任务：给迁移脚本补 down 方法
设计一个安全的迁移流程
```

这一条消息会：写入一条记忆 → 创建一条 owner 为 Atlas 的任务 → 三个 Agent 依次接力（每个都能看到前序结果）→ 追加协作摘要 → 把 active Agent 设为 Lens。

## 15. HTTP API 速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/bootstrap` | 首屏聚合：agents / threads / tasks / stats / tools / provider |
| GET POST | `/api/agents` | 列出 / 注册 Agent |
| GET POST | `/api/threads` | 列出 / 新建线程 |
| GET | `/api/threads/:id` | 线程 + 全量消息 |
| POST | `/api/threads/:id/messages` | 提交一轮编排（`{ content, clientRequestId? }`） |
| GET | `/api/threads/:id/events` | 事件读取；`stream=1` 转 SSE，`after=N` 续传 |
| GET POST | `/api/memories` | 检索（`q`）/ 列出 / 写入 |
| GET POST | `/api/tasks` | 列出 / 创建 |
| PATCH | `/api/tasks/:id` | 更新 title / owner / status |
| GET | `/api/tools` | 工具 allow-list 元数据 |

错误统一返回 `{ error: { code, message } }`，`VALIDATION_ERROR` → 400，`NOT_FOUND` → 404，其余 → 500。

**当前没有认证。** 默认只监听 `127.0.0.1`，且 CORS 为 `*`——绑定到非 loopback 地址前必须先补认证与 CORS 收紧，见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §15。
