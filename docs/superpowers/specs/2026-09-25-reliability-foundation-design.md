# 子项目 1：可靠性基础 — 设计

日期：2026-09-25
范围：P1 中的模型调用重试/退避、结构化输出、prompt caching，以及为此新增的原生 Anthropic provider。
不在范围：token 级流式、LLM 上下文压缩（子项目 2）；MCP client、写入类工具、人工审批、沙箱（子项目 3）。

## 背景

当前唯一的 API provider 是 `OpenAICompatibleProvider`（原生 fetch，非流式，无重试）。结构化输出靠提示词要求 JSON 后由 `planner.ts` 的 `parseObject` 手动解析。无显式 prompt caching，且 `Reference context` 位于历史消息之前，每轮变化会破坏前缀缓存。

## 决策

- 引入唯一运行时依赖 `@anthropic-ai/sdk`（打破零依赖，换取官方重试、类型化错误与结构化输出支持）。OpenAI 兼容接口继续使用原生 fetch。
- 默认 Anthropic 模型 `claude-opus-5`。

## 1. AnthropicProvider（`src/core/anthropic-provider.ts`）

- 实现 `ProviderAdapter`，`id = 'anthropic'`。构造参数：`apiKey`、`model`（默认 `claude-opus-5`）、`effort`（默认 `high`）、`maxTokens`（默认 16000）、`timeoutMs`（默认 300000）、`maxRetries`（默认 2）、可选 `fetch`（测试注入）。
- 超时取 5 分钟而非沿用 45 秒：本子项目仍是非流式请求，adaptive thinking + `high` effort 在 16000 max_tokens 下单次响应常超过 45 秒；可用 `ANTHROPIC_TIMEOUT_MS` 覆盖。子项目 2 改为流式后再收紧。
- 请求：`client.beta.messages.create`，`thinking: {type: 'adaptive'}`，`output_config: {effort}`，`betas: ['server-side-fallback-2026-07-01']`，`fallbacks: 'default'`。
- system 为单个 text block：agent systemPrompt + skills + `EVIDENCE_INSTRUCTIONS`，带 `cache_control: {type: 'ephemeral'}`；另设顶层 `cache_control: {type: 'ephemeral'}` 缓存历史前缀。
- 消息顺序：历史消息（role 映射同 OpenAI 实现，连续同角色允许）→ 本轮 user 消息（reference context 拼在问题之前）→ transcript。
- tools 按 `name` 排序后映射为 `{name, description, input_schema}`。
- transcript 回放：assistant 轮若带 `providerState`（原始 content blocks 数组）则原样回传；否则由 `content` + `toolCalls` 重建 `text`/`tool_use` 块。连续的 tool 结果合并进**同一个** user 消息的多个 `tool_result` 块。
- 响应解析：`text` 块拼接为 content；`tool_use` 块转为 `ToolCall`（`arguments = JSON.stringify(input)`）；原始 `content` 存入 `providerState`。
- `stop_reason === 'refusal'` 抛错（附 `stop_details.category`），由 `FallbackProvider` 接管。`max_tokens` 且无内容时抛错。
- SDK 负责重试（`maxRetries`）与超时（`timeout`）。

### 注册（`providers.ts`）

- `createProviderFromEnv`：`ORBIT_DEFAULT_PROVIDER`（`anthropic` | `openai`）优先；未设时有 `ANTHROPIC_API_KEY` 且无 `OPENAI_API_KEY` 则用 Anthropic，否则保持现状。
- 每 Agent：`ORBIT_<AGENT>_PROVIDER=anthropic` 时使用 `ORBIT_<AGENT>_API_KEY` 或 `ANTHROPIC_API_KEY`，模型取 `ORBIT_<AGENT>_MODEL` 或 `ANTHROPIC_MODEL`。
- 与 OpenAI 实现一致，默认与每 Agent 注册的 Anthropic provider 都包在 `FallbackProvider` 中。
- 同一 run 内 provider 固定（由 `ProviderRegistry.resolve` 按 agent 决定），`providerState` 只会回传给产生它的 provider；若 run 中途发生 LocalProvider fallback，Local 忽略 `providerState`。
- 环境变量：`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_EFFORT`、`ANTHROPIC_TIMEOUT_MS`、`ORBIT_DEFAULT_PROVIDER`，写入 `.env.example`。

## 2. Prompt caching

