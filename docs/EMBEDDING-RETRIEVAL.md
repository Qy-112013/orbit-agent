# Embedding 与向量检索

知识库和长期记忆支持 OpenAI-compatible embedding、余弦向量检索及关键词混合召回。HTTP、Agent 的 `search_knowledge` / `search_memory` 工具和 MCP 共用实现，没有新增 npm 依赖，也不需要运行独立的向量数据库。

## 启用

PowerShell 示例：

```powershell
$env:ORBIT_EMBEDDING_MODEL = "text-embedding-3-small"
$env:ORBIT_EMBEDDING_BASE_URL = "https://api.openai.com/v1"
$env:ORBIT_EMBEDDING_API_KEY = "你的 embedding 服务密钥"
npm start
```

也可以使用提供 `/v1/embeddings` 的网关或本地服务：将 `ORBIT_EMBEDDING_BASE_URL` 改成对应地址（例如 `http://127.0.0.1:11434/v1`），将模型名改为服务端已准备好的 embedding 模型。无鉴权的本地服务可不设置 `ORBIT_EMBEDDING_API_KEY`。

Embedding 配置与聊天模型、各 Agent 的 CLI 配置完全独立，**不会继承 `OPENAI_API_KEY` 或 `OPENAI_BASE_URL`**。例如，聊天可以继续使用 DeepSeek 或 Claude Code，embedding 使用另一个兼容服务。只有设置非空的 `ORBIT_EMBEDDING_MODEL` 才会启用向量请求；不设置时继续使用原有 BM25 / 记忆关键词检索。

这些是进程环境变量，修改后需要重启。项目不会自动读取 `.env`。密钥只在服务端配置，不通过浏览器提交或返回。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `ORBIT_EMBEDDING_MODEL` | 未设置，关闭向量检索 | 服务端提供的 embedding 模型名 |
| `ORBIT_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | API 根地址，也接受以 `/embeddings` 结尾的完整地址 |
| `ORBIT_EMBEDDING_API_KEY` | 无 | 独立的 Bearer 密钥；允许本地无鉴权服务 |
| `ORBIT_EMBEDDING_DIMENSIONS` | 不发送 | 可选输出维度；只对支持此参数的模型设置 |
| `ORBIT_EMBEDDING_BATCH_SIZE` | `32` | 每次 HTTP 请求最多多少个输入，范围 1–128 |
| `ORBIT_EMBEDDING_TIMEOUT_MS` | `15000` | 向量请求超时；单轮补建也使用此超时预算，范围 1–120000 毫秒 |
| `ORBIT_EMBEDDING_MIN_SCORE` | `0.3` | 语义候选的最低余弦相似度，范围 -1–1；可按实际模型效果调节 |

接口使用 `POST /embeddings`，发送 `model`、字符串数组 `input` 和 `encoding_format: "float"`，按响应 `data[].index` 恢复输入顺序。会拒绝缺失、重复或越界的索引，零向量、非数值以及不一致的维度。接口依据 [OpenAI 官方 embeddings 文档](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。

## 使用流程

1. 启用后，新导入文档和通过 `记住：...`、API 或工具保存的记忆会自动建索引。
2. 直接用自然语言提问。默认把语义召回与原有关键词排序合并，回答仍附带原文引用。
3. 旧数据会在检索时按当前可访问范围补建索引。知识库的“补建语义索引”按钮可提前处理当前会话及工作区的文档、长期记忆。
4. 大量旧数据分批处理，每轮每个集合最多新增 256 个向量。界面及 API 显示剩余 `pending`；再次补建会接着处理缺失部分。

未配置或 embedding 请求失败时，资料仍会保存，检索自动使用 BM25 / 关键词。HTTP 响应及执行事件会报告实际 `method` 和 `fallbackReason`，界面显示回退状态。恢复服务后再次查询或补建即可，不需要重新导入原文。

文档保留原有 1,200 字符分块、原文偏移和行号。Embedding 包含文档标题与片段正文；超过 2,000 字符的长期记忆按 160 字符重叠切分，按最相关片段召回同一条记忆，上下文使用命中的片段。这样长记忆末尾的事实也能参与检索。

语义检索使用归一化向量的余弦相似度。混合检索用 reciprocal-rank fusion（RRF）合并两份排名，不直接相加不同量纲的 BM25 和余弦分数。记忆的重要性和时间衰减仍参与关键词排名。响应中的 `score` 是排序分数，**不是正确率或概率**；命中可另带 `lexicalScore` 与 `vectorScore`。

## HTTP 与工具

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/retrieval?threadId=...` | 启用状态、模型、维度、缓存数量、当前范围的索引进度和最近错误 |
| POST | `/api/retrieval/reindex` | 按 `{ "threadId": "..." }` 补建当前范围缺失的向量；不传 threadId 只处理工作区资料 |
| GET | `/api/knowledge/search?q=...&threadId=...&mode=hybrid` | 检索文档，返回 `hits`、实际 `method`、`index` 和可选 `fallbackReason` |
| GET | `/api/memories?q=...&threadId=...&mode=hybrid` | 检索长期记忆，返回 `memories` 和同样的检索元数据 |

`mode` 可选：

- `hybrid`：默认，已配置时组合语义与关键词召回。
- `vector`：仅使用达到余弦阈值的语义候选；服务不可用时仍回退，并明确报告实际方法。
- `keyword`：只走原有 BM25 / 记忆关键词检索，不调用 embedding。

两个搜索工具也接受相同的可选 `mode` 参数。来源格式仍为 `knowledge:chunk_id` 和 `memory:mem_id`，已有引用展示和 Agent 工具结果格式保持兼容。TypeScript 的 `search()` 和 `buildContext()` 现在返回 Promise，直接调用时需要 `await`；需要实际方法和错误信息时调用 `searchWithMetadata()`。

检索和补建始终先限制来源范围：工作区资料加指定会话资料。未指定会话时不会检索其他会话的私有资料。向量值不会返回浏览器、搜索工具或模型上下文。

## 存储与边界

- Web 向量缓存默认是 `data/state.json.vectors.json`，MCP 为 `data/mcp-state.json.vectors.json`；自定义状态文件时使用 `<dataFile>.vectors.json`。
- 原文、会话和引用仍保存在原有 schema v2 状态文件中。向量缓存独立写入，普通聊天事件不会触发整个向量文件的重写。缓存文件已加入 `.gitignore`。
- 缓存保存来源 ID、文本哈希与向量，不保存密钥或额外的原文副本。写入串行执行，通过临时文件替换持久化。
- 服务地址、模型、请求维度变化会使旧配置的缓存失效，之后按需补建。轮换密钥不会使索引失效。重启后复用已生成的文档和记忆向量；查询向量仅在进程内最多缓存 64 项。
- 删除文档会移除其向量；记忆被存储容量上限淘汰后会清理缓存。网络请求完成后会重新检查来源是否还存在，避免并发删除后重新写回向量。
- 这是面向当前个人工作区容量的本地精确扫描，不是 ANN 索引或分布式向量数据库。仍遵守原有 100 份文档、500 万字符、1,000 条记忆等限制；不支持多个进程同时写同一份状态与缓存。

## 验证

```bash
npm test
npm run check
npm run demo:workflow
npm run check:ui
```

新增测试使用确定性的模拟向量，覆盖无共同词的召回、HTTP 请求批量与顺序、异常向量、超时与降级、会话隔离、长期记忆片段、缓存复用、模型切换、并发删除、HTTP / Agent / MCP 链路。它们验证实现行为；真实模型的检索质量需要使用你选择的 embedding 服务和实际资料评估。
