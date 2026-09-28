# Orbit Agent 架构设计文档

> 当前实现说明，核对日期：2026-09-28，包版本：0.3.0。启动入口为 [server.ts](../src/server.ts)，Node.js 25+ 直接运行 TypeScript；运行时依赖包含 `@anthropic-ai/sdk`。

## 1. 系统与模块边界

Orbit 是本地优先、单进程的个人多 Agent 工作台。浏览器通过 HTTP JSON 和 SSE 访问运行时；状态权威在服务端。默认监听 127.0.0.1:3030。

```text
Browser: public/index.html + app.js + styles.css
    │ HTTP / SSE（持久事件 + 瞬时文本增量）
    ▼
src/server.ts（装配根、路由、Host/Origin 校验）
    ├─ Orchestrator（线程队列、路由、协作、run/session 关联）
    │   ├─ AgentLoop（模型/工具交换、预算、审批）
    │   └─ PlanExecutor（规划 → 步骤 → 复核 → 有限重规划）
    ├─ MemoryService + Conversation + ProviderSummarizer
    ├─ KnowledgeService + VectorIndex + EmbeddingProvider
    ├─ ToolRegistry + WorkspacePolicy + WorkspaceTools + ApprovalBroker
    ├─ SkillRegistry + McpManager（外部 stdio server）
    ├─ ProviderRegistry
    │   ├─ OpenAI-compatible / Anthropic
    │   ├─ Codex / Claude Code / Pi CLI
    │   └─ LocalProvider fallback
    └─ JsonStore（领域状态串行写入）
src/mcp-server.ts（独立 stdio 入口、独立状态文件、共享工具实现）
```

| 模块 | 职责 |
| --- | --- |
| [types.ts](../src/core/types.ts)、[contracts.ts](../src/core/contracts.ts) | 领域类型、事件词汇、Provider 与 Storage 接口 |
| [agent-registry.ts](../src/core/agent-registry.ts)、[router.ts](../src/core/router.ts) | 稳定身份、别名、mention 与控制标签解析 |
| [orchestrator.ts](../src/core/orchestrator.ts) | 线程排队、有限协作、上下文装配、消息与事件持久化 |
| [agent-loop.ts](../src/core/agent-loop.ts)、[planner.ts](../src/core/planner.ts) | 模型/工具循环与结构化计划执行 |
| [conversation.ts](../src/core/conversation.ts)、[compaction.ts](../src/core/compaction.ts)、[memory.ts](../src/core/memory.ts) | 稳定历史前缀、模型摘要/抽取兜底、长期记忆召回 |
| [knowledge.ts](../src/core/knowledge.ts)、[embeddings.ts](../src/core/embeddings.ts)、[vector-index.ts](../src/core/vector-index.ts) | 文本分块、embedding、余弦与关键词混合检索、独立向量缓存 |
| [tools.ts](../src/core/tools.ts)、[workspace-policy.ts](../src/core/workspace-policy.ts)、[workspace-tools.ts](../src/core/workspace-tools.ts)、[approvals.ts](../src/core/approvals.ts) | 工具注册与参数校验、文件路径约束、写入/shell、人工决策 |
| [providers.ts](../src/core/providers.ts)、[anthropic-provider.ts](../src/core/anthropic-provider.ts)、[cli-provider.ts](../src/core/cli-provider.ts) | 模型和 CLI 协议适配、流式/结构化输出、原生 session、降级 |
| [retry.ts](../src/core/retry.ts)、[structured-output.ts](../src/core/structured-output.ts) | 重试退避与 Provider JSON Schema 转换 |
| [skills.ts](../src/core/skills.ts)、[mcp-client.ts](../src/core/mcp-client.ts) | Markdown Skill 匹配、外部 MCP 连接和工具注册 |
| [store.ts](../src/core/store.ts) | schema v2 领域状态、查询、限额、串行持久化 |
| [server.ts](../src/server.ts)、[mcp-server.ts](../src/mcp-server.ts) | Web 与 stdio 两个装配入口 |

## 2. 领域状态与文件

主要对象是 Agent、Thread、Message、Memory、Task、ExecutionEvent、KnowledgeDocument/Chunk、ExecutionPlan。Thread 包含摘要和按 Agent 保存的原生 CLI 会话绑定；Plan 保存每版步骤、结果、复核和执行计数。

Web 默认状态为 `data/state.json`，向量缓存为 `data/state.json.vectors.json`。MCP stdio 使用 `data/mcp-state.json` 及对应向量文件，不自动同步 Web 状态。自定义 dataFile 时向量文件为 `<dataFile>.vectors.json`，文件覆盖备份位于数据文件所在目录的 `backups/`。

