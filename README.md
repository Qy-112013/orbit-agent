# Orbit Agent

## TypeScript refactor

This directory is the TypeScript refactor of the Orbit Agent demo kernel.
The runtime keeps the original dependency-free HTTP/SSE, JSON persistence,
deterministic routing, memory, task and provider behavior while moving the
domain boundary to typed `.ts` modules.

### Requirements

- Node.js 25 or newer (uses Node's built-in TypeScript type stripping)

### Commands

```sh
npm start
npm test
npm run mcp
```

The source entry point is `src/server.ts`. Tests import the `.ts` modules
directly and run without a transpiler dependency. `tsconfig.json` is included
with `strict` enabled so a regular TypeScript compiler can be added later for
declaration files and a `dist/` build.

The pre-refactor snapshot is preserved in the sibling `orbit-old` directory.

The refactor keeps the domain boundary deliberately small: `src/core/contracts.ts`
defines Provider and Storage ports, while the existing local implementations
remain replaceable.

The complete v0 capability boundary is documented in
[`docs/AGENT-V0.md`](docs/AGENT-V0.md).

## Skills and MCP

Skills are local Markdown files under `skills/` with a small YAML-style
frontmatter block. They are discoverable through `GET /api/skills` and can be
read through `GET /api/skills/:id`.

The MCP stdio server exposes the same allow-listed tools used by the HTTP
runtime:

```sh
npm run mcp
```

It implements the MCP handshake plus `tools/list` and `tools/call`, so an MCP
client can use Orbit's memory and task tools without gaining arbitrary shell
access.

> 可观测的多 Agent 协作工作台

Orbit Agent 是一个可以 clone 后直接运行的个人 Agent 基础设施项目。它把一次复杂的 AI 协作请求收敛成一条清晰、可回放的链路：稳定身份 → 确定性路由 → 有限记忆 → 可替换模型 → 持久化结果 → 实时执行轨迹。

这个项目不是“再做一个聊天窗口”，而是把 Agent 的协作基础设施做成一个小而完整的产品：你可以指定某个 Agent、让多个 Agent 并行给出独立判断、把确认过的事实写入记忆、把行动转成任务，并在右侧检查器里看到每一步发生了什么。

## 运行

要求 Node.js 20+，不需要 pnpm、Redis 或数据库服务：

```bash
cd orbit-agent
npm start
```

浏览器打开 <http://127.0.0.1:3030>。

开发模式和测试：

```bash
npm run dev
npm test
npm run check
```

首次启动会在 `data/state.json` 创建本地状态文件。它只保存线程、消息、记忆、任务和执行事件，已被 `.gitignore` 排除，不会把个人对话提交到仓库。

## 快速体验

- 直接发送消息：交给当前线程的 active Agent。
- `@atlas`、`@forge`、`@lens`：显式指定一个 Agent。
- `@all`：三个 Agent 并行独立回答，完成后写入协作摘要。
- `#serial` / `#parallel`：覆盖本轮执行策略。
- `记住：部署必须先通过 review`：写入长期记忆，后续相关请求会召回它。
- `任务：补充失败重试测试`：创建带 owner 的可追踪任务。

默认使用无密钥的 `LocalProvider`，因此离线也能演示完整链路。接入任意 OpenAI-compatible 网关只需配置：

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
npm start
```

Each Agent can optionally use its own OpenAI-compatible endpoint. The per-agent
variables override the default registry entry:

```powershell
$env:ORBIT_ATLAS_API_KEY="..."
$env:ORBIT_ATLAS_BASE_URL="https://api.deepseek.com/v1"
$env:ORBIT_ATLAS_MODEL="deepseek-reasoner"
$env:ORBIT_LENS_API_KEY="..."
$env:ORBIT_LENS_BASE_URL="https://api.openai.com/v1"
$env:ORBIT_LENS_MODEL="gpt-4o-mini"
npm start
```

The runtime resolves the provider in this order: an Agent-specific entry,
an explicit registered provider name, then the default provider. Inspect the
active mapping at `GET /api/providers`.

### CLI adapters: Codex, Claude Code and Pi

Orbit can route individual Agents through locally installed coding-agent CLIs.
The adapter launches one non-interactive process per turn, keeps its working
directory inside the Orbit workspace, captures stdout/stderr, enforces a
timeout, and normalizes text/JSON/JSONL output into the same Provider contract.
Interactive PTY sessions and automatic permission escalation are intentionally
outside this first version.

PowerShell example:

```powershell
$env:ORBIT_ATLAS_PROVIDER="codex"
$env:ORBIT_FORGE_PROVIDER="claude-code"
$env:ORBIT_LENS_PROVIDER="pi"
$env:ORBIT_WORKSPACE_ROOT=(Get-Location).Path
npm start
```

Optional command and timeout overrides are available per adapter:

```powershell
$env:ORBIT_CODEX_COMMAND="codex"
$env:ORBIT_CLAUDE_COMMAND="claude"
$env:ORBIT_PI_COMMAND="pi"
$env:ORBIT_ATLAS_CLI_TIMEOUT_MS="180000"
```

The corresponding environment variables are `ORBIT_<AGENT>_PROVIDER`,
`ORBIT_<AGENT>_CLI_COMMAND`, `ORBIT_<AGENT>_CLI_CWD`, and
`ORBIT_<AGENT>_CLI_TIMEOUT_MS`. If a CLI is missing or not authenticated,
the failed turn is recorded and LocalProvider produces the fallback response.

真实 Provider 超时、返回错误或空结果时会自动降级到本地 Provider，当前线程仍然可恢复。

## 产品界面

工作台由四个区域组成：

1. **Threads**：持久化的协作现场，消息和 active Agent 跨重启保留。
2. **Agent roster**：Atlas（架构）、Forge（执行）、Lens（审查）三种稳定身份。
3. **Conversation**：支持 mention、串行/并行编排和引用记忆。
4. **Inspector**：Execution trace、Relevant memory、Open tasks 三个投影，帮助定位问题究竟发生在路由、上下文、Provider 还是存储。

## 架构

```text
Browser (vanilla UI)
        │ HTTP + SSE
        ▼
   HTTP server ─────── JSON API / event stream / static assets
        │
        ▼
   Orchestrator
   ├─ Router             @mention → serial / parallel plan
   ├─ MemoryService      lexical recall + bounded context
   ├─ ToolRegistry       allow-list tools only
   ├─ Provider           OpenAI-compatible ↔ local fallback
   └─ JsonStore          serialized atomic persistence
```

每轮执行都会产生 `message.accepted → route.decided → context.retrieved → agent.started/completed → execution.completed` 事件。SSE 断线重连后可以按 sequence 补放，前端只是投影，不拥有状态写权限。

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | 运行态探针 |
| GET | `/api/bootstrap` | 首屏所需的 Agent、线程、任务、工具和 Provider 状态 |
| POST | `/api/threads` | 新建线程 |
| GET | `/api/threads/:id` | 读取线程与消息 |
| POST | `/api/threads/:id/messages` | 提交一轮编排 |
| GET | `/api/threads/:id/events` | 读取事件；加 `stream=1` 得到 SSE |
| GET/POST | `/api/memories` | 检索/写入长期记忆 |
| GET/POST | `/api/tasks` | 查询/创建任务 |

## 设计边界

Orbit Agent 不执行任意 shell 命令，不接收浏览器传来的密钥，不把无限历史塞给模型，并对请求体、消息、事件和上下文设置上限。工具采用显式 allow-list；Provider 是唯一的外部模型边界；`JsonStore` 是唯一持久化写入者。这些约束让项目适合公开作品集，也便于逐步替换为 SQLite/Redis/向量检索。

## 项目文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：分层、领域模型、事件契约、并发与安全边界
- [`docs/CORE-FEATURES.md`](docs/CORE-FEATURES.md)：每项核心能力的用法、边界行为和验证方式
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)：模块走读、扩展点、已知问题清单
- [`docs/PRODUCT-SCOPE.md`](docs/PRODUCT-SCOPE.md)：为什么保留这些能力、暂不做哪些能力
- [`docs/RESUME-BULLET.md`](docs/RESUME-BULLET.md)：简历表述和面试展开点
- [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)：架构灵感与开源来源记录

## License

MIT。架构灵感与来源记录见 [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)。
