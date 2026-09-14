<div align="center">

# Orbit Agent

### 可观测的多 Agent 协作工作台

**让一次复杂请求变成一条可追踪、可恢复、可替换的执行链路。**

Orbit Agent 是一个本地优先的个人 Agent Runtime：它把持续会话、带原文引用的知识库、ReAct 工具循环、计划与重规划、多 Agent 协作及实时执行轨迹放进同一个桌面工作台。

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

v0.3 新增长会话摘要、会话管理、文档 RAG 和 `#plan` 执行流程。运行 `npm run demo:workflow` 可无密钥体验检索、复核反馈和重规划；使用方式与实现边界见 [会话、知识库与计划](docs/SESSION-RAG-PLANNING.md)。原有委派与两轮讨论见 [协作扩展](docs/COLLABORATION-EXTENSION.md)。

下面这些能力已经在当前版本实现，并由 Node 内置测试覆盖关键路径：

| 能力 | 它解决的问题 |
| --- | --- |
| **稳定 Agent 身份** | Atlas、Forge、Lens 各自拥有角色、system prompt、别名和责任归属。 |
| **持久协作线程** | 消息、active Agent 和更新时间写入本地 JSON，重启后可以继续工作。 |
| **多轮会话管理** | 搜索、重命名、归档与分支；近期消息与历史摘录共同构成有界上下文，切换会话保留当前页面内的草稿。 |
| **文档 RAG 知识库** | 导入 TXT/Markdown，按范围隔离；可选 embedding 向量与 BM25 混合检索，回答引用可展开核对原文和行号。 |
| **计划、复核与重规划** | `#plan` 生成带 owner、依赖和验收标准的步骤；失败或复核反馈触发最多 2 次重规划，保留各版结果。 |
| **确定性 mention 路由** | 用 `@atlas`、`@forge`、`@lens` 或 `@all` 明确指定目标，不把业务路由交给模型猜。 |
| **串行/并行编排** | 多目标默认并行独立判断，也可以用 `#serial` 让后续 Agent 接收前序结果摘要。 |
| **长期记忆与引用** | 用 `记住：...` 或 API 写入事实，支持语义与关键词混合召回；关键词排序保留重要性和时间衰减，引用为 `memory:<id>`。 |
| **Agent 委派与回传** | 支持工具调用的 API 模型可通过 `delegate_to_agent` 请求其他 Agent 协助；每轮最多 2 次、深度 1 层，保留父子 run 与消息引用。 |
| **两轮讨论与汇总** | `#discuss` 让 2–4 个 Agent 先独立判断，再阅读前轮观点复核，最后由第一个 Agent 汇总共识与分歧；兼容 API 和 CLI Provider。 |
| **ReAct 式工具循环** | 单个 Agent 最多 5 次模型调用、8 次工具请求；检索知识、读取 workspace 并根据真实工具结果继续回答，记录每一步事件。 |
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
npm run demo:collaboration  # 无密钥验证委派、回传与讨论
npm run demo:workflow       # 无密钥验证会话、RAG 与重规划
npm run check:ui            # 本机浏览器验证桌面操作流程
```

### 用几条消息体验协作

```text
帮我拆解这个重构任务
@forge 给出最小实现步骤
@all 独立分析这套方案的风险
#serial @atlas @forge @lens 从设计到审查逐步接力
#discuss @forge @lens 讨论方案，互相复核后汇总共识和分歧
#plan @atlas @forge @lens 根据知识库核对部署要求，并按复核意见修订
@atlas 请先让 Forge 提出实现建议，再把结果交给 Lens 复核，最后汇总
记住：生产部署必须先通过 review
任务：补充失败重试测试
```

`@mention` 和 `#serial` / `#parallel` 只影响路由与编排，用户原始消息仍会完整保存，方便复盘。没有显式 mention 时，请求交给当前线程的 active Agent。

`#discuss` 固定执行两轮讨论和一次汇总。自主委派需要支持 function calling 的 API 模型；请只 @ 主 Agent，在任务正文中用名字提及协作者。外部 CLI 通过串行接力或 `#discuss` 参与交互，其内部工具与权限由 CLI 自身管理。文本接口不支持工具调用时，可设置 `ORBIT_MODEL_TOOLS=0` 关闭 Orbit 模型工具。

`#plan` 也兼容能返回所需 JSON 的 API/CLI Provider。每版最多 5 个步骤，整个计划最多执行 8 个步骤；服务重启会将未完成计划标为中断。LocalProvider 只作演示，不能通过真实计划验收。普通消息仍使用当前 Agent，不会默认同时启动三个 Agent。

知识库位于右侧“知识库”卡片。导入文档后直接提问；默认使用 BM25，配置 embedding 后自动启用语义与关键词混合检索，向量保存在本地，不需要独立向量数据库。会话连续性、来源引用与实际检索方式均可在界面检查。

### 启用 embedding 向量检索

```powershell
$env:ORBIT_EMBEDDING_MODEL="text-embedding-3-small"
$env:ORBIT_EMBEDDING_BASE_URL="https://api.openai.com/v1"
$env:ORBIT_EMBEDDING_API_KEY="你的 embedding 服务密钥"
npm start
```

