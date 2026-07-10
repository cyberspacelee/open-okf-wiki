# 从代码仓/需求仓生成 OKF Wiki 的 Agent 设计研究

访问与核验日期：2026-07-10

## 结论

推荐实现为 **code-backed skill（带确定性代码内核的 Skill）**，不是纯 prompt，也不是先造一套独立的多 Agent 平台。

- Skill 负责概率性、需要判断的部分：理解用户目标，动态选择要深入的目录，改写搜索词，选择只读工具，提出 concept、claim、relation 和页面结构。
- 代码内核负责可判定的不变量：固定 source snapshot，枚举输入全集，生成 must-cover obligations，维护证据和覆盖账本，校验 OKF、引用、断链和增量删除，最后原子发布。
- LLM 可以决定“下一步研究什么”，但不能决定“输入全集是什么”、不能自行宣布“已经完整”、不能绕过质量门直接覆盖正式 Wiki。

一句话架构：

```text
确定性 control plane                    概率性 semantic plane

snapshot → inventory → obligations → agentic exploration/extraction
                                      ↓
publish ← hard gates ← coverage ledger ← claims/concepts/relations
```

能真正保证的是：相对于一个固定 snapshot 和公开的 coverage policy，每个输入单元都有终态，每个发布事实都有可解析证据，所有硬性校验通过后才发布。

不能保证的是：现实中的所有隐含概念都被识别、所有同义词都正确合并、所有推断都是真实事实。后者只能通过 benchmark、独立 verifier 和人工抽检降低风险。

## 研究范围与方法

本研究优先检查一手资料：本仓库 `refs/` 中的源码与规范、项目官方仓库、官方文档和论文。重点分析：

1. Google Open Knowledge Format（OKF）真正约束了什么。
2. 现有 LLM Wiki 项目如何做仓库分析、生成、检索与增量更新。
3. 概率模型如何与确定性覆盖、provenance 和发布闸门组合。
4. 应实现为 Skill、代码程序，还是两者结合。

本地参考快照：

- GoogleCloudPlatform/knowledge-catalog：`d44368c15e38e7c92481c5992e4f9b5b421a801d`
- inkeep/open-knowledge：`10cdd4af77db82f5edf768e44ef84ed9a388d38f`
- iwe-org/iwe：`3099062ffb21c01e04b762ac7cec5c1c1a704ac8`

## OKF 只解决交换格式，不解决生成质量

Google OKF v0.1 是刻意保持很薄的格式：Markdown 目录树、YAML frontmatter、普通 Markdown 链接和可选的 `index.md` / `log.md`。

本地规范：

