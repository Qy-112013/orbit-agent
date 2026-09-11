# Orbit 多 Agent 协作扩展

本次扩展优先解决“Agent 能否互相求助、回应和复核”，同时保留轻量部署：没有新增 npm 运行时依赖，继续复用 Provider、线程、JsonStore 和 SSE。

v0.3 的持续会话、文档 RAG、计划执行与重规划见 [SESSION-RAG-PLANNING.md](SESSION-RAG-PLANNING.md)。

## 与 Pi、OpenCode、Clowder 的关系

| 项目 | 已核对的设计 | Orbit 的取舍 |
| --- | --- | --- |
| Pi | 核心提供模型/工具循环；官方扩展示例提供单任务、并行、链式子 Agent，子 Agent 使用单独进程与上下文 | 参考循环与结果回传；Orbit 的每个 run 使用独立模型/工具交换记录，共享明确组装的有限历史与记忆 |
| OpenCode | 原生 task 工具、父子会话、子 Agent 目标与深度约束；后台子任务有独立开关 | 使用受限委派和父子 run；本次采用等待结果后继续的同步流程 |
| Clowder | CLI 之上的团队工作空间，包含责任交接、审查护栏、记忆、终端与更多集成模块 | 保留较小的协作闭环；本次补足委派、回传、讨论复核与证据引用 |

源码和文档来源见 [ORIGIN-NOTES.md](ORIGIN-NOTES.md)。这里的“参考”指明确的设计借鉴；CLI 适配是调用外部程序，不能据此声称项目使用了对应 SDK 或拥有其内部实现。

## 1. 主 Agent 委派并接收结果

适用于支持 function calling 的 OpenAI-compatible API 模型：

~~~text
@atlas 请先让 Forge 提出实现建议，再把结果交给 Lens 复核，最后汇总。
~~~

只 @ 主 Agent；协作者在正文中用名字提及。多个显式 @mention 仍按原有路由规则选择多个入口。

~~~text
用户 → Atlas
         ├─ delegate_to_agent(Forge, 具体任务)
         │    └─ Forge 可读取证据 → 回传内容、状态、messageId
         ├─ delegate_to_agent(Lens, Forge 的结果与审查要求)
         │    └─ Lens 独立复核 → 回传内容、状态、messageId
         └─ Atlas 根据两份结果回答用户
~~~

- 是否委派、委派给谁、怎样描述任务由模型决定，必须落在已注册 Agent 范围内。
- 每轮用户请求共享最多 2 次委派额度，包含并行的主 Agent。一次委派失败也占用额度。
- 深度最多 1 层：子 Agent 不获得委派工具；请求递归委派会收到拒绝信息。
- 子 Agent 单独拥有模型/工具交换记录。它接收指定任务及有限上下文，不接收父 Agent 的内部模型/工具记录。
- 子 Agent 回答写入当前协作线程，并记录 parentRunId、runId、phase 和 messageId；父 Agent 获得结构化结果，再继续推理。
- 子 Agent 失败时回传 failed 状态，父 Agent 可以说明缺口。它不会被当作通过审查。

## 2. Agent 之间两轮讨论

适用于所有现有 Provider，包括非交互 CLI：

~~~text
#discuss @forge @lens 讨论这个方案，互相复核后给出共识和分歧。
#discuss @all 比较方案 A 和 B 的风险，并给出需要验证的证据。
~~~

也可以点击输入区的“两轮讨论”。

1. 第一轮：参与者并行独立回答。
2. 第二轮：每个参与者获得上一轮所有参与者的带来源摘要，点名回应、修订判断或保留分歧。
3. 汇总：第一个参与者读取两轮结果，归纳共识、分歧、证据缺口和下一步。

参与者限定为 2–4 个。每次固定 2 轮加 1 次汇总：2 个 Agent 产生 5 次 Agent 执行，3 个产生 7 次。讨论期间关闭自动委派，避免叠加扇出。某个参与者失败时，其他参与者与汇总仍继续，并接收其失败说明。

“互相复核”表示交换观点并再回答，并不自动等于使用不同模型或强制审核通过。需要跨模型互审时，仍须为不同 Agent 配置不同 Provider。

## 3. 每个 Agent 的工具执行循环

新增 AgentLoop 位于 Orchestrator 与 Provider 之间：

~~~text
Provider 返回工具请求 → 检查权限与参数 → 执行工具
  → 工具结果按 toolCallId 返回给模型 → 下一步模型调用 → 最终回答
~~~

默认上限是每个 Agent run 最多 5 次模型调用、8 次工具请求；拒绝和参数错误也计入工具请求次数。整个批次先检查预算，最后一次模型调用若仍要求工具，则在执行新工具之前停止。

模型可以自主使用 search_memory、search_knowledge、read_knowledge、list_tasks、workspace_list、workspace_read。remember 和 create_task 仍由明确的用户命令或 API 触发。delegate_to_agent 仅在允许委派的父 run 中临时提供。

工具参数执行声明中使用的 JSON Schema 子集校验。文件读取校验实际路径，拒绝指向工作区外的符号链接；单文件读取最多 200,000 字节，返回给模型的单次工具结果最多 8,000 字符，裁剪会明确标记。

网关不支持工具调用时，可设置：

~~~powershell
$env:ORBIT_MODEL_TOOLS="0"
npm start
~~~

此时 Orbit 不向模型提供本地工具或委派工具；串行、并行和两轮讨论仍可使用。CLI 自身的工具、进程与权限依然由外部 CLI 管理，工作目录约束不等于操作系统沙箱。

## 4. 可追踪性与失败处理

所有 Agent 开始、完成、失败事件贯穿同一 runId；子 Agent 额外带 parentRunId。新事件包括：

- agent.step.started / agent.step.completed
- tool.started / tool.completed / tool.failed
- agent.delegated / agent.returned
- discussion.round.started / discussion.round.completed
- provider.fallback

事件沿用“持久化后广播”的路径。SSE 可以补放现有持久事件，界面显示委派方向、讨论轮次、工具失败与降级结果。工具原始文件内容和中间模型正文不会新增写入事件载荷；最终回答仍正常持久化。事件数量仍受 JsonStore 的现有限额约束。

工具失败以结构化错误交回模型；执行上限触发明确的 Agent 失败，后续用户回合仍可运行。外部 Provider 降级到 LocalProvider 时会记录事件，并在回答中标记本地降级。

## 5. 验证与演示

~~~bash
npm test
npm run check
npm run demo:collaboration
~~~

演示不需要密钥，使用固定脚本模拟模型决策，实际调用文件工具、父子 Agent 编排、讨论和持久化。数据放在独立临时目录，结束后清理，不修改现有对话数据。它验证运行时协议，真实模型的任务完成质量需要另行使用已配置 Provider 检验。

测试覆盖结果回传与引用、上下文隔离、共享委派预算、递归拒绝、两轮讨论的数据依赖、Agent 失败恢复、工具调用协议、参数校验、路径边界、结果裁剪和原有功能。

## 6. 当前范围

与 Clowder 仍有明显范围差异：当前没有后台 Agent 邮箱、长期球权状态机、子会话恢复、worktree 隔离、强制 review gate 和组织权限。本次边界是可演示、可验证的有界协作，事件补放不代表进程中断后会自动恢复未完成的工具执行。
