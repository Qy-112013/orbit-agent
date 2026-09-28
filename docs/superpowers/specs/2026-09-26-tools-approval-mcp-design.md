# 子项目 3：MCP client、写入工具、人工审批与沙箱 — 设计

> 历史设计稿；实现状态核对：2026-09-28。Host/Origin 加固、逐次审批、写入/编辑/shell 和 MCP stdio 客户端已实现。下文“现状”是设计前状态，当前响应不含 CORS 头。文件策略允许 .env.example 模板；CLI/MCP/shell 不具备 OS 沙箱。审批预览有字符上限，不保证完整展示超长命令。 当前使用与限制以 [核心能力](../../CORE-FEATURES.md)、[架构](../../ARCHITECTURE.md) 和 [实现说明](../../IMPLEMENTATION.md) 为准。以下保留当时设计背景。


日期：2026-09-26
范围：P0 MCP client；P0 写入类工具（写文件、编辑文件、执行 shell）+ 逐次人工审批 + 沙箱约束；前置的 HTTP 安全加固。
用户约束：**agent 不得删除文件**。
不在范围：MCP 的 HTTP/SSE 传输与 OAuth；OS 级文件系统隔离（容器、WSL、bubblewrap）；撤销/回滚 UI。

## 0. HTTP 安全加固（前置，必须先做）

现状：所有响应带 `access-control-allow-origin: *`，任意网页都能读写 `127.0.0.1:3030` 的 API。加入 shell 与审批后即为远程代码执行。

- 移除全部 CORS 响应头。UI 与 API 同源，不需要 CORS。OPTIONS 返回 204 但不带 CORS 头。
- Host 白名单（防 DNS rebinding）：`/api/` 请求的 Host 必须是 `127.0.0.1`、`localhost` 或 `[::1]`（任意端口），或者在 `ORBIT_ALLOWED_HOSTS`（逗号分隔）里，否则 403 `HOST_NOT_ALLOWED`。
- Origin 校验：非 GET/HEAD 的 `/api/` 请求若带 `Origin` 头，其 host 必须等于请求的 Host，否则 403 `ORIGIN_NOT_ALLOWED`。不带 Origin 的请求（curl、测试）放行。

## 1. 审批（`src/core/approvals.ts`）

- `ApprovalBroker.request({ threadId, runId, agentId, tool, summary, preview }) → Promise<{ approved: boolean; reason?: string; by: 'user' | 'timeout' | 'shutdown' }>`。
- 待审批项只存在内存 Map 中；超时默认 10 分钟（`ORBIT_APPROVAL_TIMEOUT_MS`），超时按拒绝处理。服务关闭时全部拒绝。
- 事件（持久化，作为审计轨迹）：`approval.requested`（approvalId、runId、agentId、tool、summary、preview ≤ 4000 字符、expiresAt）、`approval.resolved`（approvalId、approved、reason、by）。
- HTTP：`GET /api/threads/:id/approvals` 列出该线程待审批项；`POST /api/approvals/:id`，body `{ decision: 'approve' | 'deny', reason? }`，已结束的返回 409。
- 工具元数据新增 `approval?: 'always' | 'never'`。定义了该字段的非只读工具才会暴露给模型；`'always'` 的工具每次调用前都必须审批，`'never'` 用于 MCP `autoApprove` 列出的工具。拒绝时工具结果为 `{ error: { code: 'APPROVAL_DENIED', message } }`，模型可继续。

## 2. AgentLoop 工具策略

- `ORBIT_TOOL_POLICY`：`approval`（默认）或 `read-only`。
- `approval`：暴露 `readOnly: true` 的工具 + 定义了 `approval` 字段的工具（写入工具、MCP 工具）。`remember` / `create_task` 等其他非只读工具仍不暴露，行为不变。
- `read-only`：与现状一致。
- 调用带 `approval` 的工具时先 `await broker.request(...)`，通过后才执行。`describe()` 返回 `toolPolicy` 与 `approvalTools`。
- MCP 服务端（`src/mcp-server.ts`）不注册写入工具，外部 MCP 客户端拿不到它们。

## 3. 写入工具（`src/core/workspace-tools.ts`）

通用：路径限定在 workspace 根目录内（沿用 realpath 检查，新文件检查其最近的已存在父目录）；拒绝 `.env`、`.env.*`（读写都拒绝，`workspace_read` 同步加上）；拒绝写入 `.git/` 与 Orbit 数据目录。

