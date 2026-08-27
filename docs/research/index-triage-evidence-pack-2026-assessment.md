# Index / triage / evidence-pack 方案：2026 可行性与设计评估

日期：2026-08-28
范围：当前 `index -> triage -> survey -> connect -> plan -> write -> review`
实现，以及 `docs/research/index-triage-evidence-pack.md` 所述方案。
来源标准：只使用原始论文、产品团队的一手工程文章、官方文档和规范。

## 结论

方案的目标可行，但当前设计不是一个可以靠“补测试”收口的实现。

可保留的方向是：确定性索引、模型路由、按需读取、结构化交接、独立
review、确定性 gate。需要改的不是阶段名称，而是两个不变量：

1. **正确性粒度不能跟执行批次绑定。** Survey scope 和 Wiki page 应继续是
   可独立校验、摘要、复用、失效和重试的 Target；多个 Target 可以在同一个
   worker session 中执行，但 batch 不应成为持久化 Target。
2. **证据包应是 kernel 从 Pin 和 locator 派生的可再生缓存，不是 worker
   自报的证据。** 它能降低下游阅读成本，但不能取代 Pin、locator 或独立
   review。

因此，对完整方案的判断是 **有条件可行**：架构方向成立，当前 contract
切分不成立。最合理的 v1 是 `SourceIndex + TriageScope + derived evidence
cache`；不需要新增 batch artifact、目录 Target 或全局“源码只读一次”规则。

## 资料直接支持什么

以下条目中的“支持”只复述资料可直接证明的结论；对本仓库的设计推断放在
后续章节。

### 1. Repository context 应“小而高信号”，并渐进披露

