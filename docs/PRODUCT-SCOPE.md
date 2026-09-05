# Product scope

## 目标

Orbit Agent 面向个人开发者和小型团队，解决一个具体问题：当一个任务需要架构、执行和审查等不同视角时，用户不应该手动复制上下文、记住谁负责什么，或猜测系统到底做了哪一步。

## 保留的核心能力

| 能力 | 用户价值 | 技术表现 |
| --- | --- | --- |
| 稳定 Agent 身份 | 结果有明确的角色和责任归属 | `AgentRegistry` + role prompt |
| 持久协作线程 | 重启后仍能接着工作 | `JsonStore` 的 Thread/Message |
| 确定性 mention 路由 | 用户明确指定目标，系统不靠模型猜 | `@atlas/@forge/@lens/@all` |
| 串行/并行编排 | 多视角独立判断或逐步接力 | `Orchestrator` + route strategy |
| 记忆与引用 | 相关事实可复用，来源可追踪 | bounded lexical recall |
| 工具边界 | Agent 能扩展，但能力可审计 | allow-list `ToolRegistry` |
| 可观测执行轨迹 | 能定位路由、上下文、Provider 或存储问题 | persisted events + SSE |
| Provider 可替换 | 不锁死某一家模型，离线也能演示 | OpenAI-compatible + local fallback |

## 暂不做的能力

以下方向不是永远不做，而是当前版本明确排除，避免项目叙事失焦：

- 多用户账号、组织权限和跨 workspace 联邦；
- 任意 shell/PTY 执行和自动修改用户仓库；
- Redis 高可用、向量数据库、复杂 embedding pipeline；
- 桌面安装器、语音、日程、游戏和第三方 IM 连接器；
- 大型插件市场、自动调度和复杂审批治理。

## 后续演进顺序

1. 用 SQLite 替换 `JsonStore`，保留同样的 store 方法和事件序列。
2. 在 `MemoryService` 后加入 embedding + rerank，并保留 lexical fallback。
3. 将 Provider 调用升级为 token streaming，同时复用现有 SSE 事件协议。
4. 为工具增加 capability policy 和人工确认状态。
5. 只有出现真实多用户需求时，才引入 auth 与租户隔离。

