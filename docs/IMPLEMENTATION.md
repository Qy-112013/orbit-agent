# Orbit Agent 实现与维护说明

> 当前代码核对日期：2026-09-28，包版本：0.3.0。本文替换早期 JavaScript 内核走读；模块路径与行为以当前 TypeScript 实现为准。

## 1. 阅读入口

- 使用和配置：[README](../README.md)。
- 能力及输入语法：[CORE-FEATURES.md](CORE-FEATURES.md)。
- 模块图、状态与容量：[ARCHITECTURE.md](ARCHITECTURE.md)。
- 会话、引用、计划：[SESSION-RAG-PLANNING.md](SESSION-RAG-PLANNING.md)。
- 混合检索：[EMBEDDING-RETRIEVAL.md](EMBEDDING-RETRIEVAL.md)。
- 委派和讨论：[COLLABORATION-EXTENSION.md](COLLABORATION-EXTENSION.md)。

源码和测试使用 .ts，前端为原生 app.js；scripts/check-syntax.mjs 仍是 JavaScript。package.json 当前有 @anthropic-ai/sdk 运行时依赖。

## 2. 启动与装配

[server.ts](../src/server.ts) 的 createApp 依次完成：

1. 初始化 JsonStore，恢复用户注册 Agent 和持久化状态；重启中的计划标为 interrupted。
2. 建立 AgentRegistry 与 ProviderRegistry；支持显式注入 Provider、embeddingProvider、summarizer 和 loopOptions。
3. 初始化独立向量缓存、MemoryService 与 KnowledgeService；正常环境配置使用 ProviderSummarizer，测试注入可单独控制摘要。
4. 加载 skills/ 下 Markdown，注册默认工具及 Web 专用写入/shell 工具。
5. 创建 McpManager，后台连接配置中的 stdio server；失败记录在状态中，不阻止 Web 启动。
6. 创建 Orchestrator、ApprovalBroker、AgentLoop、PlanExecutor 和 HTTP/SSE 路由。

直接运行 npm start 不自动载入 .env 文件；使用进程环境变量，或明确通过 Node 的 --env-file 参数启动。密钥仅在服务端配置。首次无会话时创建欢迎线程。Web 与独立 MCP 入口各有状态文件，见架构文档。

## 3. 核心执行路径

[orchestrator.ts](../src/core/orchestrator.ts) 的 submitMessage 校验并排队，_submit 持久化用户消息、路由、解析显式命令、准备上下文、执行策略并收尾。runAgent 负责每次调用的身份、runId、父子关联、引用、失败消息、瞬时增量和 CLI session 绑定。

[agent-loop.ts](../src/core/agent-loop.ts) 保存本轮 transcript，向 Provider 提供允许的工具，将工具结果按 toolCallId 回传。每批执行前检查预算和重复 ID，逐个调用工具；工具失败作为结构化错误交回模型。规划/复核阶段传 responseSchema 并关闭 Orbit 模型工具。

[planner.ts](../src/core/planner.ts) 校验 owner、步骤 ID 和前序依赖，依次执行、保存版本、复核及有限重规划。返回普通赞同文本不能算通过；LocalProvider 或降级也不能通过计划验收。依赖字段用于顺序校验，当前不是并行 DAG 调度。

## 4. Provider 和上下文

[providers.ts](../src/core/providers.ts) 提供 OpenAI-compatible、LocalProvider、FallbackProvider 和按 Agent 解析的 ProviderRegistry。OpenAI-compatible 的 stream 默认为 true，可用 OPENAI_STREAM=0 关闭；接口返回 JSON 时也能解析。模型名建议显式填写网关可用 ID，例如 OPENAI_MODEL="你的模型ID"。

[anthropic-provider.ts](../src/core/anthropic-provider.ts) 使用 SDK 流式接口，保留工具调用所需原始内容块，发送结构化输出与缓存配置，归一化 usage。当前默认 maxTokens 为 64,000，timeoutMs 为 300,000，maxRetries 为 2；模型及相关参数可从环境配置。

[retry.ts](../src/core/retry.ts) 处理临时状态、网络错误和退避；[structured-output.ts](../src/core/structured-output.ts) 转换 Provider 支持的 schema 子集，最终仍由本地验证。FallbackProvider 成功后清除 lastError，失败返回 fallbackFrom/fallbackError，AgentLoop 发布 provider.fallback。

[conversation.ts](../src/core/conversation.ts) 按固定字符预算形成稳定历史前缀；[compaction.ts](../src/core/compaction.ts) 使用默认 Provider 压缩，失败转抽取式摘要并记录原因。Skills、召回知识及记忆在上下文中作为资料使用；来源引用由 [context-format.ts](../src/core/context-format.ts) 筛选。模型推理协议状态不直接写入浏览器消息或持久执行事件。

## 5. CLI、MCP 与审批