知识库和长期记忆共用此配置，与聊天模型及 CLI 独立。支持提供 `/v1/embeddings` 的兼容网关或本地服务；新资料自动建索引，旧资料可点击“补建语义索引”。服务不可用时回退到关键词检索并显示状态。配置项、存储方式与 API 见 [Embedding 与向量检索](docs/EMBEDDING-RETRIEVAL.md)。

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

Windows 混合启动可先运行 `.\scripts\start-hybrid.ps1 -CheckOnly`。脚本会检查 Node 和 Claude Code 的实际路径；正式启动时在本地终端输入密钥。CLI 每轮会接收 Orbit 重建的历史上下文，当前没有使用外部 CLI 的原生 session resume。

## 产品界面

Web 工作台把一次协作拆成四个可观察区域：

1. **Threads**：搜索、重命名、归档、恢复与分支，消息、摘要和 active Agent 跨重启保留。
2. **Agent roster**：显示身份、角色和当前可用的 Agent。
3. **Conversation & Plans**：发送消息、检查引用原文、查看每版计划的负责人、步骤结果和复核意见。
4. **Inspector**：导入与检索知识文档，查看 Execution trace、Relevant memory 和 Open tasks。

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
   ├─ AgentLoop       bounded model/tool turns + delegation/return
   ├─ PlanExecutor    validated steps → execute → review → bounded replan
   ├─ Router          @mention → serial / parallel / discuss / plan
   ├─ MemoryService   recent conversation + durable excerpts + memory
   ├─ KnowledgeService text chunks + hybrid retrieval + source citations
   ├─ VectorIndex     optional embeddings + persistent local cosine index
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
| PATCH | `/api/threads/:id` | 重命名、归档或恢复会话 |
| POST | `/api/threads/:id/fork` | 从指定消息或当前历史创建分支 |
| POST | `/api/threads/:id/messages` | 提交一轮编排 |
| GET | `/api/threads/:id/plans` | 查询计划、各版步骤与复核结果 |
| GET | `/api/threads/:id/events` | 读取事件；加 `?stream=1` 获取 SSE |
| GET/POST | `/api/memories` | 检索或写入长期记忆 |
| GET/POST | `/api/knowledge/documents` | 查询或导入知识文档 |
| GET/DELETE | `/api/knowledge/documents/:id` | 读取原文或移除文档 |
| GET | `/api/knowledge/search` | 按 q 与 threadId 检索原文片段 |
| GET | `/api/retrieval` | 查看 embedding 配置状态与当前范围索引进度 |
| POST | `/api/retrieval/reindex` | 分批补建文档与长期记忆缺失的向量 |
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

它通过 stdin/stdout 使用 JSON-RPC；可用工具包含记忆、知识检索、任务和受限的 workspace 读取，不提供任意 shell 执行。stdio 使用独立的 `data/mcp-state.json`，共享工具实现，不自动同步 Web 状态文件。

## 设计边界

Orbit 将当前版本控制在一条可验证的协作闭环内：

- 内置工具不执行任意 shell 命令，不允许工具路径逃逸配置的 workspace；
- 不接收浏览器传入的模型密钥，Provider 是唯一的外部模型边界；
- 不把无限历史塞给模型，消息、事件和上下文都有明确上限；
- 会话与原文由 `JsonStore` 串行持久化；可重建的向量缓存由独立索引写入，均使用临时文件替换；
- CLI 适配器是显式 opt-in 的外部进程边界，交互式 PTY 和自动权限升级暂不支持；
- 当前不包含多用户认证、组织权限、远程 MCP transport、Redis/向量数据库和自动调度。

后续可以将 `JsonStore` 替换为 SQLite/Redis，将本地向量索引替换为专用向量存储，或增加独立的 rerank 模型。

## 项目文档

- [`docs/AGENT-V0.md`](docs/AGENT-V0.md)：v0 能力地图、演示路径和明确限制
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：分层、领域模型、事件契约、并发与安全边界
- [`docs/CORE-FEATURES.md`](docs/CORE-FEATURES.md)：每项核心能力的触发方式与边界行为
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)：模块走读、扩展点和已知问题
- [`docs/PRODUCT-SCOPE.md`](docs/PRODUCT-SCOPE.md)：为什么保留这些能力、暂不做哪些能力
- [`docs/TYPESCRIPT-MIGRATION.md`](docs/TYPESCRIPT-MIGRATION.md)：从原始 demo kernel 到 TypeScript runtime 的迁移说明
- [`docs/SESSION-RAG-PLANNING.md`](docs/SESSION-RAG-PLANNING.md)：v0.3 会话管理、RAG、ReAct、计划执行、API 与验证方法
- [`docs/EMBEDDING-RETRIEVAL.md`](docs/EMBEDDING-RETRIEVAL.md)：embedding 配置、混合检索、缓存与索引补建
- [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)：架构灵感与开源来源记录
- [`docs/COLLABORATION-EXTENSION.md`](docs/COLLABORATION-EXTENSION.md)：多 Agent 交互、上游对照、执行边界和演示方法

## License

[MIT](LICENSE)。架构灵感与来源记录见 [`docs/ORIGIN-NOTES.md`](docs/ORIGIN-NOTES.md)。

---

<div align="center">

**把 Agent 协作变成可以观察、可以恢复、可以持续演进的基础设施。**

</div>
