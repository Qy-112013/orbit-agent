# Orbit Agent 核心功能文档

> 当前实现说明，核对日期：2026-09-28，包版本：0.3.0。以当前 TypeScript 代码为准；历史设计记录见文档目录中的审计说明和 specs。

## 1. 能力总览

| 能力 | 触发方式 | 实现入口 |
| --- | --- | --- |
| 稳定身份与确定性路由 | 内置 Atlas / Forge / Lens；`@mention` 或 API 注册 | [agent-registry.ts](../src/core/agent-registry.ts)、[router.ts](../src/core/router.ts) |
| 持续会话 | 搜索、重命名、归档、恢复、分支 | [store.ts](../src/core/store.ts)、[conversation.ts](../src/core/conversation.ts) |
| 多 Agent 协作 | 串行、并行、`#discuss`、模型自主委派 | [orchestrator.ts](../src/core/orchestrator.ts) |
| ReAct 工具循环 | 模型提出工具请求，获得结果后继续 | [agent-loop.ts](../src/core/agent-loop.ts) |
| 计划、复核、重规划 | `#plan` 或界面“计划与复核” | [planner.ts](../src/core/planner.ts) |
| 知识库与长期记忆 | 导入文本、自然语言检索、`记住：…` | [knowledge.ts](../src/core/knowledge.ts)、[memory.ts](../src/core/memory.ts)、[vector-index.ts](../src/core/vector-index.ts) |
| 文件修改与命令执行 | `workspace_write`、`workspace_edit`、`shell_exec`；逐次审批 | [workspace-tools.ts](../src/core/workspace-tools.ts)、[approvals.ts](../src/core/approvals.ts) |
| 多模型与 CLI | 每 Agent 配置 Provider；API 流式、重试、结构化输出 | [providers.ts](../src/core/providers.ts)、[anthropic-provider.ts](../src/core/anthropic-provider.ts)、[cli-provider.ts](../src/core/cli-provider.ts) |
| Skills 与 MCP | Markdown Skills；MCP stdio 服务端和客户端 | [skills.ts](../src/core/skills.ts)、[mcp-client.ts](../src/core/mcp-client.ts)、[mcp-server.ts](../src/mcp-server.ts) |
| 任务与执行轨迹 | `任务：…`、HTTP API、SSE | [server.ts](../src/server.ts)、[types.ts](../src/core/types.ts) |

## 2. 身份与路由

Atlas 负责架构与拆解，Forge 负责执行，Lens 负责独立审查。身份包含角色、system prompt、别名及消息归属；不同身份是否使用不同模型由 Provider 配置决定。

`POST /api/agents` 注册身份并持久化，重启后恢复。新身份进入 `@all` 范围；当前没有删除或停用 Agent 的接口。Provider 解析顺序为 Agent id 的专属适配器、Agent 声明的已注册 Provider、默认适配器。

| 输入 | 行为 |
| --- | --- |
| 普通问题 | 交给线程当前 active Agent |
| `@forge 实现方案` | 指定 Forge；支持大小写与注册别名 |
| `@atlas @lens 分析风险` | 多目标默认并行 |
| `@all` / `@team` / `@全体` / `@所有人` | 选择全部注册 Agent |
| `#serial @all 逐步接力` | 后续 Agent 获得前序结果与预算内的引用 |
| `#parallel @all 独立分析` | 各 Agent 使用独立的模型/工具交换记录 |
| `#discuss @forge @lens 讨论方案` | 两轮讨论，再由第一个参与者汇总 |
| `#plan @atlas @forge @lens 完成目标` | 规划、执行、结构化复核与有限重规划 |

多个控制标签同时出现时取文本中第一个。mention 去重，邮箱中的 `@` 不作为路由；未知 mention 保留在正文并进入 `unknown` 记录，无有效目标时使用 active Agent。清洗后为空时回退原文，因此只输入标签也会提交给模型。

用户原始输入保存在消息中，当前轮模型正文使用清洗后的内容。同线程请求按到达顺序排队；不同线程可以并发。`clientRequestId` 目前只记录在 metadata，尚未作为幂等键。

## 3. 持续会话与上下文

会话支持搜索保留的标题/消息、重命名、归档与恢复、从指定消息分支。分支复制截止点之前的消息以及截止点内有效的摘要，不复制原线程专用文档、记忆、任务、计划或 CLI 原生会话绑定。

普通串行/并行回合结束后，active Agent 设为路由中的最后一个目标；讨论设为汇总者，计划设为规划者。每会话最多保留 500 条消息；没有线程或单条消息的删除接口。