JsonStore 兼容 v1 输入，规范化为当前 schema v2。向量是可重建缓存；来源正文和引用保留在领域状态中。工作区与线程范围用于资料组织和检索隔离，不是多租户访问控制。

## 3. 一轮执行

1. 验证请求并加入线程队列；持久化原始用户消息，发布 `message.accepted`。
2. 确定目标与策略，发布 `route.decided`；从清洗后的正文识别显式记忆命令。
3. 准备历史和摘要、召回记忆与知识、匹配 Skills；发布上下文/检索及必要的压缩事件。
4. 根据策略执行单 Agent、串行、并行、两轮讨论或计划；每个 run 独立保存本轮模型/工具交换记录。
5. 工具调用经过预算、名称和参数校验；需审批的调用先等待决策；真实结果按 toolCallId 回传给模型。
6. 将最终回答或失败说明写入消息，持久化 run 事件；成功的原生 CLI 会话可更新绑定。
7. 从用户正文提取第一个显式任务，追加协作/计划状态消息，更新 active Agent，发布 `execution.completed`。

计划的 planning/review 阶段使用结构化输出且不提供 Orbit 模型工具；步骤阶段执行 AgentLoop。模型判断的验收结论不等于实际测试、权限批准或部署门禁。

## 4. 并发、持久化与恢复

`Orchestrator.activeRuns` 串行处理同线程提交，第二条消息会排队；不同线程可并发。归档检查同时考虑运行状态与持久化阶段。`clientRequestId` 只记录，不去重。

`JsonStore.mutate` 通过 writeChain 串行修改内存状态并落盘。每次持久化序列化整份 JSON，先写临时文件再 rename。rename 失败时会退回直接覆盖目标文件，此路径失去原子替换保障；写入失败也没有完整的内存事务回滚。多进程不能共同写同一状态文件。

API/CLI 失败可保留线程并回退本地演示；这不表示未完成工具可以安全重放。重启时进行中的计划标为 interrupted，正在运行的步骤标为 failed，保留完成证据。待审批调用、在途模型/工具记录和运行队列只在内存中，不能断点续跑。

Codex / Claude Code 按 threadId + agentId 保存 sessionId 和配置指纹。匹配时续接，不匹配时新开会话；并发辅助 run 不争用同一个绑定。分支不复制绑定。重置 API 清除 Orbit 绑定，不删除 CLI 历史。Pi、统一取消、后台任务恢复和 worktree 隔离尚未实现。

## 5. 事件与 SSE

持久事件的 sequence 全局递增，先持久化再广播。主要类别：

| 类别 | 事件 |
| --- | --- |
| 请求与上下文 | `message.accepted`、`route.decided`、`context.retrieved`、`context.compacted`、`knowledge.retrieved` |
| Agent 与模型步骤 | `agent.started/completed/failed`、`agent.step.started/completed`、`provider.fallback` |
| 工具与委派 | `tool.called/started/completed/failed`、`agent.delegated/returned` |
| 讨论与计划 | `discussion.round.started/completed`、`plan.created/updated`、`plan.step.started/completed/failed`、`plan.reviewed/replanned/completed` |
| 人工决策与 CLI | `approval.requested/resolved`、`session.bound/reset` |
| 回合收尾 | `execution.completed` |

runId 贯穿 Agent 生命周期，父子 run 通过 parentRunId/handoff 关联，计划运行还携带 planId、planRevision、planStepId 和 requestMessageId。

`agent.delta` 例外：它是约 50 ms 合并的瞬时文本增量，只经 EventEmitter 广播，不进入 JsonStore，没有 sequence，SSE 不写 id 行。推理内容不作为文本增量对外显示。

普通事件查询默认返回最新 500 条；显式 after 向后读取。SSE 优先读取 Last-Event-ID，再取 URL after，先订阅再按每页 500 条补放仍保留的持久事件。可能重复，由客户端去重。每 15 秒心跳。全局只保留最近 1,200 条事件；已淘汰事件与断线期间的文本增量不能补放，最终消息由刷新恢复。

## 6. Provider 与上下文