- [OKF 格式目标与非目标](../../refs/knowledge-catalog/okf/SPEC.md#1-motivation)
- [Concept 定义与 Bundle 结构](../../refs/knowledge-catalog/okf/SPEC.md#2-terminology)
- [Frontmatter](../../refs/knowledge-catalog/okf/SPEC.md#41-frontmatter)
- [Index progressive disclosure](../../refs/knowledge-catalog/okf/SPEC.md#6-index-files)
- [Citations](../../refs/knowledge-catalog/okf/SPEC.md#8-citations)
- [Conformance](../../refs/knowledge-catalog/okf/SPEC.md#9-conformance)

规范的硬要求主要是：

1. 非保留 `.md` 文件有可解析的 YAML frontmatter。
2. frontmatter 的 `type` 非空。
3. `index.md`、`log.md` 遵循保留文件结构。

规范同时明确：citation 是 `SHOULD`，consumer 要容忍 broken links，未知 `type` 和额外 frontmatter key 都是合法的。因此：

> OKF conformance 不能用作“内容完整、claim 有依据、concept 提取准确”的证明。

生成器必须定义一个更严格的 **producer profile**，例如：

- 每个事实 claim 必须有 source span。
- 内部断链为发布错误，而不是 OKF 所允许的软缺陷。
- 每个 concept 必须有 defining claim。
- `source_revision`、`evidence`、`status` 作为合法扩展字段。
- `index.md` 和目录排序由程序确定性生成。

## `refs/` 中已经存在的可复用模式

### Google OKF reference agent

Google 的参考 producer 已经体现了最重要的可靠性模式：**先由代码枚举 source concept，再让 Agent 逐个 enrich**。

- `Source` Interface 只有 `list_concepts()`、`read_concept()`、可选的 `sample_rows()`：
  [sources/base.py](../../refs/knowledge-catalog/okf/src/reference_agent/sources/base.py)
- `enrich_all()` 先取得完整 concept 列表，再逐个启动 Agent：
  [runner.py](../../refs/knowledge-catalog/okf/src/reference_agent/runner.py)
- 写入工具校验 frontmatter，并在 Web pass 中阻止 BigQuery schema 字段或 citation 数量缩减：
  [bundle_tools.py](../../refs/knowledge-catalog/okf/src/reference_agent/tools/bundle_tools.py)
- Web 工具让 LLM 自由决定下一页，但在工具内强制 host、path、hop depth 和 page budget：
  [web_tools.py](../../refs/knowledge-catalog/okf/src/reference_agent/tools/web_tools.py)
- Web prompt 对 metrics、dimensions、join paths 设置了强制结构和目的地：
  [web_ingestion_instruction.md](../../refs/knowledge-catalog/okf/src/reference_agent/prompts/web_ingestion_instruction.md)

这是本项目最适合复用的起点，许可证为 Apache-2.0。

但它还不能直接解决代码仓/需求仓：

- BigQuery 的 tables/datasets 可以先确定性枚举；任意仓库的领域 concept 是输出，不能先让 LLM 列 concept，再用这份列表证明“concept 全部覆盖”。
- Runner 在 Agent session 结束后就增加 count，没有验证指定 artifact 一定写成功。
- Writer 只检查 citation 数量，不检查某个 claim 是否被 citation 蕴含。
- 没有 SourceUnit terminal ledger、反向 coverage matrix、run-level report 或 staging publish。
- 非 BigQuery 文档仍可能被整个覆盖。

最小扩展不是接入完整 GraphRAG，而是把 `list_concepts()` 的覆盖思想前移成 `list_units()` / `list_obligations()`。

### Google enrichment / discovery 样例

`knowledge-catalog` 的 discovery Skill 使用 baseline + 多个语义变体的 scatter-gather 搜索，然后去重和排序：

- [samples/discovery/SKILL.md](../../refs/knowledge-catalog/samples/discovery/SKILL.md)

Markdown fileset 已提供 `list/read/search` 工具形状，Agent 能动态浏览需求仓：

- [TypeScript Markdown fileset](../../refs/knowledge-catalog/toolbox/enrichment/src/tools/md/fileset.ts)
- [Python files knowledge base](../../refs/knowledge-catalog/samples/enrichment/src/tools/fileskb/main.py)

这说明“让 LLM 动态选目录和工具”并不难；真正缺的是强制覆盖与证据闭环。

### OpenKnowledge codebase-wiki

OpenKnowledge 已实现非常接近目标的 Skill 工作流：

```text
survey → overview → architecture → modules → flows → concepts → link audit
```

主要设计：

- `source_commit` 区分首次 generate 与 refresh。
- 用户用 `audience/depth` 控制公开程度和覆盖深度。
- 源码用原生工具读取，Wiki 用 Markdown/MCP 工具写入。
- 每个 source reference 必须指向实际读过的文件。
- 最后检查 orphan、hub、dead link。
- refresh 通过 `source_commit..HEAD` 只更新受影响页面。

来源：

- [codebase-wiki Skill](../../refs/open-knowledge/packages/server/assets/skills/packs/codebase-wiki/SKILL.md)
- [完整 wiki workflow](../../refs/open-knowledge/packages/server/src/mcp/tools/wiki-body.ts)

它非常适合作为工作流设计参考，但有三个问题：

1. 它没有 source-unit / claim coverage 证明，link audit 只能证明 Wiki 图健康，不能证明源码主要内容都被表达。
2. 当前 `OVERVIEW.md` 没有 `type`，`log.md` 带 frontmatter；不能直接声称与 OKF starter 兼容：
   [starter.ts](../../refs/open-knowledge/packages/server/src/seed/starter.ts)
3. Workflow 在所有页面完成前就写 `source_commit`。中途失败可能让下一次误判为 refresh；revision stamp 应只在最终 check 后提交。

OpenKnowledge 许可证为 GPL-3.0。可以借鉴设计或作为外部工具/Adapter 使用；若本项目不采用 GPL，不应直接复制其实现代码或 Skill 文本。

### IWE

IWE 把 Markdown 表示成可查询图，并通过 MCP 暴露：

- `find` / `retrieve` / `tree`
- `stats` 和 broken-link reports
- graph expansion
- create/update/delete/refactor

来源：[IWE MCP 文档](../../refs/iwe/docs/mcp.md)

IWE 适合作为可选的输出检索和图 QA Adapter，不适合做第一版必需依赖：

- 它不理解 TypeScript/Python/Rust 源码语义。
- MVP 的 link、orphan、index 校验可以用小型 Markdown scanner 完成。
- 直接引入完整 Rust 工具链会增加部署面。

IWE 许可证为 Apache-2.0。

## 同类开源项目对比

以下“功能”来自项目官方 README、源码或论文；“适用/缺口”是基于本目标的设计判断。

| 项目 | 已确认机制 | 许可证 | 对本目标的价值 | 主要缺口 |
|---|---|---|---|---|
| [Google OKF reference agent](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/d44368c15e38e7c92481c5992e4f9b5b421a801d/okf) | 确定性 `list_concepts`；逐 concept Agent；受限 Web crawl；guarded writer；机械 index | Apache-2.0 | 最好的代码复用基线 | 数据资产 concept 可预先枚举；没有通用仓库 coverage/claim ledger |
| [OpenKnowledge](https://github.com/inkeep/open-knowledge) | repo-owned codebase wiki Skill；generate/refresh；source refs；link graph audit；MCP/search/editor | GPL-3.0 | 最好的 Skill 工作流基线 | 不是严格 OKF producer；没有 source-to-wiki 完整性证明；复制代码有 GPL 约束 |
| [IWE](https://github.com/iwe-org/iwe) | 本地 Markdown graph；BM25/fuzzy；关系扩展；stats；broken links；MCP | Apache-2.0 | 适合作为输出检索/QA Adapter | 不分析源代码语义；MVP 直接集成偏重 |
| [DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open) | GitHub/GitLab/Bitbucket 导入；repository embedding/RAG；Wiki、图和问答；目录过滤 | MIT | 说明 RAG + Wiki UX 的常见产品形态 | 官方实现未给出 source-unit terminal ledger 或 claim-level completeness guarantee；RAG top-k 不能证明未遗漏 |
| [OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) | Git/ZIP/local 导入；目录/文档生成；后台任务；incremental update；chat/embed/MCP；多语言与图产物 | MIT | 可参考完整产品和后台处理架构 | 是较重的服务端产品；公开资料未证明 claim-level provenance 与覆盖闭环 |
| [RepoAgent](https://github.com/OpenBMB/RepoAgent) | Python AST；对象关系；逐对象文档；Git change tracking；增量替换 | Apache-2.0 | 结构性代码覆盖和增量更新很有参考价值 | 重点是 Python symbol documentation；symbol 不等于领域 concept；跨语言和需求仓有限 |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | TextUnit → entity / relationship / optional claim；entity/relationship summary；community/report；source IDs | MIT | 最值得借鉴的中间知识模型与 provenance 形状 | 成本高、需要 domain prompt tuning；官方要求领域专家核验，不能提供 completeness guarantee |

### DeepWiki-Open

官方源码显示它把 repository 内容切分、embedding 后通过 RAG 检索上下文，再由模型生成 Wiki/回答。它适合交互式探索和漂亮的生成体验，但 top-k retrieval 的结构决定了它不能证明未检索到的信息不重要。

来源：

- [官方仓库](https://github.com/AsyncFuncAI/deepwiki-open)
- [RAG 实现](https://github.com/AsyncFuncAI/deepwiki-open/blob/main/api/rag.py)
- [repository WebSocket / retrieval flow](https://github.com/AsyncFuncAI/deepwiki-open/blob/main/api/websocket_wiki.py)

### OpenDeepWiki

OpenDeepWiki 是完整的服务端产品：ASP.NET Core 后端、Next.js 前端、SQLite/Postgres、后台 repository processing、catalog/content 生成、翻译、mind map、Graphify、incremental workers、chat 和 MCP。

来源：[官方 README](https://github.com/AIDotNet/OpenDeepWiki/blob/main/README.md)

其产品能力很全面，但不应把“有 scan plan / incremental worker”误解为“有语义完整性证明”。本项目第一版不需要复制其数据库、后台队列、管理 UI 和 provider 配置平台。

### RepoAgent

RepoAgent 通过 AST 分析 Python 对象，识别调用关系，按 Git 变化更新文档。它证明了：结构分析和增量映射应尽量由代码完成，而不是完全依赖 prompt。

来源：

- [官方仓库与 README](https://github.com/OpenBMB/RepoAgent)
- [RepoAgent 论文](https://arxiv.org/abs/2402.16667)

但它的一对象一文档模式容易把实现 symbol 当成 Wiki concept。领域概念应该满足“可命名、有 defining evidence、具有复用或 load-bearing 价值”，不能把每个类/函数都变成 concept 页面。

### GraphRAG

GraphRAG 值得借鉴的不是“装上就不漏”，而是它保留中间结构：documents、text units、entities、relationships、optional claims、communities 和 reports，并在结果中保留 text-unit IDs。

来源：

- [Indexing methods](https://microsoft.github.io/graphrag/index/methods/)
- [Output schemas](https://microsoft.github.io/graphrag/index/outputs/)
- [GraphRAG 论文](https://arxiv.org/abs/2404.16130)
- [Responsible AI FAQ](https://github.com/microsoft/graphrag/blob/main/RAI_TRANSPARENCY.md)

官方同时明确：独特领域需要正确识别 domain-specific concepts、需要 prompt tuning、需要领域专家验证和 provenance tracing。因此 GraphRAG 是知识组织与检索方法，不是完整性证明。

## 三种实现方案比较

### 方案 A：纯 Skill

Interface：用户用自然语言触发 Skill，Skill 直接用 `rg/read/git` 等工具生成 Markdown。

优点：

- 最短开发路径。
- 最大化利用现有 Codex/Claude 等 harness 的 agentic loop。
- 模型和工具天然可替换。

缺点：

- prompt 中的“必须读完”“不得遗漏”无法成为机器可检查的不变量。
- 无法可靠 checkpoint/resume、并发隔离或原子发布。
- 难以证明某个文件、requirement、route 或 claim 是否被处理。
- 不适合 CI。

判断：适合 demo，不适合作为目标产品。

### 方案 B：全代码 Agent 平台

Interface：独立程序自己管理模型 provider、tools、planner、queue、storage 和 UI。

优点：

- 可控、可测试、可后台运行。
- 能统一状态、预算和发布。

缺点：

- 会重复实现已有 agent harness。
- provider factory、工具协议、任务队列、向量库和图数据库很快膨胀。
- 第一版投入大量代码，却不直接提高 concept recall。

判断：当前过度设计。

### 方案 C：code-backed Skill（推荐）

用户侧仍然是一个 Skill：

```text
“为当前仓库生成或刷新 OKF wiki，internal/standard。”
```

Skill 内部调用一个很薄的确定性 Module：

```text
prepare(source, profile) -> WorkManifest
check_and_publish(run, staging_bundle) -> BuildReport
```

Skill/harness 在两者之间执行动态分析。CI 可以单独调用 `check`。

优点：

- 保留真正的 agentic 工具选择。
- 把 coverage、证据、schema、links、staging 和 publish 变成代码不变量。
- 不绑定某个模型 provider。
- Module Interface 小，Implementation 可以逐步深化。

判断：在灵活性、可靠性和代码量之间最优。

## 推荐的深 Module Interface

用户/CI 看见两个入口即可：

```python
build(request: BuildRequest) -> BuildReport
check(request: CheckRequest) -> CheckReport
```

Skill 的 `build` 负责 orchestration；底层 guard code 的真实 seam 可以保持为：

```python
prepare(request: BuildRequest) -> WorkManifest
check_and_publish(run_id: str, staging: Path) -> BuildReport
```

不单独暴露 `refresh()`；`build()` 只读取上一次成功发布的 `source_revision` 自动判断首次生成或 refresh。

`BuildRequest`：

```json
{
  "source": ".",
  "output": "wiki",
  "profile": "internal/standard",
  "revision": "HEAD",
  "web_seeds": []
}
```

`BuildReport`：

```json
{
  "published": false,
  "source_digest": "sha256:...",
  "files": 421,
  "units": 1830,
  "obligations": 312,
  "concepts": 74,
  "claims": 612,
  "hard_failures": [],
  "risk_metrics": {},
  "report_path": ".okf-wiki/report.json"
}
```

Interface 不暴露 prompt、chunk size、模型重试、GraphRAG 参数或 session 结构。这些都属于 Implementation。

## 最小内部数据模型

### SourceUnit

```json
{
  "id": "unit:sha256:...",
  "path": "src/order.py",
  "kind": "file|section|symbol|requirement",
  "span": [120, 380],
  "digest": "sha256:...",
  "anchors": ["Order.submit", "REQ-17"],
  "priority": "major|normal"
}
```

### Claim

```json
{
  "id": "claim:...",
  "text": "An order can only be submitted from draft state.",
  "subject": "concept:order",
  "qualifiers": {
    "condition": "state == draft",
    "polarity": "positive",
    "modality": "must",
    "version": null
  },
  "evidence": [
    {
      "unit_id": "unit:...",
      "path": "src/order.py",
      "span": [210, 292],
      "digest": "sha256:..."
    }
  ],
  "status": "supported|disputed|unsupported"
}
```

### Concept

```json
{
  "id": "concepts/order",
  "title": "Order",
  "aliases": ["Purchase Order"],
  "type": "Domain Concept",
  "defining_claim_ids": ["claim:1"],
  "supporting_claim_ids": ["claim:2"],
  "status": "canonical|provisional|disputed",
  "relations": []
}
```

### Disposition

```json
{
  "unit_id": "unit:...",
  "status": "covered|no_concept|excluded|unsupported|failed",
  "claim_ids": [],
  "page_ids": [],
  "reason": ""
}
```

关键点：retrieval chunk 不是来源。来源必须是 pinned snapshot 中的原始路径、span 和 hash。

## 推荐生成流程

### 1. 固定 snapshot

- Git 仓固定 commit、submodule 状态和 tracked file manifest。
- 非 Git 目录计算文件清单与 digest。
- 记录 dirty/untracked 的包含策略。
- 构建过程中 source digest 改变则拒绝发布。

### 2. 确定性 inventory

代码仓至少枚举：

- workspace/package manifests
- 顶层 packages/modules
- README、ARCHITECTURE、ADR、AGENTS/CLAUDE 等高信号文档
- application / CLI entrypoints
- exported/public symbols
- HTTP routes、commands、events
- schema/type/config declarations
- migrations 与安全/权限边界
- 测试表达的关键行为和 failure modes

Markdown 需求仓至少枚举：

- 每个 H1/H2 section
- 编号需求、checklist、acceptance criteria
- MUST/SHOULD/必须/不得等规范性语句
- tables、fenced code/config
- frontmatter、links、glossary/definitions
- non-goals、open questions、decision/rejected alternatives

第一版不必为所有语言引入 Tree-sitter。先用 manifest parser、Markdown section parser、`rg` 和少量语言原生规则；某语言 benchmark 显示明显缺口时再增加 Adapter。

### 3. 生成 must-cover obligations

“主要内容”不能是 prompt 中的形容词，必须变成可审计 obligations。

示例：

```text
route POST /orders             → must be documented or explicitly excluded
CLI command migrate            → must be documented or explicitly excluded
REQ-17                         → must map to claim/page or explicit exclusion
public type Order              → must have disposition
ADR-004 decision               → must map to decision concept/page
```

Agent 可以决定 obligation 属于哪个 concept/page，但不能让 obligation 消失。

### 4. Agentic map extraction

每个 SourceUnit 或 obligation 进入 Agent loop：

- Agent 可调用 `list/read/search/references/ast/tests_for/git` 等只读工具。
- Agent 可以动态深入邻近目录、追踪 import/call、改写搜索词或沿文档链接扩展。
- 输出必须满足结构化 schema：candidate concepts、atomic claims、relations、aliases、uncertainties、disposition。
- 调度优先 `next_uncovered()`，防止模型在少数有趣目录耗尽预算。

高风险单元才做第二次独立抽取：

- public contract
- security / money / data-loss path
- normative requirements
- 两次结果分歧较大
- 高连接度或 load-bearing concept

普通单元先单次抽取，避免成本失控。

### 5. Reduce 只合并 identity，不丢原始事实

Reduce 负责：

- alias/entity resolution
- concept grouping
- claim 去重
- relation 合并
- conflict detection
- page planning

禁止把“摘要的摘要”作为唯一事实来源。任何页面、concept summary 或 community summary 都必须能回溯到 atomic claim 和 source span。

### 6. 反向 coverage audit

除了 `concept → evidence`，必须检查 `source unit / obligation → concept / claim / page`。

Coverage matrix 的 cell 可以是：

- `defines`
- `supports`
- `examples`
- `tests`
- `contradicts`
- `excluded(reason)`

所有 major obligation 必须有非空映射或显式排除。高优先级 unit 被判断为 `no_concept` 时强制第二次审计。

### 7. 确定性渲染

最稳的 v1：

- LLM 决定 claim 归属与 section。
- Renderer 从 accepted claims 生成 Markdown。
- 每个事实 bullet/paragraph 绑定 claim IDs 和 citations。
- frontmatter、index、排序、链接和 log 由程序生成。

若允许 LLM 做可读性 paraphrase，则每个句子必须返回 `claim_ids`，独立 verifier 检查 entailment；无法映射的句子删除或重写。

### 8. staging、check、publish

所有输出先写 run-specific staging directory。只有以下 hard gates 全部通过才原子替换正式 Wiki，并在最后写入 `source_revision` 与成功日志。

中断或失败不得把半成品标记为 fresh。

## Concept 接受与合并规则

不要“一 symbol 一 concept”。候选 concept 至少满足：

1. 有可引用名字或稳定 identity。
2. 有 defining / contract evidence，不只是被提及。
3. 属于领域概念、流程、规则、数据模型、公开 interface、决策或可独立引用知识。
4. 至少被两个 module/flow/requirement 使用，或虽只出现一次但明确 load-bearing。

可复用 Google Web ingestion 的四类 gate 思想：

- nameable：可以被明确命名和引用。
- non-meta：不是无价值的 overview/changelog 噪音。
- citation test：其它页面确实能写出“见 X 了解……”的句子。
- reuse/load-bearing：被多处复用，或对单一核心行为不可缺少。

Alias 合并必须有证据。无法确认时保留两个 concept，并标记 `possible_same_as`，不要强行合并。

Claim 必须保存 negation、condition、version/time 和 modality。代码、测试、文档冲突时记录 `disputed`，不要静默选一方。

不要依赖 LLM 自报的 `confidence: 0.95`。更可检查的信号是：

- evidence 是 direct / structural / inferred 哪一类
- 是否有多个独立 source spans
- 两次抽取是否一致
- 是否存在冲突证据

## 什么可以保证，什么不能保证

| 目标 | 可以保证吗 | 机制 |
|---|---:|---|
| 声明范围内的文件全部枚举 | 可以 | 固定 snapshot + manifest |
| 每个 SourceUnit 有处理终态 | 可以 | terminal ledger |
| 每个 major obligation 有去向 | 可以 | inverse coverage gate |
| 每个发布 claim 有有效 source span | 可以 | provenance validator |
| 引用未漂移 | 可以 | revision + span + hash |
| OKF/frontmatter/ID/link 合法 | 可以 | deterministic check |
| 旧 load-bearing 内容不被静默删除 | 可以 | evidence diff + deletion gate |
| 失败不覆盖正式 Wiki | 可以 | staging + atomic publish |
| 所有隐含领域 concept 都被发现 | 不可以 | 开放世界、概念边界主观 |
| 引用一定蕴含所有 paraphrase | 不能完全保证 | verifier/人工只能降低风险 |
| alias 合并与关系抽取全部正确 | 不可以 | 同名异义、跨文件隐式关系 |
| Web 找到所有权威页面 | 不可以 | 只能记录 fetched set/frontier |
| 第二个 LLM judge 通过就是真实 | 不可以 | judge 本身有偏差 |

严谨的产品承诺应写成：

> 对 source snapshot S 和 declared coverage policy M，系统保证 M 中每个输入单元都有终态，且每个发布 claim 都有可解析 provenance。系统不保证 M 覆盖现实中的所有相关信息，也不把概率 verifier 当作事实证明。

## 质量门与评估

### 每次 build 的 hard gates

```text
inventory_coverage                 = 1.0
terminal_unit_coverage             = 1.0
required_anchor_disposition        = 1.0
published_claim_evidence_coverage  = 1.0
citation_span_resolvability        = 1.0
source_digest_match                = 1.0
frontmatter/schema parse           = 1.0
broken internal links              = 0
unexpected orphans                 = 0
unresolved critical failures       = 0
unexplained incremental deletions  = 0
```

这些是程序能够真正执行的门。

### 风险指标

下列指标用于拒绝、告警或人工审查，但不是证明：

- atomic claim support / faithfulness
- critical-claim independent support
- extractor disagreement
- disputed claim rate
- unsupported relation rate
- run-to-run canonical concept stability
- source-to-claim human trace time

参考：

- [RAGAS faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/)
- [RAGAS context recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)
- [RAGAS paper](https://arxiv.org/abs/2309.15217)
- [FActScore](https://arxiv.org/abs/2305.14251)
- [RAGChecker](https://arxiv.org/abs/2408.08067)
- [LLM-as-a-judge biases](https://arxiv.org/abs/2306.05685)
- [G-Eval](https://arxiv.org/abs/2303.16634)

生产 build 没有 gold answer，无法计算真正的 concept recall。必须维护独立 release benchmark。

### 最小 benchmark

- 6 个小型合成 fixture。
- 2 个真实小代码仓。
- 2 个真实 Markdown/需求仓。
- 每个 gold concept 带 defining source spans、aliases、criticality 和 relations。
- 标注集与 prompt tuning 集分离。

Fixture 应覆盖：

- concept 跨多个文件定义
- 同义词、缩写、同名异义
- 证据位于长文件中部
- 代码、测试、文档矛盾
- deprecated、negative、conditional statement
- 只有测试才揭示的行为
- route/config/schema/state machine
- generated/vendor 噪音
- 跨模块关系

Mutation / metamorphic tests：调整文件顺序、移动证据位置、文件重命名、增加无关文件、拆分 concept、添加冲突版本。期望 canonical concept graph 只产生预期变化。

“Lost in the Middle”说明长上下文装得下不等于不会漏掉中间信息，因此必须按结构 map，不依赖一次性把整个仓库塞入 context：

- [Lost in the Middle](https://arxiv.org/abs/2307.03172)

## Web 检索的安全与完整性边界

Google reference agent 的“模型选策略、工具控权限”模式应保留，并补齐：

- allowlisted schemes/hosts/path prefixes
- redirect 后重新验证最终 host/IP
- 阻止 localhost、link-local、private network SSRF
- page、bytes、tokens、depth 和 wall-clock budgets
- fetched content hash、timestamp、HTTP status、truncation metadata
- 只允许引用真正 fetch 过的 URL
- 记录未探索 frontier，不声称 Web complete

现有 Google fetcher 会截断页面内容；任何 required source 被截断都应成为 hard failure 或显式 partial disposition，而不是静默继续。

## 增量更新

刷新不能只做 `git diff --stat` 后让模型猜受影响页面。需要保存：

```text
source unit → claims → concepts → pages
```

Refresh：

1. 比较上次成功发布 revision 与新 snapshot。
2. 失效 changed/deleted units 产生的 claims。
3. 沿反向映射找到受影响 concepts/pages。
4. Agent 只重新分析受影响区域，并允许追踪新的邻接依赖。
5. 删除旧 claim 必须有 source 删除/变更证据或 explicit retirement。
6. 全局重跑 link、index、coverage audit。
7. 最后提交新的 `source_revision`。

大规模结构重排或缺少可靠旧 revision 时直接 full regenerate，比错误的局部 patch 更安全。

## 推荐 OKF 目录

```text
wiki/
  index.md
  log.md
  overview.md
  architecture/
    index.md
  modules/
    index.md
  flows/
    index.md
  concepts/
    index.md
  guides/
    index.md
  requirements/
    index.md
  decisions/
    index.md
  references/
    index.md
  reports/
    index.md
    coverage.md
```

- `index.md`、`log.md` 使用 OKF 保留结构。
- `overview.md` 是普通 concept，带 `type: Overview`。
- 其它文档使用 `Architecture`、`Module`、`Flow`、`Concept`、`Guide`、`Requirement`、`Decision`、`Reference`、`Generation Report` 等类型。
- OKF 不固定 taxonomy，以上是 producer profile，不是修改规范。

Concept 示例：

```yaml
---
type: Concept
title: Session
description: Authenticated interaction state shared by the API and UI.
source_revision: git:abc123
status: canonical
evidence:
  - uri: repo://abc123/packages/core/src/session.ts#L20-L88
    sha256: ...
  - uri: repo://abc123/docs/auth.md#sessions
    sha256: ...
tags: [auth, state]
---
```

## 最小落地路线

### Phase 0：可验证 POC

交付一个 Skill package：

```text
okf-wiki/
  SKILL.md
  scripts/
    guard.py
  references/
    producer-profile.md
```

先支持：

- Git/目录 snapshot 与 file inventory
- Markdown H1/H2 和规范性语句 obligations
- manifest、README、entrypoint、route/config 的少量通用规则
- JSONL 或 SQLite ledger
- OKF serializer/index generator
- source span、hash、link、orphan、coverage checks
- staging + atomic publish

Agent harness 负责动态探索和结构化抽取。不要先内置模型 provider。

### Phase 1：质量闭环

- independent critic pass
- conflict/disputed claims
- benchmark fixtures 与 mutation tests
- incremental source → claim → page invalidation
- hardened Web fetch
- coverage report 写入 OKF `reports/coverage.md`

### Phase 2：证据驱动扩展

只有 benchmark/规模证明需要时再加：

- Tree-sitter 或语言专用 AST Adapter
- IWE/OpenKnowledge 外部 graph Adapter
- vector/semantic search
- parallel sub-agents
- unattended runner / background queue
- GraphRAG-like community summaries

## 明确跳过的内容

第一版不应建设：

- 自建向量数据库
- 固定全域 ontology
- 完整多语言 AST 平台
- provider/plugin factory
- 多 Agent 调度平台
- 管理 UI、账号、队列、计费
- Graph database

这些能力在问题被 benchmark 证明前不会提高可验证的 concept recall，只会扩大实现和运维面。

## 最终建议

基于现有 `refs`，最短且可靠的实现路径是：

```text
一个 codebase/requirements-to-OKF Skill
    ↓
薄确定性内核：snapshot + inventory + obligations + ledger + check/publish
    ↓
Agentic LLM：动态 read/search/follow/AST/test tracing
    ↓
claim/concept graph（先 JSONL/SQLite）
    ↓
确定性 OKF renderer + hard gates + atomic publish
```

代码层优先复用或改造 Apache-2.0 的 Google OKF reference agent 形状；OpenKnowledge 的 workflow 作为设计参考或外部 Adapter；IWE 作为规模化 Markdown graph QA 的可选增强。

这不是“让 LLM 更听话”，而是把概率模型放在它擅长的语义判断位置，把完整性、可追溯性和发布安全放回确定性软件系统。