[cli-provider.ts](../src/core/cli-provider.ts) 解析可执行文件（含 Windows npm shim）、组装 prompt、校验 cwd、收集有限 stdout/stderr，并解析 text/JSON/JSONL。Codex 与 Claude Code 支持原生 session 续接，Pi 尚无此实现。绑定包含配置指纹，分支不继承，可经 API 清除；相同 thread/agent 的并发 run 用 sessionOwners 避免共享同一个绑定。

[approvals.ts](../src/core/approvals.ts) 把等待中的决策放入内存 Map，持久化请求和决定事件；超时及关闭时拒绝。审批没有持久化待执行队列。

[workspace-tools.ts](../src/core/workspace-tools.ts) 实现文件预览、备份、写入、精确替换与 shell。文件通过 [workspace-policy.ts](../src/core/workspace-policy.ts) 做路径检查。删除命令拦截是有限规则，不等于 OS 沙箱。shell 超时尝试回收进程树；CLI 超时目前仅 child.kill()，两者不可混同。

[mcp-client.ts](../src/core/mcp-client.ts) 连接外部 stdio server，处理工具分页与列表变化，命名空间注册工具。默认审批，可配置 autoApprove；外部 schema 原样交给模型，本地只校验参数对象。连接失败会记录错误并撤销工具，不自动重连。

[mcp-server.ts](../src/mcp-server.ts) 使用默认工具与 Skill resources，不注册 workspace 写入和 shell。领域工具 remember/create_task 可以被 MCP 客户端调用，因此 MCP 服务端并非所有操作都只读；它与 Web 使用独立状态文件。

## 6. 扩展入口

| 修改方向 | 推荐入口与约束 |
| --- | --- |
| 新 Agent | AgentRegistry / POST /api/agents；身份持久化，Provider 配置在启动时装配 |
| 新模型 | ProviderAdapter / ProviderRegistry；保留工具协议、引用与失败 metadata |
| 新工具 | ToolRegistry 注册 inputSchema、execute、readOnly 或 approval；副作用工具提供预览并走审批 |
| 新 Skill | skills/ 下 Markdown + name/description/keywords；当前为关键词匹配，无市场或热更新 |
| 新存储 | StoragePort 与 JsonStore 的实际调用面；保留队列、事件序号和作用域语义 |
| 新检索 | KnowledgeService / MemoryService / VectorIndex；保留来源 ID、范围限制与关键词兜底 |
| 新界面 | public/app.js 投影服务端状态；同时考虑迟到响应、线程切换及 SSE 去重 |

不要把模型返回的文本视为已执行证据，也不要将回放事件等同于恢复工具执行。会影响副作用的改动需要同时检查审批和失败路径。

## 7. 验证命令与覆盖

```bash
npm ci
npm test
npm run check
npm run demo:collaboration
npm run demo:workflow
npm run check:ui
```

npm test 使用 Node 内置 runner；npm run check 使用 Node --check 检查 src 下 TypeScript 的可解析性和 public/app.js，**不运行 tsc 类型检查**。tsconfig.json 的 strict/noEmit 是类型检查配置，package scripts 尚未提供完整类型检查门禁。

两个 demo 使用固定模拟 Provider，不需要真实模型密钥；check:ui 使用独立浏览器配置和临时状态，产物在 .orbit-artifacts/ui/。浏览器检查不是 npm test 的一部分。真实 API / CLI 接入和检索质量另行验证，不能从 fixture 通过推断。

| 行为 | 现有测试 |
| --- | --- |
| 路由、同线程排队、失败留痕 | [router.test.ts](../test/router.test.ts)、[orchestrator.test.ts](../test/orchestrator.test.ts) |
| 委派、讨论与预算 | [collaboration.test.ts](../test/collaboration.test.ts)、[agent-loop.test.ts](../test/agent-loop.test.ts) |
| 会话摘要、分支、归档与 API | [conversation.test.ts](../test/conversation.test.ts)、[workflow-server.test.ts](../test/workflow-server.test.ts) |
| 重规划、非法结构、重启中断 | [planner.test.ts](../test/planner.test.ts) |
| 检索、向量与来源 | [knowledge.test.ts](../test/knowledge.test.ts)、[memory.test.ts](../test/memory.test.ts)、[embeddings.test.ts](../test/embeddings.test.ts)、[vector-retrieval.test.ts](../test/vector-retrieval.test.ts) |
| Provider、重试、结构化输出、流式 | [providers.test.ts](../test/providers.test.ts)、[anthropic-provider.test.ts](../test/anthropic-provider.test.ts)、[reliability.test.ts](../test/reliability.test.ts)、[streaming-compaction.test.ts](../test/streaming-compaction.test.ts) |
| CLI 解析、超时、目录约束 | [cli-providers.test.ts](../test/cli-providers.test.ts) |
| 工具审批、文件/shell 与 HTTP 加固 | [tools-approval.test.ts](../test/tools-approval.test.ts)、[hardening.test.ts](../test/hardening.test.ts) |
| MCP 与 Skills | [mcp-client.test.ts](../test/mcp-client.test.ts)、[mcp-skills.test.ts](../test/mcp-skills.test.ts) |
| 基础存储与 Web API | [store.test.ts](../test/store.test.ts)、[server.test.ts](../test/server.test.ts) |