历史在压缩间隔内保持追加式前缀：最多 24 条 / 24,000 字符，单条最多 4,000 字符。超过阈值后把较早消息纳入摘要，保留最近最多 8 条 / 8,000 字符。摘要最多 5,000 字符；记忆与知识正文另有预算。这些是字符限额，不是 token 计数。

正常环境装配启用 `ProviderSummarizer`，使用默认 Provider 生成模型摘要。未配置真实模型、摘要失败或发生本地降级时，使用抽取式摘要并记录原因。摘要有损，不能替代原始历史。当前用户问题在本轮 API 请求中单独发送，历史组装排除当前消息。

浏览器页面内按线程保存草稿和执行方式；刷新后未发送草稿不保证保留。详见 [会话、RAG 与计划](SESSION-RAG-PLANNING.md)。

## 4. 协作与计划

自主委派适用于支持工具调用的 API Provider。主 Agent 可调用 `delegate_to_agent`，获得子 Agent 的内容、状态、messageId 和引用。每轮共享最多 2 次委派，深度最多 1 层；子 run 不获得委派工具。

`#discuss` 允许 2–4 个参与者，固定两轮加一次汇总；第二轮读取上一轮结果，讨论期间关闭自主委派。不同 Agent 身份不自动等于不同模型。

`#plan` 允许最多 4 个参与者，第一位规划、最后一位复核；只有一位时为自检。每版最多 5 个步骤，包含 owner、dependsOn 和 acceptance，依赖只能指向前序步骤，实际按顺序执行。复核只接受 `pass / revise / blocked`，最多 2 次重规划、整个计划最多执行 8 个步骤。

规划和复核向 API Provider 发送 JSON Schema，并关闭这些阶段的 Orbit 模型工具；CLI 依靠提示词返回 JSON。最终仍由本地解析校验。普通步骤使用 ReAct 循环，计划期间关闭额外委派。

工具结果错误可交给模型修正。Agent 失败保留消息和事件；本地演示或降级结果不能通过计划验收。服务重启将进行中的计划标为 `interrupted`，不自动续跑。复核是模型对证据的判断，尚无强制测试门禁或发布许可机制。

## 5. 工具与审批

| 工具类别 | 工具 | 暴露规则 |
| --- | --- | --- |
| 只读资料 | `search_memory`、`search_knowledge`、`read_knowledge`、`list_tasks` | 可由模型调用 |
| 工作区读取 | `workspace_list`、`workspace_read` | 可由模型调用；路径校验与结果限额 |
| 领域写入 | `remember`、`create_task` | 用户命令、API 或 MCP 服务端调用；不向自主模型循环暴露 |
| 文件与命令 | `workspace_write`、`workspace_edit`、`shell_exec` | Web runtime 注册，每次执行前审批 |
| 外部 MCP | `mcp__<server>__<tool>` | 默认审批；配置中的 `autoApprove` 可免审批 |
| 委派 | `delegate_to_agent` | 仅允许委派的父 run 临时提供 |

每个 run 默认最多 5 次模型调用、8 次工具请求；拒绝和参数错误也消耗工具额度。工具串行执行，执行前检查调用 ID、预算、allow-list 和参数；单次模型工具结果最多 8,000 字符，超限返回带标记的合法 JSON 预览。

`ORBIT_MODEL_TOOLS=0` 关闭 Orbit 模型工具。`ORBIT_TOOL_POLICY=read-only` 只向模型提供声明为只读的注册工具；动态委派另受委派规则控制，外部 CLI 内部工具也不受此开关管理。没有审批 broker 时循环不会提供需审批的写入工具。

审批卡片展示工具、摘要和预览，默认 10 分钟超时拒绝。请求/决策写入事件，待审批 Promise 只在内存中；重启不能恢复待执行调用。

文件工具限制在 workspace 内，检查 realpath，禁止访问 `.env` 和 `.env.*`（允许模板 `.env.example`）；写入还禁止 `.git/` 和 Orbit 数据目录。单文件写入上限 200,000 字节，覆盖前备份，edit 要求旧文本恰好匹配一次。不提供文件删除、移动或重命名工具。

shell 默认 60 秒超时，上限 10 分钟；stdout/stderr 各保留末尾 32,000 字节，超时尝试终止进程树。命令检查拦截已知删除形式，执行环境过滤敏感变量。工作目录和命令检查不是 OS 沙箱；shell、外部 MCP 与 CLI 的实际访问能力仍取决于其进程权限。

## 6. 记忆、任务与知识库