- Anthropic 在 [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  （2025-09-29）把 context 定义为有限且边际收益递减的资源，建议找到满足
  目标的最小高信号 token 集；其 Claude Code 实例采用轻量路径/标识符、
  `glob`/`grep` 按需读取和文件层级元数据，而不是预先塞入完整语料。文章还
  明确认为混合策略合理：少量信息预载，细节由 agent 自主探索。
- Aider 的现行官方 [Repository map](https://aider.chat/docs/repomap.html)
  （持续更新；访问 2026-08-28）用文件、关键 symbol、类型和签名提供全仓概览，
  再按依赖图排名和 token budget 选择相关片段；需要细节时再请求具体文件。
- SWE-agent 原始论文 [SWE-agent: Agent-Computer Interfaces Enable Automated
  Software Engineering](https://arxiv.org/abs/2405.15793)（2024-05-06）表明，
  面向 agent 设计的 repository 导航、编辑和测试接口会显著影响 repo-level
  任务表现。
- Anthropic 官方 [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  （持续更新；访问 2026-08-28）要求缓存稳定且完全相同的 prompt prefix，
  并建议把稳定 instruction/context 放前、变化内容放后；这是一种降低重复
  输入延迟和成本的执行优化，不是 provenance 机制。
- OpenAI 的 [Harness engineering](https://openai.com/index/harness-engineering/)
  （2026-02-11）报告了一个约百万行、1,500 个 PR 的 agent-first 项目：大目标
  被拆成 design/code/review/test 等小单元；短 `AGENTS.md` 只充当目录，版本化
  `docs/` 才是 system of record，结构、交叉链接和 freshness 由 lint/CI 验证。

**资料未支持：**“survey 后任何下游都不应再读源码”或“源码在 run 内只读
一次”。相反，按需检索、渐进披露和保留外部可恢复上下文都允许必要的重读。

### 2. 多代理只适合可真正独立的工作

- Anthropic 的 [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  （2025-06-13）显示多代理适合 breadth-first、方向彼此独立的检索；它在内部
  research eval 上提升明显，但使用约为普通 chat 的 15 倍 token。文章同时
  明确指出，多数 coding task 的真实并行度低，需要共享上下文或存在大量依赖的
  任务并不适合多代理。
- Cognition 的 [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
  （2025-06-12）给出生产经验：动作携带隐含决策；不能共享相关 trace 和决策的
  并行 worker 容易产生不一致。其建议的 subagent 用法主要是边界明确的调查和
  压缩，而不是相互依赖的并行写入。
- Anthropic 的 [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
  （2026-02-05）给出了更细的边界：大量独立 failing tests 可以自然并行；当
  所有 agent 卡在同一个 Linux build failure 时，16 个 agent 反而互相覆盖，
  必须先把问题变成可独立验证的子问题。该实验还依赖 task lock、独立 clone、
  Git 合并和高质量测试。
- OpenAI 的 [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
  （2026-02-02）把并行 coding agent 放进独立 thread 和独立 Git worktree，
  由用户审阅每个 diff；它支持的是隔离后的任务并行，不是多个 agent 共享一个
  未分区 artifact。
- Anthropic 现行 [Message Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
  （持续更新；访问 2026-08-28）是一个很直接的运行时类比：batch 内每个 request
  有独立 `custom_id`、被独立处理、结果可乱序返回，单个 request 失败不影响其他
  request；共享 prompt prefix 仍可使用 prompt caching。即使平台提供批处理，
  结果和失败粒度也没有合并。

**资料未支持：**“把多个 scope/page 合成一个 kernel Target 就能获得并行或
缓存收益”。这些收益来自 session、context prefix、sandbox/worktree 和任务
调度，而不是改变业务产物的正确性粒度。

### 3. 长时任务依赖稳定交接、可恢复状态和独立接口

- Anthropic 的 [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  （2025-11-26）使用增量任务、Git 历史和结构化 progress artifact，让新
  context 能快速恢复；文章也明确说 compaction 本身不够。
- Anthropic 的 [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
  （2026-04-08）将 session（append-only event log）、harness 和 sandbox
  分离，使它们可独立失败和替换；同时警告 harness 中针对旧模型能力的假设会
  很快过时。
- Anthropic 的 [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  （2026-03-24）采用 planner / generator / evaluator 分工、每次只实现一个
  feature、在执行前约定可测试的 sprint contract。其后又逐项做消融实验，
  删除随新模型变成负担的 harness 组件，而不是一次性堆叠机制。
- Microsoft 的 [CodePlan](https://arxiv.org/abs/2309.12499)
  （预印本 2023-09-21；FSE 2024）说明 repo-level 工作涉及跨文件依赖，采用
  增量计划、repository context、前序变更和验证比无计划 baseline 更可靠。
- [Agentless](https://arxiv.org/abs/2407.01489)（2024-07-01）则提供重要的
  反证基线：在 SWE-bench Lite 上，简单的 localization -> repair -> patch
  validation 曾超过复杂开源 agent。结论不是“永远不要 agent”，而是每个新增
  harness 组件都必须由 eval 证明价值。

### 4. 2026 年直接相关的 repo-Wiki 实证支持分层分解，但不支持“只读一次”

- ACL Findings 2026 原始论文 [CodeWiki](https://aclanthology.org/2026.findings-acl.288/)
  （2026-07）在 7 个、86K--1.4M LOC、覆盖 7 种语言的仓库上评测 repo-level
  文档生成。它先用 AST/依赖图/入口点做 top-down 模块分解，leaf agent 仍拥有
  完整源码访问和依赖图遍历能力，再 bottom-up 合成父模块。这直接支持“有界地图
  + 分层语义工作 + 向上合成”，却反证“索引/证据包必须禁止后续读取源码”。
- CodeWiki 的平均质量为 68.79%，比闭源 DeepWiki baseline 高 4.73 个百分点；
  但 C 与 C++ 分别低 4.51 和 1.80 个百分点。其主要评测依赖多模型 LLM judge，
  human pilot 只有 3 人、3 个仓库、9 次偏好判断。论文作者也明确把系统语言解析
  和更广泛人工验证列为限制。因此不能从这一个实验推出统一 tier 阈值、统一索引
  信号或“任意语言都收益”。

### 5. Gate 应验证 outcome；模型产物需要独立复核

- Anthropic 的 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
  （2024-12-19）把 prompt chaining、routing 和 parallelization 视为简单可组合
  workflow；固定步骤可在中间加入 programmatic gate，parallel sectioning 的
  前提是子任务独立。
- Anthropic 的 [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  （2026-01-09）建议 agent eval 组合 code-based、model-based 和 human grader；
  coding agent 优先使用稳定环境、明确定义的任务和 deterministic tests，并把
  capability suite 与接近 100% 的 regression suite 分开。早期 20--50 个真实
  failure 就能形成有用基线。
- Anthropic 的 2026 harness 实验还发现 producer 自评会偏宽松，把 evaluator
  与 generator 分开更易校准；但 evaluator 仍需 rubric、few-shot 和人工抽查。
- Anthropic 的 [Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise)
  （2026-02-05）实测 CPU/RAM 配置可让 Terminal-Bench 2.0 分数相差 6 个百分点；
  因此模型、prompt、时间、并发、资源和执行环境都必须记录并控制，微小分差不能
  被当成方案胜负。

### 6. Provenance 必须绑定不可变 revision 和 artifact digest

- SLSA 1.2 的现行 approved [Source requirements](https://slsa.dev/spec/v1.2/source-requirements)
  （访问 2026-08-28）把 Source Revision 定义为逻辑不可变、唯一标识的 tracked
  files snapshot，并要求 provenance subject 的 digest 包含 revision id。
- SLSA 1.2 [Provenance](https://slsa.dev/spec/v1.2/provenance) 和
  [attestation model](https://slsa.dev/spec/v1.2/attestation-model)（访问
  2026-08-28）把 artifact 视为通常由 cryptographic content hash 标识的不可变
  blob；provenance 描述 artifact 从哪里、何时、如何产生。该规范不是 Wiki
  contract，但它提供了适用的可追溯设计原则。
- GitHub 的 [Copilot Memory](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/)
  （2026-03-04）提供了更贴近 agent cache 的一手模式：memory 限定在单 repo，
  应用前重新对当前代码库验证，并在 28 天后过期；owner 可查看和删除。它支持
  “跨 agent 复用仓库事实”，同时要求事实仍可对当前源码复验。

## 对当前实现的可行性判断

| 部分 | 判断 | 当前主要问题 | 合理边界 |
|---|---|---|---|
| Index | 可行 | 只聚合直接父目录；无 artifact size/schema budget；churn parser 会在 author 与文件名间空行处清空 author（`_index.py#L193-L220`） | 每 Source 的有界、版本化、确定性 hint；信号不能生成语义结论 |
| Triage | 可行 | 单个 `triage:workspace` 让任一 Source 变化使整体失效；模型可扩大 `exclude`；gate 未执行 documented forced split（`_models.py#L81-L98`, `_validate.py#L406-L450`） | 每 Source 一个可复用 Target；exclude 只来自 workspace policy；exact coverage / overlap / split 由 gate 验证 |
| Tiered survey | 可行 | `inventory_finding()` 从压缩/文件名结构信号断言“no decision-relevant behaviour”，且 locator 是目录（`_index.py#L304-L323`） | `inventory` 只进入 coverage ledger，不是 Finding；standard/deep 仍一 scope 一 Target |
| Survey batch | 作为 Target 不可行；作为 dispatch 可行 | batch Target 的 canonical artifact 是 `batch-N.json`，worker contract 实际写多个 scope JSON（`_state.py#L336-L370`, `survey.md#L24-L26`） | coordinator 一次 dispatch 多个独立 Target；逐 Target complete，失败不回滚已完成 sibling |
| Evidence pack | 有条件可行 | worker 被要求写 pack；validator 比较记录的 digest 与 Pin，却未比较 pack body 自身的 digest；reuse 只复制主 artifact（`_validate.py#L464-L497`, `_state.py#L918-L959`） | survey gate 通过 locator 后由 CLI 生成；content-addressed、可删除、可重建；不参与事实身份 |
| Connect | 可行 | “证据包优先”可作为 heuristic，不能成为禁止重读 Pin 的规则 | 读取所需 finding packs；窗口不足时按需读 Pin；输出仍独立 gate |
| Plan shards / compose | 可行 | 现有 deterministic fan-in 与全局 coverage 是方案中最稳的部分 | 保留 source/workspace shard 和 Compose Gate，不新增 compose agent |
| Write batch | 作为 Target 不可行；作为 session 可行 | 多页共享 `drafts/write/*.json` artifact，但 worker 只写 `candidate/<path>`；页面 reuse、review reopen 和失效粒度被放大（`_state.py#L794-L842`, `write.md#L40-L43`） | 一页面一 Target；可按 owner/evidence affinity 在同一 session 顺序完成多页 |
| Review | 可行且必要 | 不能信任 producer pack 或 producer 自评 | reviewer 使用独立 session，从 Pin 重开 decision-changing locator；机器 gate 先行，LLM review 补语义 |

## 合理的完整设计

```text
immutable Pin / Catalog
        |
        +--> SourceIndex (CLI, versioned, bounded hints)
        |          |
        |      Triage Target per Source
        |          |
        |      exact coverage gate
        |          |
        |      Survey Target per semantic scope
        |          |-- inventory --> Coverage Ledger only
        |          `-- standard/deep --> Survey JSON --> locator gate
        |                                          |
        |                                  derived Evidence Cache
        |                                          |
        +------------------------------> Connect Targets
                                                   |
                                      Plan shards -> Compose Gate
                                                   |
                                      Write Target per page
                                                   |
                                      independent Review batches
                                                   |
                                             atomic Publish

ephemeral side path:
Dispatch planner -> group independent Targets into one worker session
```

### 持久化 contract

- **Target：**一个稳定 id、一个 canonical artifact、一个输入摘要、一个 artifact
  摘要、独立 retry/reuse/invalidate 状态。scope 和 page 是正确性粒度。
- **SourceIndex：**只含结构事实和 routing hint。建议 v1 保留 file/line/byte count、
  extension、test adjacency、manifest/entry path；gzip、name homogeneity、churn
  只有在 eval 证明路由增益后才保留。Index 必须有 schema version 和最大字节数。
- **TriageScope：**模型决定 `deep | standard | inventory`、orientation 和 themes；
  kernel 生成稳定 scope id，并验证配置排除后的 exact cover。模型不能声明 exclude。
- **Coverage Ledger：**记录 inventory scope、文件数和 triage 理由，仅用于覆盖审计；
  不冒充 semantic Finding，也不进入 Wiki finding coverage。
- **Evidence Cache：**key 至少包含 revision/content digest、locator、window policy
  version；value 是 CLI 从 Pin 提取的正文。缓存缺失/损坏时重建，不应导致 survey
  语义 artifact 失去身份。

### 执行策略，不进入 contract

- 同一 worker session 可顺序消费 2--5 个同 reference、同 Source/tier 的 Survey
  Target，或 2--4 个同 owner/evidence affinity 的 Write Target。
- worker 每完成一个 artifact 就单独调用 gate；session 中途失败时只重试未完成
  Target。
- prompt cache 用于稳定的 reference、tool schema 和共享输入前缀；不要为了 cache
  hit 把多个产物改成一个 artifact。
- 真正并行只用于无共享写集或已隔离 workspace 的工作。Connect/read-only survey
  可以较宽并行；对共享 Candidate 的 write 默认顺序执行。
- 模型/effort tier 是 runtime policy。它会随模型变化，应由 eval 驱动，不写入
  artifact schema 或 Target identity。

### Evidence cache 的最小实现

不需要自定义 evidence service。一个 kernel 函数就够：

```text
materialize(pin_digest, locator, window_policy_version) -> cached excerpt
```

Survey worker 只写 claim 和 locator；gate 先解析、resolve 并验证 locator，再由
kernel 读取 Pin、生成 excerpt 与 digest。Connect/write packet 只列出本 Target
需要的 cache 路径。Review 绕过 cache，直接读取 Pin。正文格式优先用已有 JSON
能力，避免维护容易歧义的自定义 txt parser。

## Evidence -> proposal 映射

| 第一手证据 | 对本方案的直接含义 | 设计决定 | 证据强度 |
|---|---|---|---|
| Anthropic context engineering；Aider repo map | 有界概览 + JIT 细读比全量预载更合适 | 保留 SourceIndex；允许 downstream 按需重读 Pin | 强；直接支持模式，不证明本项目收益幅度 |
| Anthropic prompt caching | 稳定共享 prefix 可降低重复成本 | 在 dispatch/runtime 做 prefix cache，不造 batch artifact | 强；只支持执行优化 |
| Anthropic Message Batches | batch 内 request 独立 id、结果、错误和重试，可共享 prompt cache | 执行合批不改变 Target/artifact 粒度 | 强；官方接口直接体现该分离 |
| Anthropic multi-agent research；Cognition | 独立探索可并行，强依赖写任务会丢上下文/冲突 | Survey 调查可分发；write 不做跨页面并行共享写入 | 中强；场景相近但非本项目实验 |
| Anthropic parallel compiler；OpenAI Codex worktrees | 并行需要独立问题、锁/隔离和 verifier | batch 是调度分组；Target 保持可独立验收 | 强；“批次≠正确性单位”是据此作出的工程推断 |
| Long-running harness；Managed Agents | 结构化交接、durable state、独立失败边界提高恢复性 | 一 Target 一 artifact；session 与 artifact 解耦 | 强；接口形态是项目内推断 |
| Generator/evaluator harness；agent eval guide | producer 自评不足；deterministic outcome + 独立语义 grader 互补 | 保留 State/Compose gates 与独立 review | 强 |
| SLSA 1.2 provenance | revision 与 artifact 应以 digest 不可变绑定 | Pin、locator、artifact digest 是事实链；cache 可再生 | 中；规范领域不同，原则可迁移 |
| GitHub Copilot Memory | repo memory 可跨 agent 复用，但需引用当前源码、复验和过期 | evidence pack 是可失效、可删除的派生 cache | 中强；产品模式直接相关 |
| ACL 2026 CodeWiki | 依赖图分解、leaf 源码探索和 bottom-up 合成可扩展到大仓库 | 保留 hierarchical index/triage/compose；不禁止源码重读 | 中；直接任务证据，但仅 7 repos 且语言差异大 |
| Agentless；2026 harness 消融 | 复杂 scaffold 未必优于简单 pipeline，模型升级会让旧机制失效 | 新机制逐项上线、逐项 A/B，不一次迁移全部 contract | 强；直接支持 eval-first 简化 |

## 如何证明方案在本项目可行

在没有数据前，以下都只能算优化假设：inventory 能减少低产 worker、triage 能提高
finding yield、evidence cache 能减少 token、session batching 能减少固定成本。建议
用同一组固定 Pin 做最小对照，而不是继续扩大实现：

1. 先让现有 deterministic lifecycle/e2e 全绿，作为 regression suite。
2. 选 20--50 个真实 Source，覆盖小仓库、超大 monorepo、generated-heavy、
   multi-source 和 refresh；每种配置至少多次 trial，记录模型、prompt、CPU/RAM、
   timeout 和并发。C/C++ 等系统语言单独分层统计，不能用跨语言平均数掩盖回归。
3. 逐项比较 baseline 与单一改动：先 Index+Triage，再 derived cache，最后 session
   batching；不要一次打开三个变量。
4. 质量指标：review precision/recall 抽样、unsupported claim、locator validity、
   finding/page coverage、publish 成功率、refresh 后不必要重算数。
   LLM-judge 分数必须定期由领域专家校准；CodeWiki 的小规模 human pilot 只能当
   先例，不能当本项目 ground truth。
5. 成本指标：input/output/cache-read tokens、Pin file opens/bytes、worker sessions、
   retries、wall time、峰值 context。只报告“读源码一次”没有意义。
6. 通过门槛应预先写死，例如：质量不得下降；总 token 或 p50 wall time 至少改善
   一个足以覆盖新增复杂度的幅度；否则删掉该机制。

## 推荐实施顺序

1. 恢复 Target 的单 artifact 不变量，把 survey/write batching 降为 dispatch
   grouping；这不是回退功能，而是把正确性与性能放回各自层。
2. 修 Index 的确定性信号并加 schema/size budget；Triage 改成 per-Source、删除
   模型 `exclude`，补 exact cover/overlap/forced-split/no-content gate。
3. 把 inventory finding 改成 Coverage Ledger。
4. 让 kernel 在 survey locator gate 后生成 evidence cache；删除 worker 写 pack 的
   contract 和自定义 pack parser。
5. 只在上述 correctness suite 全绿后做成本 eval；有数据再决定 batch 大小、
   tier/model 和 window 大小。

最终原则：**Pin/Target/gate 决定真实性和恢复边界；Index/cache/batching 只优化
agent 如何到达结果。优化层可以随 2026 之后的模型变化被删除，而不应要求再改
一次 artifact contract。**
