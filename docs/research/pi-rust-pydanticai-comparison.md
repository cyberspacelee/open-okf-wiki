# Pi Agent、Rust Agent 路线与 PydanticAI：OKF Wiki 生成器选型

访问与核验日期：2026-07-10

## 结论

对于“代码仓 / Markdown 需求仓 → agentic 分析 → Google OKF Wiki”，默认架构仍应是：

```text
code-backed Skill
        ↓
确定性 Python core + SQLite ledger
        ↓
宿主 Agent 动态选择目录、查询和只读工具
        ↓
typed claims/concepts + evidence spans
        ↓
coverage / citation / contradiction / link gates
        ↓
staging → atomic publish
```

如果任务运行在 Codex、Claude Code 或其他已经提供 agent loop、工具和人工交互的宿主中，**第一版不应再嵌 Pi、Rig 或 PydanticAI**。这三个框架都不能替代 source inventory、obligation/coverage ledger、claim provenance 和发布闸门；重复引入一层 runner 只会增加 session、provider 和工具生命周期的复杂度。

只有需要脱离宿主、定时或无人值守运行时，才在三条路线中选择：

1. **企业默认：PydanticAI 2.8.0。** typed final output、MCP、人工审批、durable integrations、evals 和 OpenTelemetry 最完整，最贴合“结构化 claim 提取 + 可验证发布”。
2. **Node/TypeScript 团队与交互式 coding harness：Pi 0.80.6。** 现成 CLI、SDK、RPC、JSONL session、skills/extensions 和代码探索体验很好；但 MCP、权限、sandbox、first-class typed final output、eval 和 OTel 都要自己补。生产集成应优先复用已经在用的 `pi-coding-agent` SDK/RPC，并精确 pin 版本，不应直接押注仍在迁移中的新 `AgentHarness`。
3. **Rust-first、单二进制、低资源或供应链约束强：Rig 0.39.0 + `rmcp` + 自建 ledger。** Rig 的 sans-I/O、可序列化 `AgentRun` 和 typed extractor 很适合做可靠内核，但它是库，不是完整运行平台；session store、eval harness、审批、sandbox、调度和运维控制面主要由团队承担。

简化判断：

| 组织条件 | 建议 |
|---|---|
| 已在 Codex/Claude 宿主运行 | Skill + deterministic core；不加独立 runner |
| Python/数据/AI 团队，要最快做到可测、可观测、可恢复 | PydanticAI |
| TypeScript 团队，首要目标是复用成熟终端 coding-agent 体验 | Pi coding-agent SDK/RPC |
| Rust 平台团队，重视单二进制、资源占用和细粒度控制，能长期维护基础设施 | Rig 路线 |
| 无人值守分析不可信仓库 | 三者都必须放进容器、VM 或策略 sandbox；框架选择不能替代隔离 |

## 研究范围与“Rust 路线”定义

本报告只使用官方文档、官方仓库源码、官方 release 和包注册表资料。

“Rust Agent”不是一个单一产品。为使比较可执行，本文把主路线定义为：

```text
Rig 0.39.0
  + Rig 的 AgentRun / Extractor / telemetry
  + 官方 Rust MCP SDK rmcp
  + 应用自建 SQLite/Postgres event/coverage ledger
  + OS/container sandbox
```