`记住：…` / `remember: …` 在清除路由标记后匹配正文开头，冒号后全部正文成为记忆；`@atlas 记住：约束` 可以使用。普通提问与记忆写入同时进行。记忆总量最多 1,000 条，单条最多 12,000 字符、20 个标签；超额淘汰最旧记录，尚无编辑/删除接口。

`任务：…` / `task: …` 可出现在清洗后的任意独立行，每条消息只提取第一个任务。owner 为第一个路由目标，初始状态 todo，可经 API 更新为 doing/done；待办不自动启动执行计划，也没有删除接口。

不带 threadId 的记忆和任务属于全局；带 threadId 的记录归属当前会话。记忆检索覆盖最多 1,000 条保留记录，不受 HTTP 展示页大小限制。关键词排名结合词项重叠、重要度和时间衰减；可选 embedding 增加语义召回。

知识库支持 TXT / Markdown 和粘贴文本，提供 BM25、可选向量与 RRF 混合检索、按范围隔离、原文读取、去重和删除。单文档 200,000 字符，最多 100 份、合计 5,000,000 字符。尚无 PDF/Word/OCR 或网页自动抓取。

只有提供给模型且在最终回答中使用的 `memory:<id>` / `knowledge:<chunkId>` 会生成引用卡片。知识引用保存原文与行号；引用存在不等于论断已被自动证实。详见 [Embedding 与向量检索](EMBEDDING-RETRIEVAL.md)。

## 7. Provider、流式与 CLI 会话

- OpenAI-compatible 使用 Chat Completions，支持文本流式、工具调用、JSON Schema、usage 和缓存读取计数。`OPENAI_STREAM=0` 可关闭流式；服务返回 JSON 时可直接解析。示例显式配置 `OPENAI_MODEL="你的模型ID"`，替换为网关实际支持的名称。
- 原生 Anthropic 使用 `@anthropic-ai/sdk`，支持流式、工具协议、结构化输出、prompt caching 与 usage。设置 `ANTHROPIC_API_KEY`，仅此密钥存在时作为默认；同时配置两类密钥时可用 `ORBIT_DEFAULT_PROVIDER=anthropic` 选择。
- OpenAI-compatible 与 embedding 使用重试/退避工具，Anthropic 使用 SDK 重试；重试耗尽或解析失败后，聊天 Provider 回退 LocalProvider 并记录原因。恢复成功清除 `lastError`。流中断不承诺从已生成 token 处继续。
- LocalProvider 是确定性离线演示，不具有真实模型任务完成能力；不能用于计划验收。
- Codex / Claude Code / Pi 每次调用启动非交互子进程，结束后解析输出。外部工具和权限由 CLI 管理，当前无 CLI 实时增量桥接或交互式 PTY。

Codex 和 Claude Code 已支持按线程、Agent 绑定原生 session，并在 Provider、命令参数、cwd、角色及 system prompt 配置指纹匹配时续接。Pi 尚无对应续接实现。每轮仍发送 Orbit 组装的有限上下文；这不是从中断工具步骤恢复执行。

`DELETE /api/threads/:id/agents/:agentId/session` 清除 Orbit 的绑定，下一轮开启新 CLI 会话；运行中返回 409。它不会删除外部 CLI 的历史文件。分支不继承绑定；同一线程同一 Agent 的并发辅助调用不会同时复用绑定。

## 8. 事件、接口与界面

持久事件包括路由、上下文、Agent 开始/结束/失败、模型步骤、工具、委派、讨论、计划、审批和 session 绑定/重置。runId 贯穿 Agent 事件，子任务带 parentRunId，步骤还带计划关联字段。

`agent.delta` 是瞬时文本增量：只广播、不落盘、没有 SSE id。持久事件先落盘后广播。SSE 先订阅再按每页 500 条补放仍保留的事件，优先使用 Last-Event-ID；客户端按事件 ID 去重。断线期间增量不补发，最终回答通过持久消息刷新恢复。全局事件只保留最近 1,200 条。

API 完整列表见 [README](../README.md#api-速查)，错误码和架构边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。前端通过 HTTP 与 SSE 投影状态，包括会话、计划版本、知识库、记忆、任务与审批；用户和模型文本转义后渲染。

当前 HTTP 没有多用户认证，但已移除 CORS 响应头，并校验 API 的 Host 和写请求 Origin；这不等于账号与租户权限。其他尚未实现的能力见 [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md)。

## 9. 验证

`npm test` 运行自动测试，`npm run check` 检查源码语法（不执行 TypeScript 类型检查）。`npm run demo:collaboration` 与 `npm run demo:workflow` 使用确定性模拟 Provider 演示协议；`npm run check:ui` 单独执行浏览器流程。覆盖与已知限制见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。
