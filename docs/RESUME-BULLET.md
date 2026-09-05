# Orbit Agent 简历项目描述（可直接改写）

## 中文（一句话）

**Orbit Agent｜可持久化多 Agent 协作工作台**：设计并实现稳定 Agent 身份、`@mention` 驱动的串行/并行编排、有限上下文记忆检索、可插拔 OpenAI-compatible Provider、allow-list 工具注册，以及基于 SSE 的可回放执行轨迹；通过单写入 JSON 存储和 Provider 降级策略保证离线可运行与状态一致性。

## 面试展开点

1. **为什么做减法？** 作品集版本只保留一次 Agent turn 必需的五个对象：Thread、Message、Agent、Memory、Event；把产品边界控制在一条可验证的协作闭环。
2. **为什么先路由再调用模型？** mention 与执行策略是确定性业务逻辑，不能交给模型猜；因此先生成可审计 route plan，再组装有限上下文。
3. **并行如何保证可观察？** 每个 target 有独立 started/completed 事件；结果写入同一线程，SSE 只做投影，断线后可按 sequence 补放。
4. **为什么有 LocalProvider？** 让测试与演示不依赖 API key；真实 Provider 失败自动降级，验证“外部依赖失败不破坏会话持久性”。
5. **未来怎么扩展？** 把 `JsonStore` 换成 SQLite/Redis、把 `MemoryService` 换成 embedding+rerank，不需要改 Router、Orchestrator 或前端事件协议。
