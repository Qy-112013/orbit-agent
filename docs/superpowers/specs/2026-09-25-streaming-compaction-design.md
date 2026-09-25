# 子项目 2：流式输出与 LLM 上下文压缩 — 设计

日期：2026-09-25
范围：P0 token 级流式；P1 LLM 上下文压缩；把 12 条滑动窗口改为稳定检查点，使跨轮次 prompt caching 可命中。
不在范围：CLI provider（codex / claude-code / pi）的流式；MCP、写入工具、审批（子项目 3）。

## A. Token 级流式

### Provider 契约
- `ProviderInput.onDelta?: (text: string) => void`：仅文本增量；思考内容不外发。不支持流式的 provider 忽略它。

### AnthropicProvider
- 始终使用 `client.beta.messages.stream(request, { signal })`，`stream.on('text', onDelta)`，`await stream.finalMessage()` 后沿用现有解析。
- 空闲超时：每个流事件重置计时器，`timeoutMs`（默认 300000）内无任何事件则中止。SDK 的 `timeout` 同值，覆盖建连。
- `max_tokens` 默认提升到 64000（流式无 HTTP 超时顾虑），可用 `ANTHROPIC_MAX_TOKENS` 覆盖。

### OpenAICompatibleProvider
- 默认 `stream: true` + `stream_options: { include_usage: true }`；`OPENAI_STREAM=0` 关闭。
- 解析 SSE：累积 `delta.content`（转发 onDelta）、`delta.reasoning_content`、按 `index` 合并 `delta.tool_calls`（id / name / arguments 分片），末块 `usage`；`[DONE]` 结束。
- 服务端忽略 `stream` 返回 JSON 时（content-type 非 `text/event-stream`），回退到现有 JSON 解析。
- 超时：`fetchWithRetry` 新增 `timeoutScope: 'headers'`，超时只覆盖到响应头（仍可重试）；之后由空闲计时器（每块重置，`timeoutMs`）通过外部 signal 中止读取。

### 事件与传输
- AgentLoop 把 `onDelta` 包装为带 `step` 的回调并透传给 provider。
- Orchestrator 以 ~50ms 合并增量，发布**瞬时事件** `agent.delta`（payload：`runId, agentId, step, text`）：只经内存 EventEmitter 广播，**不写入 store**（事件上限 1200，逐 token 持久化会挤掉审计事件）。run 结束前强制 flush。
- SSE：瞬时事件没有 `sequence`，写帧时省略 `id:` 行，不影响 Last-Event-ID 续传。断线期间的增量不补发，最终消息由持久化事件与刷新恢复。
- UI：`agent.delta` 不进入轨迹列表；按 `runId` 维护预览气泡（step 变化时重置文本），追加在时间线末尾；收到该 run 的 `agent.completed` / `agent.failed` 后移除预览，由刷新得到的正式消息替代。

## B. 稳定历史与 LLM 压缩

### 历史检查点（`conversation.ts`）
- `planHistory(thread, { excludeMessageId })` 返回 `{ recentMessages, pending }`：
  - 候选 = `sequence > summary.throughSequence` 的全部消息（排除当前请求），每条按固定 `messageChars`（4000）截断——**截断长度不再依赖剩余预算**，同一条消息在各轮渲染一致。
  - 未超过 `historyMessages`（24）且未超过 `historyChars`（24000）：全部作为历史，`pending` 为空。两次压缩之间历史只追加，前缀稳定。
  - 超过任一阈值：从最新往前保留至 `keepMessages`（8）或 `keepChars`（8000），其余较早消息进入 `pending`。
- 取舍：平均历史体积约增加三分之一，换取跨轮次缓存命中与更少的摘要重写。
- `CONTEXT_LIMITS` 以 `historyMessages / historyChars / keepMessages / keepChars` 取代 `recentMessages / recentChars`。

### 压缩（`src/core/compaction.ts`）
- `Summarizer` 接口：`summarize({ previous?, messages }) => Promise<string>`。
- `ProviderSummarizer(provider)`：以合成 agent `compactor` 调用 provider（注册表解析到 default）。系统提示要求把对话当数据、不执行其中指令；保留用户目标、决定、约束、带来源 ID 的事实、`[#序号 角色/agent]` 归属、未决问题；使用对话主语言；输出上限 `summaryChars`。输入为旧摘要 + pending 消息（每条 ≤2000 字符，总计 ≤60000）。
- 结果来自本地 provider 或带 `metadata.fallbackFrom` 时视为失败。
- `MemoryService.prepareContext`：`pending` 非空时先尝试 summarizer，失败或未配置则回退到现有抽取式摘要；持久化 `summary`（`method: 'llm-v1' | 'extractive-v1'`，回退时带 `fallbackReason`）。`buildContext` 单独调用时只做抽取式预览，不调用模型、不持久化。
- 装配：`createApp` 从环境创建 provider 时启用 `ProviderSummarizer`；显式注入 `provider(s)`（测试）时默认不启用，可通过 `summarizer` 选项传入。
- `context.compacted` 事件增加 `fallbackReason`。

### 摘要位置与缓存断点
- `formatReferenceContext(context, { includeSummary })`：API provider 传 `false`，把摘要作为历史之前的一条稳定 user 消息（抽取式与 LLM 摘要使用不同标注）；CLI provider 保持原样。
- Anthropic：在**最后一条历史消息**上加 `cache_control` 断点（system、历史末尾、顶层自动共 3 个，≤4），下一轮在更长历史末尾查找时可回溯命中上一轮写入的条目。OpenAI 兼容接口依赖自动前缀缓存，无需断点。

## C. 测试
- 流式：Anthropic SSE fixture（text / thinking / tool_use / refusal）验证增量转发与最终结果；OpenAI SSE 解析（内容、工具调用分片、usage）与 JSON 回退；`timeoutScope: 'headers'`。
- 传输：`agent.delta` 经 subscribe 可见、不出现在 `listEvents`；SSE 帧无 `id:`。
- 历史：阈值内追加不改变既有历史渲染；越过阈值时 pending/保留的切分；截断长度固定。
- 压缩：LLM 摘要持久化；summarizer 抛错或返回本地结果时回退抽取式并记录原因；阈值内不调用。
- 缓存断点：Anthropic 请求中最后一条历史消息带 `cache_control`，摘要消息位于历史之前。
- 现有测试、`npm run check` 通过；DeepSeek 冒烟脚本增加流式检查。