## 8. 已修复的旧问题

以下条目曾出现在早期文档，已不应继续列为当前缺陷。

| 旧说明 | 当前行为及依据 |
| --- | --- |
| 只有最新 200 条记忆可检索 | listMemories 支持最多 1,000 条；memory.test.ts 覆盖超出展示页的召回 |
| 同线程第二条提交复用第一条结果、内容丢失 | submitMessage 排队；orchestrator.test.ts 覆盖并发提交 |
| 前置 @mention 导致记忆命令不识别 | 从 route.cleanContent 解析；任务也使用清洗后的正文；记忆仍要求正文开头，任务只取首个匹配行 |
| Provider 恢复后 lastError 不清除 | FallbackProvider 成功分支清空，providers.test.ts 覆盖 |
| 只支持非流式、无重试、无模型工具 | API 流式、重试及 AgentLoop 已实现；见对应测试 |
| runId 只出现在开始事件 | 开始/完成/失败与子任务、步骤关联均保留 runId |
| 串行摘要固定显示并行、轨迹不展示错误 | 编排器按策略生成摘要，前端 traceDetail 展示失败信息 |
| SSE 只补 200 条且不读 Last-Event-ID | 每页 500 条循环补放，优先读取 Last-Event-ID；workflow-server.test.ts 覆盖 |
| 浏览器 API 返回通配 CORS | 已移除 CORS，并校验 Host 与写请求 Origin；hardening.test.ts 覆盖 |
| 文件写入、审批、MCP client 尚未实现 | Web 写入/shell、ApprovalBroker、McpManager 已实现 |

## 9. 仍存在的限制与代码风险

下表区分未覆盖的能力和代码可见风险；没有在此声称所有风险均经过故障注入复现。

| 项目 | 当前边界 |
| --- | --- |
| 执行恢复与取消 | 只恢复持久状态；计划中断需重新发起，没有统一取消、持久执行队列、工具检查点或自动续跑 |
| 请求幂等 | clientRequestId 只留痕，重试 POST 可能重复执行 |
| 并行修改 | 无 worktree 或文件锁/冲突协调，多个线程或 Agent 可操作同一 workspace |
| 存储可靠性 | JSON 整体写回；rename 失败直接覆盖，失去原子性；mutate 持久化失败不回滚已改内存；catch 中仍有无实际作用的 if (!error) return |
| CLI 生命周期 | 等进程结束才解析输出，无实时增量/PTY；超时仅终止直接子进程，可能残留后代进程 |
| 原生 CLI session | 已有 Codex/Claude Code 绑定与重置 API；无专门 UI 管理、Pi 续接或失效绑定自动修复；现有 CLI 测试主要覆盖解析/超时，应补专门续接回归测试 |
| 审批与隔离 | pending 只在内存；文件预览与实际写入不具备版本锁；shell/CLI/MCP 没有 OS 沙箱，命令规则不能覆盖任意间接副作用 |
| 计划验收 | 依赖模型复核，没有强制测试/交付物/发布 gate，步骤按顺序执行 |
| 容量与历史 | 消息、事件、记忆和计划有淘汰上限，不提供永久审计；不支持多进程共享状态 |
| 检索与管理 | 文本导入为主，无 PDF/Word/OCR、独立 reranker；记忆无编辑/删除、待办无删除 |
| MCP 与 Skills | stdio 为主，无远程 OAuth/自动重连；Skills 为本地 Markdown 关键词选择，无市场或热更新 |
| Web 边界 | 无多用户认证/限流；未知静态资源回退首页；单独控制标签清洗为空时仍使用原文 |
| 类型检查 | Node type stripping 和语法检查不验证 TypeScript 类型，完整类型检查门禁待补 |

## 10. 调试与维护

| 症状 | 先检查 |
| --- | --- |
| 路由不符 | route.decided 的 targets、strategy、unknown、reason |
| 没召回资料 | context.retrieved / knowledge.retrieved 的实际方法、范围、fallbackReason 与 /api/retrieval 索引状态 |
| 回答变为演示文本 | provider.fallback、消息 metadata 的 fallbackFrom，以及 /api/providers |
| 工具不执行 | /api/threads/:id/approvals、tool.failed、工具策略及预算 |
| CLI 续接失败 | session.bound、配置指纹变化、CLI stderr；必要时在空闲状态调用 session 重置 API |
| 计划停止 | plan.status、各版步骤、复核 feedback；blocked/interrupted 需检查证据后重新规划 |
| 断线后看不到增量 | agent.delta 不补放；先等待持久完成事件并刷新消息 |

修改配置后重启进程。开发模式 watch 重启会断开 SSE、使在途计划中断并丢失 pending 审批；浏览器可重连持久事件，不能恢复内存中的工具执行。

修改代码时遵守 ESM/.ts 导入、显式容量常量、工具参数校验与服务端状态权威；对行为变更运行相关测试。Markdown 更新检查链接、API/常量和当前实现是否一致；历史设计应注明日期与实现状态，避免成为过时的功能清单。
