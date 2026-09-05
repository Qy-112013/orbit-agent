<div align="center">

# Orbit Agent

### 可观测的多 Agent 协作工作台

**让一次复杂请求变成一条可追踪、可恢复、可替换的执行链路。**

Orbit Agent 是一个本地优先的个人 Agent Runtime：它把稳定的 Agent 身份、确定性路由、有限记忆、任务追踪、可替换 Provider 和实时执行轨迹放进同一个轻量工作台。

[![Node.js](https://img.shields.io/badge/Node.js-25%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-runtime-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-Node%20built--in%20runner-2ea44f)](test/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[快速开始](#快速开始) · [当前能力](#当前能力) · [架构](#架构) · [项目文档](#项目文档)

</div>

---

## 为什么需要 Orbit

只使用一个 Agent 时，聊天窗口似乎已经足够。加入第二个模型、第三个工具和新的项目后，真正困难的部分就变成了协作：

- 谁负责回答，谁负责执行，谁负责找错？
- 多个 Agent 的回答是独立判断，还是按顺序接力？
- 上次确认过的约束，下一次能不能被可靠召回？
- Provider 超时或失败时，线程和已经发生的事情会不会消失？
- 出现问题时，究竟是路由、上下文、模型还是存储出了问题？

Orbit 不试图做一个无边界的“超级 Agent”。它提供一条小而完整的协作闭环：

```text
稳定身份 → 确定性路由 → 有限上下文 → Provider 执行
    → 持久化消息/任务/记忆 → SSE 实时轨迹与断线补放
```

## 当前能力

下面这些能力已经在当前版本实现，并由 Node 内置测试覆盖关键路径：

| 能力 | 它解决的问题 |
| --- | --- |
| **稳定 Agent 身份** | Atlas、Forge、Lens 各自拥有角色、system prompt、别名和责任归属。 |
| **持久协作线程** | 消息、active Agent 和更新时间写入本地 JSON，重启后可以继续工作。 |
| **确定性 mention 路由** | 用 `@atlas`、`@forge`、`@lens` 或 `@all` 明确指定目标，不把业务路由交给模型猜。 |
| **串行/并行编排** | 多目标默认并行独立判断，也可以用 `#serial` 让后续 Agent 接收前序结果摘要。 |
| **长期记忆与引用** | 用 `记住：...` 或 API 写入事实，按关键词、重要性和时间衰减召回，并保留 `memory:<id>` 引用。 |
| **任务抽取与追踪** | 用 `任务：...` 创建带 owner 的待办任务，也可以通过 API 查询和更新状态。 |
| **Skills 与 allow-list 工具** | 从 `skills/` 加载 Markdown Skill，并通过受限工具访问记忆、任务和 workspace 文本。 |
| **可回放执行轨迹** | 路由、上下文检索、Agent 开始/完成/失败等事件持久化，HTTP API 和 SSE 都可读取。 |
| **Provider 可替换与降级** | 默认无需密钥即可离线演示；OpenAI-compatible 或本地 CLI 失败时自动回退到 LocalProvider。 |
| **MCP stdio 接口** | MCP 客户端可使用同一组 allow-list 工具和 Skill resources，不获得任意 shell 权限。 |

### 三个默认 Agent

| Agent | 角色 | 擅长什么 |
| --- | --- | --- |
| `atlas` | 架构师 | 拆解目标、设计边界、给出可执行方案 |
| `forge` | 执行工程师 | 把方案落成代码、命令或操作步骤 |
| `lens` | 独立审查员 | 从正确性、安全性和可维护性角度挑错 |

这三个身份对应真实工作流中的三个视角：**要做什么 → 怎么做 → 哪里会错**。也可以通过 `POST /api/agents` 注册新的身份。

## 快速开始

### 环境要求

- Node.js 25 或更高版本（直接运行 `.ts` 文件使用 Node 的 type stripping）
- Git（仅在从仓库克隆时需要）
- 不需要 pnpm、Redis、数据库或 API key

### 启动 Web 工作台

```bash
git clone https://github.com/Qy-112013/orbit-agent.git
cd orbit-agent
npm start
```

打开 <http://127.0.0.1:3030>。首次启动会创建本地线程和 `data/state.json`；运行状态已被 `.gitignore` 排除，不会把个人对话提交到仓库。

常用命令：

```bash
npm run dev     # watch 模式
npm test        # 运行测试
npm run check   # 检查源码语法
npm run mcp     # 启动 MCP stdio server
```

### 用几条消息体验协作

```text
帮我拆解这个重构任务
@forge 给出最小实现步骤
@all 独立分析这套方案的风险
#serial @atlas @forge @lens 从设计到审查逐步接力
记住：生产部署必须先通过 review
任务：补充失败重试测试
```

`@mention` 和 `#serial` / `#parallel` 只影响路由与编排，用户原始消息仍会完整保存，方便复盘。没有显式 mention 时，请求交给当前线程的 active Agent。

## Provider 与 CLI 适配器

### OpenAI-compatible 网关

默认使用确定性的 `LocalProvider`，离线也能完整演示路由、记忆、任务和事件链路。配置环境变量后，所有未单独指定 Provider 的 Agent 会使用 OpenAI-compatible 接口：

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
npm start
```

每个 Agent 也可以单独配置：

```powershell
$env:ORBIT_ATLAS_API_KEY="..."
$env:ORBIT_ATLAS_BASE_URL="https://api.deepseek.com/v1"
$env:ORBIT_ATLAS_MODEL="deepseek-reasoner"
$env:ORBIT_LENS_API_KEY="..."
$env:ORBIT_LENS_BASE_URL="https://api.openai.com/v1"
$env:ORBIT_LENS_MODEL="gpt-4o-mini"
npm start
```

解析顺序是：Agent 专属配置 → 显式注册的 Provider → 默认 Provider。当前映射可通过 `GET /api/providers` 查看。

### Codex、Claude Code 和 Pi

可以把单个 Agent 路由到本机已安装的 coding-agent CLI：

```powershell
$env:ORBIT_ATLAS_PROVIDER="codex"
$env:ORBIT_FORGE_PROVIDER="claude-code"
$env:ORBIT_LENS_PROVIDER="pi"
$env:ORBIT_WORKSPACE_ROOT=(Get-Location).Path
npm start
```

适配器会为每轮启动一个受控的非交互进程，限制工作目录、捕获 stdout/stderr、执行超时控制，并把文本、JSON 或 JSONL 输出统一为 Provider 结果。可按 Agent 设置 `ORBIT_<AGENT>_CLI_COMMAND`、`ORBIT_<AGENT>_CLI_CWD` 和 `ORBIT_<AGENT>_CLI_TIMEOUT_MS`。交互式 PTY 和自动权限升级不属于当前版本。

无论真实 Provider 发生超时、错误还是空结果，失败都会写入执行轨迹，线程保留，并自动回退到 `LocalProvider`。

## 产品界面

Web 工作台把一次协作拆成四个可观察区域：

1. **Threads**：持久化的协作现场，消息和 active Agent 跨重启保留。
2. **Agent roster**：显示身份、角色和当前可用的 Agent。
3. **Conversation**：发送消息、使用 mention、选择串行或并行编排。
4. **Inspector**：查看 Execution trace、Relevant memory 和 Open tasks，定位问题发生在哪一环。

前端是 vanilla HTML/CSS/JavaScript，只负责投影服务端状态；所有写操作都经过 HTTP API，状态权威始终在运行时和 JSON store。

## 架构

```text
Browser (vanilla UI)
        │ HTTP JSON + SSE
        ▼
HTTP server ─────── static assets / API / event stream
        │
        ▼
Orchestrator
   ├─ Router          @mention → serial / parallel plan
   ├─ MemoryService   lexical recall + bounded context
   ├─ ToolRegistry    explicit allow-list tools
   ├─ SkillRegistry   Markdown skills + metadata matching
   ├─ Provider        OpenAI-compatible / CLI → local fallback
   └─ JsonStore       serialized atomic persistence
```

一次 `POST /api/threads/:id/messages` 会按顺序产生并持久化：

```text
message.accepted
  → route.decided
  → context.retrieved
  → agent.started / agent.completed|agent.failed
  → execution.completed
```

SSE 只是事件投影。客户端断线重连时，可以用 `after=` 或 `Last-Event-ID` 补放 durable events，避免把前端当成第二个状态源。

## API 速查

| Method | Endpoint | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 运行态探针 |
| GET | `/api/bootstrap` | 首屏所需的 Agent、线程、任务、工具、Skills 和 Provider 状态 |
| GET/POST | `/api/agents` | 查看或注册 Agent |
| GET/POST | `/api/threads` | 查看或新建线程 |
| GET | `/api/threads/:id` | 读取线程和消息 |
| POST | `/api/threads/:id/messages` | 提交一轮编排 |
| GET | `/api/threads/:id/events` | 读取事件；加 `?stream=1` 获取 SSE |
| GET/POST | `/api/memories` | 检索或写入长期记忆 |
| GET/POST/PATCH | `/api/tasks` | 查询、创建或更新任务 |
| GET | `/api/tools` | 查看 allow-list 工具 |
| GET | `/api/providers` | 查看 Provider 映射 |
| GET | `/api/skills` | 查看可用 Skill；`/api/skills/:id` 读取内容 |

## MCP

MCP server 与 Web runtime 共享工具定义，支持：

- `initialize`
- `tools/list` / `tools/call`
- `resources/list` / `resources/read`

启动方式：

```bash
npm run mcp
```

它通过 stdin/stdout 使用 JSON-RPC；可用工具只包含记忆、任务和受限的 workspace 读取，不提供任意 shell 执行。

## 设计边界

Orbit 有意把作品集版本控制在一条可验证的协作闭环内：

- 不执行任意 shell 命令，不允许工具路径逃逸配置的 workspace；
- 不接收浏览器传入的模型密钥，Provider 是唯一的外部模型边界；
- 不把无限历史塞给模型，消息、事件和上下文都有明确上限；
- `JsonStore` 是唯一持久化写入者，写入串行化并使用原子替换；
- CLI 适配器是显式 opt-in 的外部进程边界，交互式 PTY 和自动权限升级暂不支持；
- 当前不包含多用户认证、组织权限、远程 MCP transport、Redis/向量数据库和自动调度。

这些限制不是缺陷清单，而是为了让每个边界都能被测试、解释和替换。未来可以在不改动 Router、Orchestrator 或事件契约的前提下，将 `JsonStore` 替换为 SQLite/Redis，将 lexical recall 升级为 embedding + rerank。

## 项目文档

- [`docs/AGENT-V0.md`](docs/AGENT-V0.md)：v0 能力地图、演示路径和明确限制
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：分层、领域模型、事件契约、并发与安全边界
- [`docs/CORE-FEATURES.md`](docs/CORE-FEATURES.md)：每项核心能力的触发方式与边界行为
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)：模块走读、扩展点和已知问题
- [`docs/PRODUCT-SCOPE.md`](docs/PRODUCT-SCOPE.md)：为什么保留这些能力、暂不做哪些能力
- [`docs/TYPESCRIPT-MIGRATION.md`](docs/TYPESCRIPT-MIGRATION.md)：从原始 demo kernel 到 TypeScript runtime 的迁移说明
- [`docs/RESUME-BULLET.md`](docs/RESUME-BULLET.md)：简历表述与面试展开点
- [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)：架构灵感与开源来源记录

## License

[MIT](LICENSE)。架构灵感与来源记录见 [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)。

---

<div align="center">

**把 Agent 协作变成可以观察、可以恢复、可以持续演进的基础设施。**

</div>