**预期收益的边界（基于现状代码）：**
- 当前 agent systemPrompt + skills 远小于最小可缓存前缀（1024–4096 tokens），system 断点单独不会命中。
- `conversationContext` 是 12 条消息的滑动窗口，线程超过 12 条后每轮历史前缀都会平移，**跨轮次缓存基本无效**。
- 真正可命中的是**单个 run 内的 agent loop**：最多 5 次模型调用共享 tools + system + 历史 + 追加式 transcript，前缀严格增长。顶层自动缓存正是覆盖这一场景。
- 因此本子项目只承诺"run 内缓存命中 + usage 可观测"；改造滑动窗口为分块稳定前缀属于子项目 2（LLM 压缩）的职责。

- `OpenAICompatibleProvider` 同步调整消息顺序：reference context 从历史之前移到本轮 user 消息内（问题之前），使 system + 历史成为稳定前缀，tools 同样按名称排序。
- usage 归一化为 `{promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens}`：
  - Anthropic：`input_tokens`（+ cache 两项求和为 promptTokens）、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`。
  - OpenAI：`prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`，`cacheWriteTokens = 0`。
- 归一化 usage 随现有 run 事件持久化，无需新增事件类型。

## 3. 重试与退避（`src/core/retry.ts`）

- `fetchWithRetry(url, init, {maxRetries = 2, timeoutMs, baseDelayMs = 500, maxDelayMs = 8000, sleep, fetchImpl})` 返回 `{response, attempts}`。
- 可重试：HTTP 408/409/429/≥500，网络错误，单次尝试超时。不可重试：其他 4xx。
- 延迟：`retry-after`（秒或 HTTP 日期，上限 `maxDelayMs`）优先，否则 `min(maxDelayMs, baseDelayMs * 2^n)` × 抖动 [0.5, 1)。
- 每次尝试独立 `AbortController` 超时。`sleep` 可注入以便测试不真实等待。
- `OpenAICompatibleProvider` 与 `embeddings.ts` 的 fetch 均改用它。结果 `metadata.attempts` 记录尝试次数；重试耗尽才抛错，进而触发 LocalProvider fallback。

## 4. 结构化输出

- `ProviderInput` 新增 `responseSchema?: { name: string; schema: Record<string, unknown> }`。
- `planner.ts` 将 plan / review schema 提取为导出函数 `planSchema(participants)`、`REVIEW_SCHEMA`，在 planning 与 review 调用时传入 `responseSchema`；带 schema 的调用不传 tools。
- `src/core/structured-output.ts` 的 `toProviderSchema(schema)`：递归移除 `minLength`、`maxLength`、`maxItems`、`minItems`、`pattern`、`format` 等关键字（保留 `enum`，planner 的 owner 约束依赖它），确保每个 object 有 `additionalProperties: false`。
- OpenAI strict 要求 `required` 覆盖全部 properties。若原 schema 存在非必填属性，`toProviderSchema` 抛错而不是悄悄改为必填——避免改变语义；当前 plan / review schema 的属性均为必填，不触发。
- Anthropic：`output_config.format = {type: 'json_schema', schema}`。OpenAI：`response_format = {type: 'json_schema', json_schema: {name, schema, strict: true}}`。
- CLI / Local provider 忽略该字段。`parsePlan` / `parseReview` 及 `validateToolInput` 保持为最终校验，行为不退化。

## 5. 错误处理

- 所有 provider 错误仍经 `FallbackProvider` 转为本地回答并记录 `fallbackError`；重试次数与缓存 usage 进入 metadata。
- Anthropic 错误信息保留 SDK 的 status 与 message，不做字符串匹配分类。

## 6. 测试

- `test/anthropic-provider.test.ts`：注入 fetch 捕获请求体，断言 system `cache_control`、顶层 `cache_control`、`thinking`、`output_config`（effort/format）、tools 排序、tool_result 合并、`providerState` 回传、refusal 抛错、usage 归一化。
- `test/retry.test.ts`：429 + `retry-after`、5xx 退避后成功、400 不重试、超时重试、耗尽后抛错；注入 `sleep`。
- `test/structured-output.test.ts`：schema 裁剪与 `required`/`additionalProperties` 规范化；planner 把 `responseSchema` 传给 provider；OpenAI 请求体含 `response_format`。
- 现有测试与 `npm run check` 全部通过。