选择 Rig 是因为其当前版本已经把 agent loop 抽成 sans-I/O、可 step、可序列化的状态机，比较适合在 OKF pipeline 中由确定性 control plane 驱动。Rust 生态中还存在 [Swiftide 0.32.1](https://github.com/bosun-ai/swiftide/releases/tag/v0.32.1)：它已有 agent loop、MCP tool、approval wrapper、typed task graph 与 pause/resume，RAG/indexing 能力也更全；但官方 README 明确警告仍在 heavy development、可能 breaking，最近 release 也早于 Rig 当前版本。若团队更看重一体化 Rust RAG/agent harness，可单独做 Swiftide spike，但不改变“仍需自有 coverage/provenance 和 OS 隔离”的结论。

## 当前版本、成熟度与许可证

| 路线 | 核验版本 | 发布/成熟度信号 | Runtime | 许可证 |
|---|---:|---|---|---|
| Pi agent/coding-agent | 0.80.6 | 2026-07-09；0.x，近期迁移到 `earendil-works/pi` 与新 npm scope，CHANGELOG 仍有 breaking change | Node `>=22.19.0` | MIT |
| Rig | 0.39.0 | 2026-06-19；release 本身包含 breaking changes，README 提醒未来仍可能 breaking | Rust | MIT |
| Rust MCP SDK `rmcp` | 2.2.0 | 2026-07-08；MCP 官方列为 Tier 2 | Rust | Apache-2.0 |
| PydanticAI | 2.8.0 | 2026-07-10；PyPI `Production/Stable`；V2 stable 于 2026-06-23 发布 | Python `>=3.10` | MIT |
| Swiftide（备选） | 0.32.1 | 2025-11-15；README 明示 heavy development / breaking risk | Rust | MIT |

版本来源：[Pi package](https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/0.80.6)、[Pi license](https://github.com/earendil-works/pi/blob/v0.80.6/LICENSE)、[Rig release](https://github.com/0xPlaygrounds/rig/releases/tag/v0.39.0)、[Rig license](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/LICENSE)、[`rmcp` release](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v2.2.0)、[MCP SDK tiers](https://modelcontextprotocol.io/community/sdk-tiers)、[PydanticAI release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.8.0)、[PydanticAI PyPI](https://pypi.org/project/pydantic-ai/2.8.0/)、[PydanticAI license](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/LICENSE)。

版本风险不能只看“是否最新”：

- Pi 的旧 `@mariozechner/*` scope 已迁往 `@earendil-works/*`；应固定新 scope、精确版本和 session/schema upgrade tests。
- Rig 0.39.0 引入新的 sans-I/O `AgentRun`，release 中直接标注 breaking；其序列化格式也明确没有跨版本稳定保证，恢复时必须使用挂起该 run 的同一 Rig 版本。
- Rig 0.39.0 workspace 仍 pin `rmcp = 1.7.0`，而官方 Rust SDK 最新是 2.2.0；若应用需要最新协议能力，升级 bridge 本身就是一项兼容性工作。
- PydanticAI V2 承诺 minor release 不故意 breaking，但 message/event 新增字段和 OTel span attributes 变化不算 breaking；consumer 仍应防御式解析并固定 instrumentation version。

## 能力矩阵

“强”表示框架当前已有直接、文档化的能力，不表示它能保证 Wiki 内容完整或事实正确。

| 能力 | Pi 0.80.6 | Rust：Rig 0.39 + `rmcp` | PydanticAI 2.8 |
|---|---|---|---|
| 私有模型/provider | **强**：多 provider，支持 Ollama、vLLM、LM Studio 和任意 OpenAI-compatible；可自定义 base URL、headers、OAuth/provider | **强**：20+ provider、Ollama/Llamafile/OpenAI-compatible；trait 可扩展 | **强**：广泛 provider；Ollama 本地/远程；custom model/provider/`AsyncOpenAI(base_url=...)` |
| Agent tool loop | **强**：stateful loop、stream events、parallel/sequential tools、before/after hooks、steering/follow-up、abort | **强**：`AgentRun` 可 step，max turns、tool concurrency、hooks、invalid-tool recovery | **强**：tools/toolsets、参数校验、retry、timeout、parallel/sequential、usage limits |
| MCP | **弱**：官方明确 No MCP；需 extension | **中-强**：Rig 有 `rmcp` bridge、tool-list refresh、tool timeout；但 SDK Tier 2 且 Rig pin 较旧版 | **强**：client/server；stdio、Streamable HTTP、SSE、in-process；sampling、elicitation、provider-native MCP |
| Session/history | **中-强**：coding-agent JSONL tree、branch/fork/import/export、auto-save、compaction | **中**：`AgentRun` 可 serialize/deserialize；conversation memory 默认偏 in-memory，持久 store 由应用提供 | **中**：message history 有标准 JSON adapter；真正落库由应用负责 |
| Durable execution | **弱-中**：现有 JSONL 可恢复交互会话；新 durable harness 是 semi-durable design notes，尚非完成能力 | **中**：状态机可在 model/tool pending 之间持久化恢复；没有现成 durable service/control plane | **强**：官方支持 Temporal、DBOS、Prefect、Restate；另有 Kitaru、Airflow 集成 |
| Structured final output | **弱**：TypeBox 强在 tool args；无同等级 first-class typed final result | **强**：output schema；`Extractor<T>` 以 `serde` + `schemars` 校验并 retry | **强**：`output_type` 支持 Pydantic/dataclass/TypedDict/union 等并验证、重试 |
| Eval | **弱**：未发现 first-class eval framework | **弱-中**：未发现 Rig 官方独立 eval package；需自建或接外部 | **强**：`pydantic-evals` 有 dataset/case/evaluator/report，支持 deterministic、LLM judge、span eval |
| Observability | **中-弱**：事件流、token/cost、JSONL；observability 文档是 design notes，不是现成 OTel 实现 | **中-强**：`tracing` 与 OpenTelemetry GenAI spans | **强**：原生 OTel instrumentation；可用 Logfire 或任意 OTel backend，并可排除 prompt/tool 内容 |
| 扩展方式 | **强**：skills、extensions、prompt/templates、themes、custom provider、SDK/RPC | **强但偏工程化**：Rust traits、providers、tools、memory/vector store；扩展需编译、发布 | **强**：capabilities、hooks、toolsets、providers、dependency injection、MCP、第三方包 |
| HITL / approval | **弱**：无内建 permission popup；extension 自建 | **弱-中**：Rig core 需自建；Swiftide 有 `ApprovalRequired` 可参考 | **强**：`requires_approval`、动态 `ApprovalRequired`、deferred request/result、MCP toolset approval wrapper |
| Sandbox / isolation | **弱**：官方明确无内建 sandbox | **弱**：Rust memory safety 不是 tool/process 隔离；应用/OS 自行负责 | **中-弱**：有校验、审批、timeout，但 core tool 仍在应用权限下运行；sandbox 是外部/可选集成 |
| 直接部署体验 | **强（交互）**：现成 CLI/headless/JSON/RPC/SDK | **弱-中**：适合做单 binary，但需要自己组装 runner 与控制面 | **强（应用）**：Python package 与 integrations 完整；仍需封装 CLI/worker/service |

## 关键能力判断

### Provider 与 tool loop

三者都能接私有模型。Pi 的 [`pi-ai`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/ai/README.md)明确支持 Ollama、vLLM、LM Studio 和任意 OpenAI-compatible API；Rig 通过统一 interface 和 Rust trait 扩展 provider；PydanticAI 支持 custom model/provider、`AsyncOpenAI(base_url=...)` 与[自托管 Ollama](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/ollama.md)。应用必须记录 provider capability profile，不能假设所有“OpenAI-compatible”端点都支持并行工具或原生 JSON schema。

Pi 的 [agent core](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/README.md)最像现成 coding harness；Rig 的 [`AgentRun`](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/agent/run/mod.rs)把每一步显式化，最容易插入 transaction、checkpoint 与 policy；PydanticAI 的 [advanced tools](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools-advanced.md)内建校验、retry、timeout、parallel/sequential 和 usage limits。Wiki agent 应只暴露少量、语义清晰的只读工具。

### MCP、session 与 durability

Pi 官方明确 [No MCP](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/README.md#what-pi-doesnt-have)，只能通过 extension 补。Rig 的 [`rmcp` bridge](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/tool/rmcp.rs)支持 tool-list refresh 和 timeout，但 Rig 0.39 pin `rmcp 1.7.0`，与官方 2.2.0/Tier 2 存在升级成本。PydanticAI [MCP client](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/mcp/client.md)支持 stdio、Streamable HTTP、SSE、in-process、sampling 和 elicitation；其配置可启动任意 subprocess，只能加载可信配置。

Pi coding-agent 有 JSONL tree、branch/fork、import/export 和 compaction，但 transcript 恢复不等于 tool side effect exactly-once。新 [`AgentHarness`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/agent-harness.md)仍有 provisional/未实现项，[durable harness](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/durable-harness.md)是 semi-durable 设计说明，不能当作现成功能。

Rig `AgentRun` 可在 model/tool pending 之间序列化恢复，但格式无跨版本稳定保证，且没有现成数据库、queue、lease 或 workflow UI。PydanticAI [message history](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/message-history.md)可 JSON 序列化，持久化仍由应用负责；需要长流程时可用官方 [Temporal、DBOS、Prefect、Restate](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/durable_execution/overview.md) 集成。

### Structured output、eval 与 observability

Pi 的 TypeBox 强在 tool arguments，没有同等级 first-class typed final result；需自建 `submit_claims` / `finalize_run` tool。Rig [`Extractor<T>`](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/extractor.rs)用 `serde` + `schemars` schema、`submit` tool 和 retry 返回 typed result。PydanticAI [`output_type`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/output.md)支持 Pydantic/dataclass/TypedDict/union 等并校验、重试，是当前最省工程量的 claim/concept extraction 方案。

typed output 只保证形状，不保证证据蕴含 claim。应用仍须重新读取 source span、核验 revision/hash、检查矛盾，并把低置信结果送 verifier/human queue。

Pi 有事件、token/cost 和 JSONL，但 [observability](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/observability.md)仍是 Design Notes，也没有 first-class eval。Rig 有 [`tracing`/OTel telemetry](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/telemetry/mod.rs)，eval harness 要自建。PydanticAI 有 [`pydantic-evals`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/evals.md)与 [OTel/Logfire](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/logfire.md)，并可排除 prompt/tool 内容。

Wiki eval 至少应测 obligation recall、evidence validity、concept merge/split consistency、citation freshness、silent deletion、多次运行方差、成本和人工复核量，而不只是文章“观感”。

## 安全边界

### Pi

Pi 的 [security 文档](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/security.md)非常明确：

- project trust 只是项目资源加载保护，不是 sandbox；
- built-in tools 和 extensions 以 Pi 进程用户权限执行；
- prompt injection 来自 repo 文件、注释、文档和 build output，是预期的本地 agent 风险；
- 不可信仓库或无人值守任务应使用 container、VM、micro-VM 或 policy sandbox。

官方 [containerization 文档](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/containerization.md)给出 Gondolin、Docker 和 OpenShell 方案。即使在容器中，read-write bind mount 仍可修改宿主文件；更强边界应使用 read-only mount 或复制进出，并只注入最小凭据。

### Rust

Rust 的 ownership、类型和内存安全能减少 runner 自身的一类 bug，但不会限制 LLM 调用的 shell、filesystem、network 或 MCP tool。Rig 没有内建 sandbox；真正的安全边界仍是：

- tool allowlist 与 typed args；
- read-only snapshot；
- 网络、路径、进程、CPU/内存/时间预算；
- container/VM/seccomp/namespace 或组织已有 sandbox；
- credentials broker 与短期 token；
- publish 使用独立低权限进程和人工/策略审批。

### PydanticAI

PydanticAI 比另外两条默认路线多出 tool 参数校验、timeout、usage limits、`requires_approval`、deferred tool flow、untrusted history sanitizer 和 telemetry content exclusion。这些是重要 guardrail，但不是进程隔离。普通 Python tool 仍有应用进程权限；MCP stdio config 还能启动 subprocess。

Pydantic 另有 `mcp-run-python` sandbox server，Pydantic AI Harness 的 Code Mode 也引用 Monty sandbox，但它们是可选/独立集成，不能写成 PydanticAI core 对所有工具自动隔离。

### 本项目的最低安全基线

无论选择哪条路线，OKF Wiki generator 都应默认：

1. 分析阶段只读 mount 固定 source snapshot；
2. 模型不能直接写正式 Wiki，只能提交 typed proposal 到 staging/ledger；
3. shell、network、MCP 和 web fetch 都走 allowlist 与预算；
4. Web 每次 redirect 重做 scheme/host/IP 校验，并限制 bytes、hop、page/token budget；
5. secret 不进入 prompt、session 或 trace；
6. publish worker 与 analysis worker 分权，只有 hard gates 全通过才能原子替换 bundle；
7. 不可信 repo 的指令、`AGENTS.md`、README 和代码注释均按 data 处理，不能覆盖 system policy。

## 如何保证不丢主要内容和准确提取 concept

框架选型不能给出这种保证。LLM 是概率模型，正确做法是把“完整性”从 prompt 愿望改成可检查的系统属性。

### 1. 固定输入宇宙

在任何 LLM 调用前，由代码固定 commit/content digest，枚举所有 `SourceUnit`：文件、Markdown section、manifest、public symbol、route/schema、配置入口、ADR/requirement。忽略规则、二进制、generated/vendor 和大小上限必须显式进入 run manifest。

### 2. 先生成 obligations，不先让 LLM 宣布 concepts 全集

`concept` 本身是语义输出，不能用模型第一次列出的 concepts 证明完整。应从确定性结构生成 must-cover obligations，例如：

- 每个需求标题/验收条款；
- 每个 public package/module/command/API route；
- 每个配置 schema 和持久化实体；
- 每个 load-bearing flow、security boundary 和 failure mode；
- 每个 source unit 至少有 `covered / irrelevant(reason) / blocked(reason)` 终态。

### 3. LLM 只提交 typed、带证据的 proposal

Agent 可以动态决定下一步读哪些目录、用 `rg` 还是 AST/MCP、如何改写 query，但每个 claim/concept/relation 都必须带固定 revision 的 source span。工具只返回有稳定 ID 的内容块，避免模型靠文件名或记忆伪造引用。

### 4. 双向 coverage

发布前同时检查：

```text
source/obligation → claims/concepts/pages
page/claim         → source evidence/obligation
```

前者发现遗漏，后者发现无来源内容。每个 concept 至少要有 defining claim；每个高风险 claim 要有独立 verifier 或人工终态。

### 5. 独立 verifier 与确定性 gates

Extractor 与 verifier 不共享同一短上下文；verifier 重新读取 evidence，检查 entailment、冲突和概念 merge/split。最终用代码检查 frontmatter、IDs、links、citation、source freshness、coverage threshold、silent deletion 和 staging completeness。LLM 无权跳过 gate 或把 warning 改成 pass。

### 6. 用 benchmark 而不是一次 demo 选模型/框架

建立代表性仓库集，故意包含跨文件概念、隐含规则、冲突需求、生成代码、过期文档、同义词和超长目录。至少重复运行 3–5 次，测 obligation recall、claim precision、evidence validity、concept consistency 和成本分布。只有 benchmark 证明 retrieval recall 不足时才加 embedding/vector；向量 top-k 只能扩候选，不能证明 completeness。

这套设计与三种 runner 都兼容，但 PydanticAI 的 typed output/evals/OTel 能少写最多基础设施；Rig 的 steppable state machine 最适合平台团队把每一步包进 transaction；Pi 则要用 finalize tool、extension 和外部 ledger 补齐。

## 部署、维护与总拥有成本

| 项目 | Pi | Rig 路线 | PydanticAI |
|---|---|---|---|
| 最快 demo | 很快：直接 CLI/SDK/RPC | 最慢：先组 runner | 快：少量 Python 即可 |
| 交互式 UX | 最强，现成 terminal coding harness | 需自建 | 需自建 CLI/UI，已有 UI adapters 可用 |
| 独立 worker/service | 可行，但需补 typed artifacts/eval/OTel/MCP | 可行且资源低，但控制面自建最多 | 最顺，durable/OTel/eval 集成完整 |
| 单 binary / 冷启动 / 内存 | Node runtime，中等 | 最优潜力 | Python runtime，中等 |
| 开发人才供给 | TypeScript 广 | Rust 相对窄 | Python/AI 最广 |
| 升级风险 | 0.x、新 scope、高 churn | 0.x、breaking、MCP bridge 版本差 | V2 stable，相对最低；仍需 pin minor 与 OTel schema |
| 基础设施自建量 | 中-高 | 最高 | 最低 |
| 长期可控性 | 高度可定制，但 extension surface 大 | 最高，代价是平台团队长期 ownership | 平衡最好 |

容易低估的成本：

- **Pi**：MCP bridge、permission/approval、structured final protocol、eval harness、OTel adapter、sandbox routing，以及跟随 0.x/schema 变化的回归测试。
- **Rust**：provider/MCP 升级、persistent session/event store、worker lease/retry、schema migration、eval/report、UI/HITL、sandbox integration、cross-version resume policy。
- **PydanticAI**：Python service packaging、消息/业务 ledger 落库、provider capability differences；采用 Temporal/DBOS 等之后，还要承担相应服务本身的运维。

因此“Rust 单 binary 更便宜”只在已有 Rust 平台团队、长期请求量或部署密度足以摊薄研发成本时成立；“Pi 已有 coding agent”也只减少交互层，不会自动减少 OKF correctness control plane；PydanticAI 依赖更多 Python package，但对当前需求通常拥有最低的工程总成本。

## 条件式推荐

### 选择 PydanticAI，如果

- 组织以 Python、数据或 AI 工程为主；
- typed claim/concept extraction 是核心；
- 需要 MCP、HITL、eval、OTel 或未来 durable workflow；
- 希望私有模型与商用 provider 可替换；
- 目标是尽快建立可测试的企业 runner，而不是先造 agent platform。

推荐形态：PydanticAI 只负责语义 plane；SQLite/Postgres 中的 inventory/obligation/claim ledger 和 publish gate 仍是自有 deterministic core。

### 选择 Pi，如果

- 团队是 TypeScript-first；
- 已经使用 Pi 或希望复用成熟 terminal coding-agent UX、session tree、skills/extensions、SDK/RPC；
- 主要流程有人在环，容许把 MCP、approval、eval、typed finalize 和 sandbox 作为自己的 integration layer；
- 可以精确 pin 0.80.6 并为升级维护兼容测试。

推荐形态：复用 `pi-coding-agent` SDK/RPC，外接 `submit_claims` / `finalize_run` tools 和 SQLite ledger。不要把 provisional `AgentHarness`、durable design notes 或 observability design notes 当成已经交付的生产能力。

### 选择 Rig/Rust，如果

- 组织本来就有 Rust 平台团队和 on-call ownership；
- 单二进制、低内存、快速启动、边缘/受限环境或供应链审计是硬要求；
- 希望显式驱动每个 model/tool step，并在 transaction/queue 边界持久化；
- 愿意自建 eval、session store、approval、sandbox、worker control plane 和管理界面；
- 接受 Rig 与 `rmcp` 仍可能 breaking，并会 pin suspended run 的完整版本。

推荐形态：Rig `AgentRun` 作为 semantic state machine，应用 driver 把每个 step 写入 ledger；structured extraction 用 `Extractor<T>`；MCP bridge 与 sandbox 放在 adapter 层。若还需要一体化 RAG/indexing、typed tasks 和 HITL，可同时 spike Swiftide，但不要在没有 benchmark 的情况下叠加两个 Rust agent framework。

## 最终建议

```text
现在（推荐）：
Skill + Python deterministic core + SQLite

脱离宿主的默认独立 runner：
+ PydanticAI 2.8.0

TypeScript / 交互式 coding harness 优先：
+ Pi coding-agent SDK/RPC 0.80.6
+ 自建 typed finalize / MCP / eval / OTel / sandbox adapter

Rust-first 且平台能力充足：
+ Rig 0.39.0 + rmcp + 自建 ledger/control plane

所有方案共同保留：
fixed snapshot + inventory + obligations + evidence + bidirectional coverage
+ verifier + hard gates + staged atomic publish
```

选择 runner 只决定 agent loop 周边有多少能力需要自建；“不丢主要内容、准确提取 concept”的核心保证来自确定性 coverage/provenance 体系，而不是某个模型、prompt 或 agent framework。

## 官方来源索引

- **Pi：** [agent core](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/README.md)、[`pi-ai`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/ai/README.md)、[coding-agent](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/README.md)、[session format](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/session-format.md)、[custom provider](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/custom-provider.md)、[security](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/security.md)、[containerization](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/docs/containerization.md)、[AgentHarness](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/agent-harness.md)、[durable design](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/durable-harness.md)、[observability design](https://github.com/earendil-works/pi/blob/v0.80.6/packages/agent/docs/observability.md)。

- **Rust：** [Rig README](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/README.md)、[release](https://github.com/0xPlaygrounds/rig/releases/tag/v0.39.0)、[`AgentRun`](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/agent/run/mod.rs)、[`Extractor<T>`](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/extractor.rs)、[`rmcp` bridge](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/tool/rmcp.rs)、[telemetry](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-core/src/telemetry/mod.rs)、[`rig-memory`](https://github.com/0xPlaygrounds/rig/blob/v0.39.0/crates/rig-memory/README.md)、[Rust MCP SDK 2.2.0](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v2.2.0)、[SDK tiers](https://modelcontextprotocol.io/community/sdk-tiers)、[Swiftide 0.32.1](https://github.com/bosun-ai/swiftide/releases/tag/v0.32.1)。

- **PydanticAI：** [version policy](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/version-policy.md)、[models/providers](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/overview.md)、[OpenAI-compatible](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/openai.md)、[Ollama](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/ollama.md)、[structured output](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/output.md)、[tools](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools-advanced.md)、[approval](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/deferred-tools.md)、[MCP](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/mcp/client.md)、[history](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/message-history.md)、[durable execution](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/durable_execution/overview.md)、[evals](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/evals.md)、[OTel/Logfire](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/logfire.md)。