ProviderRegistry 按 Agent 专属注册、声明的 Provider、默认 Provider 解析。默认模型选择与配置见 [README](../README.md#provider-与-cli-适配器)。

OpenAI-compatible 提供 Chat Completions 流式、工具调用和 strict JSON Schema；Anthropic 使用官方 SDK 的流式、工具内容块、结构化输出和缓存控制。JSON Schema 先做 Provider 兼容转换，返回仍须通过本地校验。usage 归一化记录输入/输出 token 和缓存读写计数；缓存命中取决于模型服务及实际上下文，不保证每轮命中。

OpenAI-compatible/embedding 对临时 HTTP 状态及网络错误进行有限重试和退避，Anthropic 由 SDK 重试。OpenAI-compatible 默认响应头及流空闲超时为 45 秒，Anthropic 默认 300 秒；流中断不承诺续传。恢复成功清除 fallback 的 lastError。

历史最多 24 条/24,000 字符，超限后保留最多 8 条/8,000 字符并压缩较早消息。正常环境装配用默认 Provider 摘要；测试显式注入 Provider 时默认不启用模型摘要，可另注入 summarizer。失败使用抽取式摘要并注明 fallbackReason。模型/工具交换只属于当前 run，不作为完整可恢复会话日志落盘。

知识和记忆可用独立 embedding 服务；关键词与余弦排名以 RRF 融合。查询先限制资料范围，本地向量索引精确扫描，不是 ANN 或分布式向量数据库。详见 [EMBEDDING-RETRIEVAL.md](EMBEDDING-RETRIEVAL.md)。

## 7. 工具、安全与 MCP

Web 注册只读工具及需审批的 workspace_write/workspace_edit/shell_exec。模型只获得只读工具，或 approval 策略下显式声明审批行为的工具；remember/create_task 仍由用户命令、API 或 MCP 服务端触发。审批请求和决策留痕，pending 状态仅在内存中。

文件工具解析实际路径，拒绝工作区外路径、秘密环境文件；写入另拒绝 .git 和 Orbit 数据目录。允许 .env.example 模板。shell 过滤敏感环境变量、拦截已知删除命令、限制输出及超时；这些约束不提供 OS 文件系统隔离。CLI 继承自身运行环境和权限，不经过 Orbit 工具审批；外部 MCP 的执行权限由其进程决定。

MCP 服务端只暴露默认工具与 Skill resources，不注册 workspace 写入/shell 工具。MCP 客户端支持 stdio 握手、工具分页、list_changed 和调用；外部工具默认逐次审批，配置 autoApprove 的工具免审批。图像/音频结果压成占位说明，不作为多模态模型输入。当前没有 HTTP/SSE MCP transport 或 OAuth，也没有自动重连治理。

HTTP 已移除 CORS 响应头。API Host 默认仅允许 localhost、127.0.0.1、[::1]，可用 ORBIT_ALLOWED_HOSTS 扩展；非 GET/HEAD 请求若带 Origin，要求其 host 与请求 Host 一致。没有 Origin 的本地 API 客户端可调用。此检查不替代身份认证；当前没有账号、组织权限或限流。

## 8. API 与容量

完整端点见 [README API 速查](../README.md#api-速查)。JSON 错误形如 `{ error: { code, message } }`，具体状态码映射以 server.ts 为准。未知 API 返回 404；未知静态资源仍回退 index.html 并返回 200。

| 对象 | 当前限额 |
| --- | --- |
| HTTP 请求体 / 消息正文 | 1,000,000 字节 / 30,000 字符 |
| 每会话消息 / 全局事件 / 记忆 | 500 / 1,200 / 1,000 条 |
| 单条记忆 / 引用 / 记忆标签 | 12,000 字符 / 每消息 12 条 / 每记忆 20 个 |
| 待办标题 | 240 字符 |
| 历史 / 压缩后保留 / 单消息历史 | 24 条且 24,000 字符 / 8 条且 8,000 字符 / 4,000 字符 |
| 摘要 / 记忆正文 / 知识正文预算 | 5,000 / 4,000 / 7,000 字符 |
| 知识文档 | 100 份、总计 5,000,000 字符、单份 200,000 字符 |
| 文本块 / 重叠 | 1,200 / 160 字符 |
| 默认 AgentLoop | 5 次模型调用、8 次工具请求、每结果 8,000 字符 |
| 协作 | 2 次委派、深度 1；讨论 2–4 人、两轮加汇总 |
| 计划 | 每版 5 步、2 次重规划、总计 8 次步骤执行；最多 100 个保留计划 |
| 文件写入 / shell 输出 | 200,000 字节 / stdout、stderr 各末尾 32,000 字节 |
| 审批 / shell / CLI / MCP 请求默认超时 | 600 / 60 / 120 / 60 秒 |

限额以各模块导出的常量及环境配置为准。计划数量超限时优先淘汰较早终态记录；消息和事件淘汰意味着原始历史/轨迹不永久保存。

## 9. 验证与演进

自动测试覆盖编排、隔离、持久化、检索、流式、审批和协议失败；确定性 fixtures 不证明真实模型质量或 OS 沙箱安全。`npm run check` 只检查语法。测试入口与当前待改进项见 [IMPLEMENTATION.md](IMPLEMENTATION.md)，范围与后续方向见 [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md)。
