# 2026 技术栈建议：代码仓 / Markdown 需求仓 → Agentic LLM → Google OKF Wiki

访问与核验日期：2026-07-10

## 结论

默认选择仍然是 **Python 3.14 + code-backed Skill + SQLite**，第一版不引入 Agent framework。

```text
Codex / Claude Skill
        ↓
Python 3.14 deterministic core
  snapshot / inventory / obligations / evidence / coverage / publish
        ↓
LLM 使用 read / rg / git / AST / MCP 等只读工具动态探索
        ↓
SQLite ledger + staged OKF bundle + hard gates
```

推荐的最小生产栈：

| 层 | 选择 |
|---|---|
| 语言 | Python 3.14.6 |
| Agent 入口 | `SKILL.md`，复用 Codex/Claude 已有 agent loop |
| 数据模型 | Pydantic v2，版本由 `uv.lock` 固定 |
| 状态与证据 | stdlib `sqlite3`，单文件 ledger |
| Markdown | `markdown-it-py 4.2.0`；确有扩展语法时再加 `mdit-py-plugins 0.6.1` |
| YAML | `PyYAML 6.0.3`，只用 `safe_load` / `safe_dump` |
| 仓库工具 | `git` CLI、`rg`、stdlib `ast` / `tomllib` / `pathlib` / `hashlib` |
| Web ingest | `httpx 0.28.1` + `markdownify 1.2.3`，外加自有 SSRF、redirect、大小与截断 guards |
| 包与环境 | `uv 0.11.28` + `pyproject.toml` + 提交 `uv.lock` |
| 测试与 lint | `pytest 9.1.1` + `Ruff 0.15.21` |
| 类型检查 | `ty 0.0.58` 只作辅助信号，暂不作为唯一 CI gate |
| 可观测性 | 先记录结构化 run/event 表；独立服务阶段再接 OpenTelemetry |
| 独立 Agent runner | 需要脱离 Skill 无人值守运行时，默认选 PydanticAI 2.8.0 |

明确不在第一版加入：FastAPI 服务、LangGraph、Temporal、PostgreSQL、向量数据库、统一多语言 Tree-sitter 平台、多 Agent 调度器。

## 事实：截至 2026-07-10 的运行时状态

### Python 3.14 与 Node 24