- `workspace_write` `{ path, content }`：创建或覆盖文本文件，content ≤ 200 KB，自动创建父目录。覆盖前把原内容备份到 `<数据目录>/backups/<时间戳>/<相对路径>`。预览：新建/覆盖、字节数、行级 diff（截断）。
- `workspace_edit` `{ path, oldText, newText }`：精确替换，oldText 必须恰好出现一次；同样先备份。预览：替换前后片段。
- `shell_exec` `{ command, cwd?, timeoutMs? }`：
  - cwd 限定在 workspace 内；shell 取平台默认（Windows 为 cmd.exe），可用 `ORBIT_SHELL` 指定其他 shell 可执行文件。
  - 超时默认 60 秒，上限 10 分钟，超时杀掉整个进程树（Windows 用 `taskkill /T /F`，POSIX 用进程组）。
  - stdout / stderr 各保留末尾 32 KB；返回 exitCode、耗时、是否超时。
  - 环境变量去敏：去掉名称含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`，或以 `ANTHROPIC_`、`OPENAI_` 开头的变量。
  - **删除拦截**：按 `;`、`&&`、`||`、`|`、换行切分命令，任何片段的命令词命中以下列表即拒绝，不进入审批：`rm`、`rmdir`、`del`、`erase`、`rd`、`unlink`、`shred`、`rimraf`、`Remove-Item`、`ri`、`git clean`、`git rm`、`git reset --hard`、`git checkout -- ...`、`git restore`、`find ... -delete`、`truncate`。这是纵深防御，不是保证：最终防线是逐条人工审批，审批卡片会完整显示命令。
- 不提供删除、移动、重命名工具。

## 4. MCP client（`src/core/mcp-client.ts`）

- 配置：`ORBIT_MCP_CONFIG` 指定的 JSON 文件，默认 `<项目>/mcp.json`（不存在则不启用），格式兼容 Claude Desktop：`{ "mcpServers": { "<name>": { "command", "args"?, "env"?, "cwd"?, "autoApprove"?: string[], "disabled"?: boolean } } }`。
- 传输：仅 stdio，按行分隔的 JSON-RPC 2.0。复用 `cli-provider.ts` 的 `resolveCommand`，不经过 shell 启动（兼容 Windows npm `.cmd` 包装脚本）。
- 握手：`initialize`（protocolVersion `2025-06-18`，接受服务端返回的版本）→ `notifications/initialized` → `tools/list`（支持 `nextCursor` 分页）。收到 `notifications/tools/list_changed` 时重新拉取。单次请求超时 60 秒；服务端退出后标记为不可用并记录 stderr 末尾。
- 注册：工具名 `mcp__<server>__<tool>`，清洗为 `[A-Za-z0-9_-]`，不超过 64 字符；描述加前缀 `[MCP:<server>]`；inputSchema 原样传给模型，本地只校验参数是对象。
- 审批：工具默认 `approval: 'always'`；server 配置的 `autoApprove` 中列出的工具为 `approval: 'never'`。
- 结果：`isError: true` 视为工具失败；text 内容拼接；image / audio 替换为占位说明；有 `structuredContent` 时附上。
- 生命周期：`createApp` 启动后在后台连接，不阻塞服务启动；连接好之后工具才出现。关闭服务时结束子进程。`GET /api/mcp` 返回各 server 状态、工具数和最近错误。

## 5. UI

- 审批卡片：由 `approval.requested` / `approval.resolved` 事件与 `GET /api/threads/:id/approvals` 维护，显示在时间线末尾，展示 agent、工具、摘要和预览（转义后放进 `<pre>`），带批准 / 拒绝按钮。
- 等待审批时，运行状态显示「等待审批…」。

## 6. 测试

- 加固：错误 Host 返回 403；跨源 Origin 的 POST 返回 403；响应不含 `access-control-allow-origin`。
- 审批：批准、拒绝、超时；事件；HTTP 决策接口与 409。
- AgentLoop：写入工具等待审批，批准后执行；拒绝后模型收到 `APPROVAL_DENIED` 并继续；`read-only` 策略不暴露写入工具。
- 写入工具：新建；覆盖时生成备份；edit 在 0 次或多次匹配时失败；路径越界、`.env`、`.git/` 被拒绝。
- shell：正常执行与退出码；超时杀进程；输出截断；删除类命令被拒绝；敏感环境变量不可见。
- MCP：用测试 fixture MCP server 验证握手、分页、调用、`isError`、`list_changed`、服务端崩溃。
- UI 检查：审批卡片出现，点批准后文件被写入。
- 真实冒烟：DeepSeek 驱动 `workspace_write`（脚本自动批准）写入临时目录。
