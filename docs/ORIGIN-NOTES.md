# Architecture notes

Orbit Agent is an independent, dependency-free agent workspace. Its design
focuses on a small set of explicit boundaries that are easy to inspect and
replace:

- stable Agent identities;
- thread/message continuity;
- explicit mention routing;
- serial and parallel execution;
- bounded memory recall;
- capability allow-listing;
- durable event traces.

The runtime keeps provider and storage integrations behind local interfaces so
the core workflow remains deterministic and easy to run on a fresh checkout.

## 本次协作扩展的来源记录

本表区分源码设计参考、产品架构对照和 CLI 接入。新增实现位于 Orbit 本地模块，没有引入 Pi/OpenCode 的运行时依赖，也没有复制其源码文件。

| 来源 | 核对内容 | Orbit 中的应用 |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) | AgentMessage 与模型消息边界；模型/工具循环；阶段事件；子 Agent 扩展示例中的独立上下文、结果回传与链式工作流 | `agent-loop.ts`、逐次工具消息、父子 run、受限委派；工具采用串行执行 |
| [OpenCode task 工具](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts) | 显式目标 Agent、父子会话、结果状态和默认委派深度限制 | `delegate_to_agent` 参数、父子 run 关联、1 层深度与每轮共享配额 |
| [Clowder AI](https://github.com/zts212653/clowder-ai) | 本地 README、服务模块与依赖：团队层、责任交接、跨模型审查、记忆与护栏 | 对照现有协作层的定位与能力边界；本次没有移植其服务模块 |

Pi 核对版本：`08dc60bc52d89d6823a9738cc90b1916e5e446e5`。

- [Agent core 文档](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/agent/README.md)
- [Agent loop 入口](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/agent/src/agent-loop.ts)
- [Subagent 扩展示例](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/examples/extensions/subagent/README.md)

Pi 官方默认不内置子 Agent；上述子 Agent 能力来自官方仓库提供的扩展示例。旧地址 `badlogic/pi-mono` 现重定向至 `earendil-works/pi`。

本次核对的 Pi 与 OpenCode 仓库采用 MIT 许可。未来如直接复制或改编上游代码，应保留相关版权和许可声明，并标明具体来源。本项目没有采用所谓 Claude Code 泄漏源码；Claude Code 仍作为通过公开 CLI 调用的外部执行端。

## v0.3 会话连续性对照

本轮只读核对的本地 Clowder checkout 为 `9f6ac2069`：

- `packages/api/src/domains/cats/services/session/buildThreadMemory.ts`：规则式滚动摘要、结构化决策与来源引用。
- `packages/api/src/domains/cats/services/session/SessionBootstrap.ts`：为后续会话组装摘要、任务快照和召回提示，并限制注入预算。
- `packages/api/src/routes/thread-branch.ts`：以指定消息为边界创建分支。

Orbit 的 `conversation.ts`、`knowledge.ts` 与 `planner.ts` 是独立实现：按字符预算生成历史摘录，以 BM25 检索文本分块，并使用结构化计划、执行结果和复核反馈驱动有限重规划。没有移植 Clowder 的原生会话链、存储服务或审核权限机制，也不据此宣称检索算法与上游等价。