- Python 当前正式版为 **3.14.6**，发布日期为 2026-06-10；3.14.0 已于 2025-10-07 正式发布。Python 3.14 处在常规 bugfix 周期，预计到 2027-10 仍有二进制 bugfix 版本，安全修复持续到约 2030-10。[Python release API](https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false)（访问：2026-07-10）；[PEP 745](https://peps.python.org/pep-0745/)（访问：2026-07-10）。
- Node 24 当前正式补丁版为 **24.18.0**，代号 Krypton；截至核验日处于 **Active LTS**，计划 2026-10-20 进入 Maintenance，2028-04-30 EOL。Node 26 虽为 Current，但不是本项目应选的生产基线。[Node distribution index](https://nodejs.org/dist/index.json)（访问：2026-07-10）；[Node Release schedule](https://github.com/nodejs/Release/blob/main/README.md)（访问：2026-07-10）。
- Python 使用 PSF License，Node.js 主体使用 MIT License。[CPython license](https://github.com/python/cpython/blob/v3.14.6/LICENSE)（访问：2026-07-10）；[Node v24 license](https://github.com/nodejs/node/blob/v24.18.0/LICENSE)（访问：2026-07-10）。

### Agent framework 与 MCP 版本

| 项目 | 当前版本 | 官方成熟度信号 | 许可证 |
|---|---:|---|---|
| Google ADK Python | 2.4.0 | 正式 2.x release；PyPI 未声明 Development Status classifier | Apache-2.0 |
| Google ADK TypeScript | 1.3.0 | 正式 1.x release | Apache-2.0 |
| PydanticAI | 2.8.0 | PyPI `Production/Stable` | MIT |
| OpenAI Agents SDK Python | 0.18.1 | 官方文档称 production-ready，但包版本仍为 0.x | MIT |
| OpenAI Agents SDK TypeScript | 0.13.1 | 仍为 0.x | MIT |
| LangGraph Python | 1.2.9 | PyPI `Production/Stable` | MIT |
| LangGraph TypeScript | 1.4.7 | 正式 1.x release | MIT |
| MCP Python SDK | 1.28.1 | PyPI `Production/Stable`；官方 Tier 1 | MIT |
| MCP TypeScript SDK | 1.29.0 | 官方 Tier 1 | MIT |

版本来源均为官方包元数据：[PyPI JSON API](https://pypi.org/pypi/)（访问：2026-07-10）和 [npm registry](https://registry.npmjs.org/)（访问：2026-07-10）。许可证另由各官方仓库核对：[Google ADK](https://github.com/google/adk-python)（访问：2026-07-10）、[PydanticAI](https://github.com/pydantic/pydantic-ai)（访问：2026-07-10）、[OpenAI Agents SDK](https://github.com/openai/openai-agents-python)（访问：2026-07-10）、[LangGraph](https://github.com/langchain-ai/langgraph)（访问：2026-07-10）。

MCP 当前协议版本为 **2025-11-25**。官方把 Python 和 TypeScript SDK 均列为 Tier 1；Tier 1 要求完整实现非实验特性、100% 适用 conformance tests、稳定发布和维护承诺。[MCP versioning](https://modelcontextprotocol.io/docs/learn/versioning)（访问：2026-07-10）；[MCP SDK list](https://modelcontextprotocol.io/docs/sdk)（访问：2026-07-10）；[SDK tiers](https://modelcontextprotocol.io/community/sdk-tiers)（访问：2026-07-10）。

## 推断：为什么选 Python 3.14，不选 TypeScript / Node 24

两者都能完成任务，选择 Python 不是因为 Node 不成熟，而是因为本项目的主要复杂度更贴近 Python 生态：

1. Google OKF reference agent 本身是 Python + ADK，可直接复用其 producer、source、writer 和 web-tool 设计。
2. `ast`、`sqlite3`、`tomllib`、`pathlib`、`hashlib`、`ipaddress` 已在标准库中，覆盖第一版 inventory、证据 hash、Python 分析、状态账本与 Web trust boundary。
3. PydanticAI、Google ADK、OpenAI Agents SDK、LangGraph 的 Python 实现都已可用；PydanticAI 还提供最直接的 typed structured output。
4. Python 3.14 的常规修复窗口比 Node 24 的 Active LTS 窗口更长，当前不是“刚发布即采用”。
5. 目标产物是 Markdown/OKF，而不是浏览器应用；TypeScript 的前端优势在核心生成器中用不上。

选择 Node 24 的合理条件只有：团队只维护 TypeScript、需要与现有 Node MCP server/monorepo 深度同进程集成，或者核心分析逻辑必须直接调用 TypeScript compiler API。即便如此也应选 Node 24 LTS，不选 Node 26 Current。

## 推断：Skill-first 仍应避免 Agent framework

第一版运行在 Codex 或 Claude 内时，宿主已经提供：agent loop、上下文、工具调用、文件操作、shell、MCP 和人工交互。再嵌一层 ADK/PydanticAI/LangGraph 会重复管理模型调用、session、tool schema 和 tracing，却不能解决真正的风险：

- 是否枚举了完整 source snapshot；
- 每个 major obligation 是否有终态；
- claim 是否有可验证 source span；
- refresh 是否静默丢掉旧内容；
- 构建失败是否阻止正式发布。

因此第一版只需要：

```text
SKILL.md
  → Python guard prepare
  → 宿主 Agent 动态探索并写 staging artifacts
  → Python guard check-and-publish
```

只有出现以下需求时才加入独立 Agent runner：定时无人值守构建、API/队列触发、多用户任务、需要在非 Codex/Claude 环境运行、或需要跨进程 pause/resume。

## 独立运行时的四框架比较

### 能力事实矩阵

| 能力 | Google ADK 2.4 | PydanticAI 2.8 | OpenAI Agents 0.18 | LangGraph 1.2 |
|---|---|---|---|---|
| Structured output | `input_schema` / `output_schema`；但 `output_schema` 与 tools 同请求依赖特定模型 | `output_type` 支持 Pydantic/dataclass/TypedDict/union，并校验返回值 | `output_type` 使用 Pydantic 类型和校验 | 通常经 LangChain `response_format`；不是 core graph 的主要抽象 |
| MCP | client 和 server；stdio/SSE/Streamable HTTP | client 和 server；本地与 provider-native fallback | hosted/local；stdio/SSE/Streamable HTTP；approval/filter/cache | 通过独立 `langchain-mcp-adapters` 包 |
| Session / memory | 内建 Session、event、state；内存、SQLite/Postgres/MySQL、Vertex backend | 消息历史可序列化，但持久化由应用负责 | 内建 session；SQLite、SQLAlchemy、Redis/MongoDB 等扩展 | checkpointer + store 是核心能力；SQLite/Postgres backend |
| Durable execution | Python resumability；Custom Agent 需要自行适配 | 官方支持 Temporal、DBOS、Prefect、Restate | 可序列化 `RunState`；文档列出 Temporal、Dapr、Restate、DBOS 集成 | 核心卖点：checkpoint、resume、time travel、HITL |
| Evals | test/evalset；最终输出与 tool trajectory | `pydantic-evals`，code-first，支持 deterministic、LLM judge、span eval | 内建 tracing，接 OpenAI evaluation suite | 主要配合 LangSmith offline/online evaluation |
| Observability | 原生 OTLP，使用 OTel GenAI conventions | 原生 OTel instrumentation；Logfire 可选，也可发任意 OTel backend | 内建 OpenAI Traces；可替换/追加 trace processor | 主要配合 LangSmith tracing/monitoring |
| 模型中立性 | 支持 Gemini、LiteLLM 等，Google/Vertex 路径最顺 | 明确的多 provider 抽象 | OpenAI 路径最完整，第三方 adapter 可用但能力可能不齐 | 模型中立，通常同时引入 LangChain integration 层 |

官方能力来源：

- Google ADK：[structured output](https://google.github.io/adk-docs/agents/llm-agents/#structuring-data-input_schema-output_schema-output_key)、[sessions](https://google.github.io/adk-docs/sessions/session/)、[resume](https://google.github.io/adk-docs/runtime/resume/)、[MCP](https://google.github.io/adk-docs/tools-custom/mcp-tools/)、[eval](https://google.github.io/adk-docs/evaluate/)、[OTel traces](https://google.github.io/adk-docs/observability/traces/)（均访问：2026-07-10）。
- PydanticAI：[structured output](https://ai.pydantic.dev/output/)、[MCP](https://ai.pydantic.dev/mcp/)、[durable execution](https://ai.pydantic.dev/durable_execution/)、[evals](https://ai.pydantic.dev/evals/)、[OpenTelemetry/Logfire](https://ai.pydantic.dev/logfire/)、[message history](https://ai.pydantic.dev/message-history/)（均访问：2026-07-10）。
- OpenAI Agents SDK：[agents/output type](https://openai.github.io/openai-agents-python/agents/)、[MCP](https://openai.github.io/openai-agents-python/mcp/)、[sessions](https://openai.github.io/openai-agents-python/sessions/)、[durable integrations](https://openai.github.io/openai-agents-python/running_agents/#durable-execution-integrations-and-human-in-the-loop)、[durable RunState](https://openai.github.io/openai-agents-python/human_in_the_loop/#long-running-approvals)、[tracing](https://openai.github.io/openai-agents-python/tracing/)（均访问：2026-07-10）。由于当前会话最初没有 OpenAI Docs MCP，已按官方 skill 要求配置该端点；本轮实际核验使用官方 OpenAI Agents SDK 文档与仓库。
- LangGraph：[overview](https://docs.langchain.com/oss/python/langgraph/overview)、[persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[structured output](https://docs.langchain.com/oss/python/langchain/structured-output)、[MCP adapter](https://docs.langchain.com/oss/python/langchain/mcp)、[LangSmith observability](https://docs.langchain.com/langsmith/observability)、[LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation)（均访问：2026-07-10）。

### 推荐顺序

1. **默认独立 runner：PydanticAI。** 该任务最重视 claim/concept 的 typed extraction 和 provider neutrality；其 `output_type`、Pydantic validation、MCP、code-first eval 与 OTel 正好对应需求。消息/session 持久化不够“全包”不是问题，因为 source/claim/coverage 本来就必须进入自有 SQLite ledger。
2. **Google Cloud / Gemini 优先：Google ADK。** 若部署目标明确是 Vertex Agent Runtime，或要最大程度贴近 Google reference agent，ADK 的 SessionService、resume、eval 和原生 OTLP 更省集成成本。注意 `output_schema + tools` 的模型兼容限制。
3. **OpenAI-only：OpenAI Agents SDK。** 如果模型、hosted MCP、trace/eval 都明确绑定 OpenAI，它是抽象最少的选择之一；但 package 仍为 0.x，应固定精确版本并做 upgrade tests。
4. **需要显式持久状态图时才用 LangGraph。** 它最适合复杂分支、time travel、人工中断、多阶段长流程和 graph-level checkpoint；对单个“探索仓库并生成 Wiki”的动态 agent loop，它会提前引入节点、边、state reducer 和 checkpointer 设计。

## SQLite 是否足够

**足够。** 第一版是同一台机器上的单仓库构建器，写入量小，正式发布只需一次事务。SQLite 官方明确适合 application file format、本地数据分析和替代 ad-hoc disk files；它允许任意数量读者，但同一时刻只有一个 writer。WAL 可让 reader 与 writer 并行，但仍只有一个 writer，并且所有进程必须在同一主机。[Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html)（访问：2026-07-10）；[WAL](https://www.sqlite.org/wal.html)（访问：2026-07-10）；[SQLite public domain](https://www.sqlite.org/copyright.html)（访问：2026-07-10）。

推荐做法：

- 一个 `.okf-wiki/runs.db`；
- Python stdlib `sqlite3`，不加 ORM；
- 一个 writer 负责接收 agent 产出的 structured artifacts；
- 每次 run 用事务，staging bundle 校验成功后才标记 published；
- 只有实际出现读写并发时才开启 WAL；
- 数据库和 WAL 不放网络文件系统。

升级 PostgreSQL 的触发条件，不按“文件数量”拍脑袋，而按运行形态：

- 多台 worker/机器必须共享同一 ledger 或 job queue；
- 多个用户/仓库持续并发写入；
- 直接数据库访问必须跨网络；
- `SQLITE_BUSY`、writer lock wait 已经超过 SLO；
- 需要数据库级 HA、集中备份、权限隔离和运维审计。

PostgreSQL 的 MVCC 允许每条语句看到一致快照，读写之间的锁竞争低于传统 locking model，并内建全文检索；它适合上述服务化阶段。[PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)（访问：2026-07-10）；[PostgreSQL full-text search](https://www.postgresql.org/docs/current/textsearch-intro.html)（访问：2026-07-10）；[PostgreSQL License](https://www.postgresql.org/about/licence/)（访问：2026-07-10）。

## 什么时候加入 Temporal 或向量检索

### Temporal

先不用。SQLite stage checkpoint 足以恢复“扫描完成 / obligations 完成 / extraction 完成 / 校验完成”这类分钟级批任务。

只有同时出现以下一类要求时才上 Temporal：任务跨进程或容器重启必须从精确步骤恢复、运行数小时到数天、等待人工审批或外部事件、需要有界 retry/timeout/compensation、或多个 worker 必须可靠协调。Temporal 官方通过持久 Event History 和 replay 让 workflow 在故障后从此前状态继续；Python SDK 当前为 1.30.0，MIT。[Temporal durable execution](https://docs.temporal.io/evaluate/understanding-temporal)（访问：2026-07-10）；[Temporal Python SDK metadata](https://pypi.org/pypi/temporalio/json)（访问：2026-07-10）；[Temporal repository](https://github.com/temporalio/temporal)（访问：2026-07-10）。

若届时采用 PydanticAI 或 OpenAI Agents SDK，优先用其已有 Temporal integration，不自己重新包装每个 model/tool call。

### Vector DB

先不用。向量召回不能证明 coverage，且会增加 embedding 版本、chunk、索引失效和 reranking 状态。MVP 使用：

```text
deterministic inventory + rg lexical baseline + manifest/AST edges + SQLite ledger
```

只有 benchmark 显示“同义词/概念别名导致的召回缺口”真实存在，且全量 lexical/graph traversal 的延迟或 token 成本超出预算时，才增加 embedding 检索。若届时已经迁移 PostgreSQL，优先在同一数据库增加 vector extension；没有证据表明独立 vector service 必要时，不再多运维一个系统。向量结果只能扩充候选集，不能取代 inventory、evidence 和 coverage gates。

## Tree-sitter 与 OpenTelemetry 的位置

- `tree-sitter 0.26.0` 当前 Python binding 可用，MIT。它提供增量解析和 concrete syntax tree，但第一版不应建立统一多语言 AST 平台：Python 用 stdlib `ast`，TypeScript/Go/Rust 优先调用仓库自身 compiler/list/metadata 工具；某语言的 public API、route 或 symbol obligations 在 benchmark 中持续漏检时，再加对应 grammar。[Tree-sitter](https://tree-sitter.github.io/tree-sitter/)（访问：2026-07-10）；[PyPI metadata](https://pypi.org/pypi/tree-sitter/json)（访问：2026-07-10）；[repository/license](https://github.com/tree-sitter/tree-sitter)（访问：2026-07-10）。
- OpenTelemetry GenAI conventions 截至核验日仍标记为 **Development**，并已迁移到独立 `semantic-conventions-genai` 仓库。可以采用 OTLP 和当前 `gen_ai.*` 命名，但必须 pin conventions 版本并保留映射层，不能把字段稳定性当成承诺。[GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md)（访问：2026-07-10）；[license](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/LICENSE)（访问：2026-07-10）。

## 工具链与 Web ingest 细节

### 当前版本事实

以下版本来自各项目官方 PyPI metadata，均访问于 2026-07-10：

- [`markdown-it-py 4.2.0`](https://pypi.org/pypi/markdown-it-py/json)：Production/Stable，MIT。
- [`mdit-py-plugins 0.6.1`](https://pypi.org/pypi/mdit-py-plugins/json)：Production/Stable，MIT。
- [`PyYAML 6.0.3`](https://pypi.org/pypi/PyYAML/json)：MIT。
- [`httpx 0.28.1`](https://pypi.org/pypi/httpx/json)：PyPI classifier 仍为 Beta，BSD。
- [`markdownify 1.2.3`](https://pypi.org/pypi/markdownify/json)：MIT。
- [`pytest 9.1.1`](https://pypi.org/pypi/pytest/json)：Mature。
- [`Ruff 0.15.21`](https://pypi.org/pypi/ruff/json)：Production/Stable。
- [`ty 0.0.58`](https://pypi.org/pypi/ty/json)：Beta，MIT。
- [`FastAPI 0.139.0`](https://pypi.org/pypi/fastapi/json)：PyPI classifier 仍为 Beta；本项目第一版不需要 HTTP 服务。

`ty` 官方明确说明仍采用 `0.0.x`、没有稳定 API、任意版本间可能出现 breaking changes。因此可以在编辑器或 CI 中提供附加反馈，但不能成为唯一 type gate；先依靠 tests、Pydantic runtime validation 和 Ruff，若项目确实需要严格静态类型门，再并行保留成熟 checker 直至 ty 稳定。[ty README/version policy](https://github.com/astral-sh/ty#version-policy)（访问：2026-07-10）。

`uv` 当前为 0.11.28，PyPI 标记 Production/Stable；其 `uv.lock` 是跨平台 universal lockfile，应提交版本控制。仓库同时提供 MIT 与 Apache-2.0 许可证文本。[uv PyPI metadata](https://pypi.org/pypi/uv/json)（访问：2026-07-10）；[uv lockfile docs](https://docs.astral.sh/uv/concepts/projects/layout/#the-lockfile)（访问：2026-07-10）；[uv repository](https://github.com/astral-sh/uv)（访问：2026-07-10）。

### Web ingest 必须放在代码中的 guards

`httpx` 只负责 HTTP client，不负责内容正确性或安全边界；`markdownify` 只负责 HTML → Markdown。最低限度还必须由 deterministic core 强制：

1. scheme allowlist，只允许 `https`，确有需要才开放 `http`；
2. DNS 解析后拒绝 loopback、private、link-local、multicast 和保留 IP；
3. 每一次 redirect 都重新校验最终 scheme、host、IP 和 path policy；
4. connect/read/total timeout、最大 redirect 数、单页 bytes 与整次 crawl bytes/token budget；
5. streaming 读取，超过限制时停止，而不是先读完整 body；
6. 记录 `source_url`、final URL、fetch time、content type、digest、是否截断；
7. required source 一旦截断，coverage gate 失败；optional web enrichment 才允许带 warning 发布；
8. 只让 Agent 决定“下一页”，不让 Agent修改 allowlist、预算或 trust policy。

## 最终建议

```text
现在：
Python 3.14 + Skill + Pydantic v2 + SQLite + markdown-it-py
+ git/rg/stdlib AST + pytest/Ruff + uv

脱离宿主独立运行：
+ PydanticAI

明确 Gemini / Vertex：
PydanticAI 可换 Google ADK

明确 OpenAI-only：
PydanticAI 可换 OpenAI Agents SDK

出现持久状态图 / time travel /复杂 HITL：
再考虑 LangGraph

出现跨主机高并发共享状态：
SQLite → PostgreSQL

出现小时/天级可靠工作流：
+ Temporal

实测 lexical/graph recall 不足：
+ vector retrieval；仍不替代 coverage ledger
```

这套选择把新增技术限制在直接解决当前问题的部分：LLM 负责动态探索与语义归纳，Python/SQLite 负责完整性、证据、可恢复性和发布安全。
