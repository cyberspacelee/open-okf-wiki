# Wiki 生成 Artifact 与工作流最佳实践

日期：2026-09-04
范围：针对 repo-wiki 的 Plan、数据库证据、Domain 页面、验证、agent context、writer dispatch 与跨平台 CLI。
资料边界：只采用官方规范、官方项目文档和原始研究。

> 外部资料不会规定 repo-wiki 的 Artifact 名称、locator 语法或阶段划分。本文先陈述来源
> 支持的通用原则，再给出项目内推论；`source/table`、`plan-ledger.json` 和
> `okf page prepare` 都是 repo-wiki 设计选择，不是外部标准原文。

## 结论

当前基线方向正确：**可读 Plan 与机器账本分离；数据库 locator 使用稳定逻辑名，运行环境
坐标只留在 Source/Run 绑定中；Domain 是厚概览和导航入口，但不复制详细页事实；unit 继续
exact-once ownership；日常工作看阶段状态，全量 `validate` 保留为审计；每个 writer 只接收
一个由 kernel 派生的页面 packet。**

下一步值得做的是把仍由 agent 手工展开的账本改为“typed semantic intent -> deterministic
compiled ledger”，并补 composition requirements packet、page-scoped evidence registry 和 compact
Catalog projection。前三者是契约改进；任何持久 evidence cache 只是有指标支持后再做的性能优化。

推荐数据流：

```text
frozen Source/Catalog
  -> planner
       |- plan.md          (agent 写全局模型、生命周期、结论、反证、缺口)
       `- semantic intent  (agent 明确表达领域判断、关系、例外和缺口)
            -> plan-ledger.json (kernel 编译 coverage、scope、seed、反向索引)
  -> composition.md   (unit exact-once -> page/path)
  -> page packet      (单页所需的最小高信号上下文)
  -> one writer / one page
  -> phase status -> full validation -> review -> publication
```

### Anthropic、OpenAI、MCP/QMP 对照

| 来源 | 官方主张 | 对 repo-wiki 的直接含义 |
|---|---|---|
| [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context 是有限资源；使用最小高信号集合、轻量标识和按需检索 | writer 接收页面 packet，再按 locator 读取证据，不预装完整 Plan/Reference Map |
| [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | cache 复用完全相同的 prompt prefix，默认 TTL 5 分钟，也可配置 1 小时 | 只用于降低重复静态前缀的延迟和成本，不能替代 bounded packet、证据绑定或持久 registry |
| [Anthropic effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 从简单、可组合工作流开始；只有任务可独立拆分时才并行 | 保留确定性阶段编排；一页一 writer，避免多页大任务和通用 scheduler |
| [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) | 删除重复指令和无关工具；为 bounded stage 明确目标、工具、输出 schema、证据、停止和失败条件，并以代表性任务评测 | 账本投影、coverage、dedupe 和 packet 生成放在 kernel；LLM 负责证据综合与写作 |
| [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | JSON Schema 可约束输出形状，但官方明确说明结构化输出仍可能出错 | typed intent 仍需 semantic compiler/validator；schema-valid 不等于事实或跨引用正确 |
| [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | 每阶段做 scoped tests，使用真实分布数据，自动化可机械评分部分并持续评估 | 分别评测 intent extraction、ledger compilation、packet 质量和最终页面，不只评最终 Markdown |
| [OpenAI agent harness](https://developers.openai.com/blog/codex-as-a-platform) | harness 管理 context、tools、边界、进度、失败与跨 turn 状态，application 选择与当前 workflow 相关的数据和动作 | kernel 负责确定性约束与 packet，宿主 agent 负责语义工作和编排 |
| [MCP architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture) | host 负责编排和 context aggregation，server 暴露聚焦能力并只接收必要上下文 | 页面 packet 可未来暴露为 resource/tool，但本地 CLI 已能满足时不增加 MCP server |
| [QEMU QMP](https://www.qemu.org/docs/master/interop/qmp-spec.html) | QMP 是控制 QEMU 的 JSON machine protocol | 与 Wiki/agent context 无关；若“QMP”不是笔误，需要提供全称再评估 |

### 当前实现基线

截至提交 `6d896fa`，上一轮建议中的 Plan narrative/ledger 拆分、plain Catalog locator、Domain
非 owning projection、阶段字段与 `skipped_checks`、`okf page prepare <page-id> --json` 均已实现。
因此下文第 1-5 节保留为设计依据，不再表示未完成工作；新增工作集中在第 7 节。

## 1. 机器账本与可读 Plan 分离

### 一手资料

- [GitHub Docs 的 YAML frontmatter 规范](https://docs.github.com/en/contributing/writing-for-github-docs/using-yaml-frontmatter)
  将 frontmatter 用于版本、元数据和布局控制，并用 schema/test 校验；Markdown 正文承载文章。
- [Jekyll front matter](https://jekyllrb.com/docs/front-matter/) 将其定义为页面变量，并明确建议
  用 defaults 消除反复出现的 frontmatter 值。
- [GitHub Docs 的 single-source versioning](https://docs.github.com/en/contributing/writing-for-github-docs/versioning-documentation)
  明确用单一内容源避免重复；[GitLab 文档结构规范](https://docs.gitlab.com/development/documentation/site_architecture/folder_structure/#avoid-duplication-when-possible)
  同样要求链接到 single source of truth，而不是在多个位置复制同一事实。
- [arc42 crosscutting concepts](https://docs.arc42.org/section-8/) 建议把影响多个 building block
  的共同概念集中说明，避免在每个 block 重复。

这些来源没有规定 frontmatter 的大小比例，但共同限定了它的职责：机器元数据、呈现控制和
少量分类。把 95.9% 的文件用于 coverage ledger 和 evidence warehouse，是偏离常见
docs-as-code 分工的强信号，而不是单纯的排版问题。

### 对 repo-wiki 的调整

把当前一个 `plan.md` 的两个职责拆开：

```text
work/plan-ledger.json  # schema-validated canonical machine artifact
work/plan.md           # readable synthesis; only small identity/digest metadata
```

`plan-ledger.json` 保存 Domain、Concept、table group、relationship、unit、scope、seed 和 gap；
`plan.md` 正文必须解释全局模型、主要生命周期、跨源关系、证据支持的结论、被拒绝的假设和
未解决缺口。正文通过稳定 ID 和少量承重 locator 指向账本，不复制 seed 清单。

这比继续压缩 YAML 字段更直接：空列表可以由 schema defaults 表达；Catalog 表存在性和
Concept-to-table 关系继续由 kernel 派生；同一 seed 不再为了不同视图重复三次。review digest
同时绑定 ledger 和 narrative，防止二者漂移。

原问题中的契约一边要求“small frontmatter、body holds analysis”，一边让 Plan frontmatter 承担
完整 coverage ledger，存在结构性张力。当前
[`references/plan.md`](../../skills/repo-wiki/references/plan.md) 已通过 `plan.md` +
`plan-ledger.json` 消除这项冲突。

## 2. 数据库证据使用逻辑身份，不使用连接坐标

### 一手资料

- [OpenTelemetry SQL database conventions](https://opentelemetry.io/docs/specs/semconv/db/sql/)
  把 `db.namespace`、`db.collection.name` 与 `server.address`、`server.port` 分为不同属性。
  数据对象、数据库命名空间和网络连接端点不是同一概念。
- [OpenLineage Dataset Namespace Resolver](https://openlineage.io/docs/client/java/configuration/#dataset-namespace-resolver)
  明确指出同一 dataset 可能通过不同 host 访问，JDBC 物理地址也会变化，因此允许把 host
  解析为组织内逻辑标识。
- [The Twelve-Factor App: Config](https://12factor.net/config) 把数据库 resource handle、凭据和
  deploy hostname 都定义为随部署变化的配置；[Backing services](https://12factor.net/backing-services)
  要求替换数据库实例只改变配置，不改变代码。

### 对 repo-wiki 的调整

外部资料支持“对象身份与运行端点分离”，但不强制 repo-wiki 使用哪种字符串语法。结合本项目
已注册 Source、冻结 Catalog 和 Run binding，最小稳定 locator 是：

```text
<source>/<table>
# 若一个 Source 真正捕获多个 schema，才扩为 <source>/<schema>/<table>
```

`url_env`、host、port、database 和连接用 schema 留在 Workspace/Run 的 Source 配置与冻结
Catalog provenance 中；Artifact 只保存逻辑 locator。Run state 用 Source identity、Catalog
digest/capture revision 将 locator 绑定到一次确定性快照。更换 SIT/UAT 地址不会改写 Wiki。

因此当前 contract 的 plain locator 规则是合理的；需要修的是 Capture、Catalog、validation、
reference rendering、publication binding、grader 和测试仍可能生成或接受 `opengauss://...` 的
实现漂移。不能只给 validator 增加别名，否则环境坐标仍会从其他输出路径泄漏。

## 3. Domain 采用“厚概览 + 按需下钻”，但不双重拥有事实

### 一手资料

- [C4 diagrams](https://c4model.com/diagrams) 用 context、container、component、code 形成层级
  zoom，并明确只创建有价值的层级；[system context](https://c4model.com/diagrams/system-context)
  是所有读者的大图入口，低层实现细节不应混入。
- [arc42 building block view](https://docs.arc42.org/section-5/) 要求始终提供 level-1 overview，
  再只对重要、复杂、风险高或易变的 block 下钻；overview 可以用短表格说明成员与接口。
- [arc42 runtime view](https://docs.arc42.org/section-6/) 只选择架构相关的代表性场景，不要求
  穷举所有运行路径。
- [Diataxis](https://diataxis.fr/) 按读者目的分离 explanation、reference、how-to 和 tutorial。
  这支持把领域理解入口与表字段参考、具体操作步骤分开。

### 对 repo-wiki 的调整

Domain 模板增加以下概览，而不是把详细页原文内嵌回来：

```markdown
## 职责与公开边界
## 不变量与规则
## 数据模型概览
## 状态与生命周期
## 关键流程
## 领域概念
## 变更入口
```

每个新增概览只保留关键关系图/结论、风险或缺口，以及到 Concept、DataModel、Lifecycle、Flow、
Table 页的链接。字段清单、完整状态边、完整算法和完整 evidence seed 仍只有一个 owner。

**不要把该 Domain 的所有 units 再绑定到 Domain 页。** Composition 的 exact-once unit mapping
应保留。Domain 页仍拥有 capability owner unit；kernel 从 Plan + Composition + Reference Map
派生 `related_pages`、model summary 和生命周期/流程入口，作为非 owning projection 提供给 writer。
这样既得到厚入口，也不制造两个事实源。

## 4. 验证分阶段呈现，共享一套规则

### 一手资料

- [Terraform `validate`](https://developer.hashicorp.com/terraform/cli/commands/validate) 只检查离线
  syntax 和内部一致性；依赖 workspace、变量和远端状态的判断交给 `plan`。它的 JSON 输出包含
  `format_version`、error/warning counts、severity、summary 和 source range。
- [Terraform validation lifecycle](https://developer.hashicorp.com/terraform/language/validate)
  要求在信息可用的最早阶段执行相应检查，并区分阻断失败和非阻断 check/warning。
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
  为诊断提供稳定 `ruleId`、`kind`、`level`、message 和 location；`notApplicable` 明确表示规则
  因不适用于当前 target 而未执行。

### 对 repo-wiki 的调整

无需再造第二套 validator。保留：

- `okf run status --json`：阶段视图，只返回当前可行动 blocker 和 next actions；
- `okf validate --json`：全 Candidate 审计，允许列出未来阶段缺失，但必须明确其 applicability。

共享 issue record 使用稳定 `code`、`severity`、`phase`、`artifact/location` 和 `message`；
`next_actions` 可以继续由 status 在顶层按阶段统一给出。未来页面尚未写时，在阶段视图中省略或
标为 `pending/notApplicable`，不能计入当前 `blocking_errors`；真正违反当前阶段前置条件的项才是
blocking error。

当前实现已经聚合、去重并稳定排序 issues，输出 `severity/code/path/line/phase/message`、计数和
`skipped_checks`；status 也只报告当前阶段 blocker。剩余增量见第 7.2 节。只有实际使用仍需要
任意阶段审计时，才增加 `validate --phase`。

## 5. Writer 必须接收页面级 task packet

### 一手资料

- [OpenAI Harness engineering](https://openai.com/index/harness-engineering/) 的直接经验是给 agent
  “map，而不是千页手册”：短入口指向版本化、可验证的 repository system of record，以
  progressive disclosure 避免大块说明挤占任务上下文。
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) 建议删除重复指令、
  示例和无关工具；对过滤、连接、排序、去重、聚合、验证等有界处理使用程序化 tool calling，
  并在代表性任务上同时衡量质量、证据、token、延迟与成本。
- [OpenAI 为 Responses API 配备计算环境](https://openai.com/index/equip-responses-api-computer-environment/)
  把“不要把大表粘进 prompt”“中间文件落在哪里”和 timeout/retry 列为 agent harness 的实际问题，
  支持让大 Artifact 留在文件系统、按需读取。
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  把 context 视为有限资源，建议使用能完成任务的最小高信号 token 集，并按需检索，而非预装
  全部可能相关信息。
- 原始研究 [Lost in the Middle](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Language-Models-Use-Long)
  发现长上下文中关键信息的位置会显著影响模型使用效果，相关信息位于中部时性能常下降。
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  要求 subagent 获得明确 objective、output format、tools/sources 和 task boundaries，并让结果
  直接落盘、handoff 只返回轻量引用。

### 对 repo-wiki 的调整

“一 writer 一页”加页面级投影是正确修复。当前已提供这个较深的只读 CLI 接口：

```text
okf page prepare <page-id> --json
```

kernel 从已批准 Artifact 派生并落盘 `work/page-packets/<page-id>.json`，包含 page spec、owned
units、相关 Domain/Concept/model/relationship 投影、允许的 scopes/seeds、该页使用到的 Reference
Map entries、模板与输出路径。writer 再通过现有 `evidence search/read` 按需打开 frozen evidence。
第 7.4 节讨论在不增加新事实源的前提下，如何继续缩小重复读证据的成本。

packet 必须 digest-bind 到 Plan ledger、Plan narrative 和 Composition；它是投影，不是新事实源。
handoff 继续只返回 draft path、citation count 和 gap count。不要增加通用 scheduler、共享 writer
memory 或多页 writer。

OpenAI 与 Anthropic 的官方实践在这里一致：入口应短、Source of Truth 应持久且可检索、当前任务
只装载相关上下文。它们没有规定“一页一个 writer”或上述 packet schema；这是结合本项目 page
ownership、超时数据和确定性 kernel 作出的推论。

两家也没有给出通用的“每个 writer 几页”或固定 timeout。Anthropic 文中的并发 agent 数与工具
调用量是其 Research 产品经验，不能直接成为 repo-wiki 默认值；这里应以 page completion、引用
覆盖、packet bytes、tool calls、wall time 和 cancellation rate 的代表性 eval 来定任务大小。

### “QMP” 检索结论

对 `"QMP" LLM agent context engineering`、`"QMP" documentation generation AI agent` 等精确
组合检索，未找到与 Wiki 生成、agent context packet 或文档工作流相符的权威方法/产品。检索到的
同名项包括原始研究 [Q-switch Mixture of Policies](https://arxiv.org/abs/2302.00671)（多任务强化
学习）以及 [QEMU Machine Protocol](https://www.qemu.org/docs/master/interop/qmp-spec.html)，均与
本问题无关。因此本文不把 QMP 纳入设计依据；需要其全称或官方链接后才能可靠比较。

如果这里想表达的是 **MCP（Model Context Protocol）**，其官方
[architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture) 要求 host 负责
编排与权限、server 提供聚焦能力，server 只接收必要上下文且不能读取整个 conversation；
[resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) 与
[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) 则把 application-controlled
context 与 model-controlled actions 分开，并分别提供稳定身份、schema、分页和 cache metadata。
[MCP design principles](https://modelcontextprotocol.io/community/design-principles) 还强调先用现有
primitive 组合、保持协议面小，并只标准化已经由实践证明的模式。这些原则支持页面级资源和有界
工具接口，但**不构成现在新增 MCP server 的理由**：先实现同一语义的本地 `okf page prepare`；
只有宿主确实需要跨进程发现、权限隔离或多客户端互操作时，再把它暴露为 MCP resource/tool。

## 6. JSON CLI 与 PowerShell

### 一手资料

- [PowerShell output streams](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_output_streams)
  说明 native stdout 进入 Success stream，stderr 进入 Error stream。
- [PowerShell native argument parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)
  说明表达式模式与参数模式不同，且 PowerShell 7.3 改变过 native argument passing。
- [PowerShell character encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding)
  说明 PowerShell 6+ 默认 UTF-8 no BOM，而 Windows PowerShell 5.1 的默认编码并不一致。
- [`ConvertFrom-Json`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json)
  是 PowerShell 原生 JSON 解析入口。

### 对 repo-wiki 的调整

所有 `--json` 命令应保证 stdout 只有一个 UTF-8、无 BOM、无 ANSI color 的 JSON document；
日志、warning 和进度只写 stderr。SOP 直接给 PowerShell 原生示例：

```powershell
$result = okf validate --json | ConvertFrom-Json
```

避免在文档中使用嵌套 JSON/f-string 的 `python -c`；复杂输入走文件或 stdin。CI 至少增加一条
`pwsh 7` 的 JSON pipeline smoke test。若项目声明支持 Windows PowerShell 5.1，才承担额外编码和
参数传递测试成本。

`catalog describe` 若由 `json.dumps` 统一序列化，数据库控制字符本应被转义；在没有保存失败
stdout/stderr 原始 bytes 前，不能把 `strict=False` 当修复。先验证 stdout 是否混入日志、BOM、
ANSI 或宿主启动器输出。

## 7. 新一轮设计假设评估

| 设计 | 支持度 | 结论 |
|---|---|---|
| semantic intent -> deterministic compiled ledger | 中等，带边界 | 编译确定性派生项；领域判断和例外仍须显式 authored |
| aggregated diagnostics | 强 | 聚合独立错误，同时抑制前置失败引发的级联噪声 |
| composition requirements packet | 强 | 提供全局但紧凑的 composition 输入；不要把全局闭包拆给独立 composer |
| page evidence registry + bounded excerpts | 强 | 放进现有 page packet，绑定 Run revision/digest |
| 持久 evidence cache | 弱到中 | 只在指标证明重复 I/O 是瓶颈后增加，且必须可丢弃 |
| compact Catalog views | 强 | 保持 list/discovery 与 describe/detail 两级，按需补 filter/cursor |

### 7.1 Semantic intent 编译为 deterministic ledger

**来源事实。** Anthropic 明确区分 agent 的非确定性与工具的确定性，并要求工具用严格数据模型
约束输入输出（[Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)）。
OpenAI Structured Outputs 保证 JSON Schema 形状，但官方同时指出输出仍可能包含错误，输入与
schema 不相容时还可能产生幻觉（[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)）。
OpenAI 还建议为每个生成步骤做 scoped eval，而不是用最终结果掩盖中间失败
（[evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)）。

**repo-wiki 推论。** 支持把当前手工 `plan-ledger.json` 的输入收窄为一个 typed semantic intent，
再由 kernel 原子编译、排序并写出 ledger；但只编译同输入必然得到同结果的内容：effective
data-model units、table-group 展开、scope/seed union、去重、coverage、反向索引和 digest。
Domain/Concept 边界、relationship 含义、owner unit、table role、被拒绝假设与 Gap 都不是可可靠
推断的机械事实，必须留在 authored intent/narrative。

最小契约应是：semantic intent 是唯一可编辑机器输入，compiled ledger 明确标记 generated 且不可
手修；编译失败不覆盖上一份有效输出，diagnostic 指回 intent 的 JSON Pointer。不要让 intent 与
ledger 同时成为可编辑 SSOT，也不要把 Structured Outputs 当 semantic validation。

### 7.2 聚合诊断，但在依赖边界停止

**来源事实。** Pydantic 的 `ValidationError` 包含全部已发现错误，`errors()` 返回含 machine-readable
`type`、嵌套 `loc`、`msg`、`input` 和文档 URL 的列表
（[Pydantic error handling](https://pydantic.dev/docs/validation/latest/errors/errors/)）。Terraform
Diagnostics 明确采用 append-only slice，让用户一次看到全部相关问题并更快修复，同时建议在已有
error 后停止可能造成混乱或 crash 的后续执行
（[Terraform provider diagnostics](https://developer.hashicorp.com/terraform/plugin/framework/diagnostics)）。
`terraform validate -json` 还提供版本、计数、severity、summary/detail、range 和 source snippet
（[Terraform validate](https://developer.hashicorp.com/terraform/cli/commands/validate)）。SARIF 使用稳定、
opaque `ruleId` 以及 level/message/location 表达可关联诊断
（[SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html)）。

**repo-wiki 推论。** 当前 `Issue`、计数、phase、applicability、去重排序和 `skipped_checks` 已接近成熟
形态。下一步只需给 JSON envelope 增加 `format_version`，保持 `code` 稳定，并遵循一条关键规则：
同一验证作用域内聚合所有**独立**问题；如果前置 Artifact 无法解析，只报告根因并把依赖检查放入
`skipped_checks`，不展开几十条必然失败的引用错误。人类输出可按 `phase + code + root cause` 分组，
`--json` 保留完整 items。没有互操作需求时无需实现完整 SARIF。

### 7.3 Composition requirements packet

**来源事实。** Anthropic 的生产多 agent 经验要求 subagent task 明确 objective、output format、
tools/sources 和 boundaries；模糊任务会造成重复和遗漏，长结果应落盘并只回传轻量引用
（[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)）。
OpenAI 的 Multi-agent 指南同样把 independent、bounded work 与 focused context 作为适用条件，并
指出有共享可变状态或固定确定性执行图时单 agent 更合适
（[OpenAI Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)）。

**repo-wiki 推论。** 在 Plan approval 后由 kernel 派生一个全局但紧凑的 composition requirements
packet，内容只包括：effective unit inventory、Domain/Concept ownership、允许的 page types、路径
regex 与保留名、reference roots、exact-once/route/merge-probe obligations，以及目标输出路径和
验收命令。它不应携带完整 evidence seed、Catalog detail 或 Plan prose。

Composition 有全局 exact-once 闭包，默认仍由一个 composer 完成；packet 是减少输入噪声，不是把
全局映射切成相互不知道对方决策的多个任务。该 packet 应由 compiled ledger 派生并 digest-bind，
不是新的 authored Artifact。是否增加 `okf composition prepare --json`，应由现有 composer 的 token、
时延和返工 eval 决定；不要同时再造通用 query DSL。

### 7.4 Page evidence registry、bounded excerpts 与 cache

**来源事实。** MCP Resource 用 URI 唯一标识 context，明确分离 `resources/list` 与
`resources/read`，列表支持 pagination/cache metadata，由 application 决定搜索、过滤和注入时机
（[MCP Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)）。MCP Tool
有独立 input/output schema，并支持分页 discovery
（[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）。Anthropic 推荐
JIT context 使用 path/query/link 等轻量标识，并为大工具结果提供 pagination、range、filter 和
truncation（[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、
[tool response efficiency](https://www.anthropic.com/engineering/writing-tools-for-agents)）。

Anthropic prompt cache 仅在 prefix 匹配时复用计算，默认 TTL 5 分钟；工具、system 或较早 message
变化会使后续 prefix 失效（[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、
[cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)）。因此它既不是
证据 provenance，也不是持久 evidence store。

**repo-wiki 推论。** 不新增全局 `evidence-cache.json`。直接在现有 page packet 加 page-scoped
`evidence[]` registry：`id`、plain locator、Source binding/catalog digest、kind、bounded excerpt 的
实际行范围、`truncated` 和 excerpt digest。`id` 可由 normalized logical locator 稳定派生；跨
revision 的内容正确性由独立 binding digest 保证，不能假设 MCP URI 或 locator 本身 immutable。
excerpt 不足时 writer 仍用 locator JIT read，最终引用仍落到 canonical locator。

若后续 profile 证明重复读取是瓶颈，kernel 可加 disposable cache，key 至少包含 Source/Catalog
digest、normalized locator、range 和 policy version；Run/digest 变化即 miss。registry 是 packet
契约，cache 是可删除后重建的实现细节。

### 7.5 Compact Catalog views

**来源事实。** MCP 把只返回 metadata 的 resource discovery 与完整 content read 分开；Anthropic
也建议工具提供 `concise|detailed`、分页、范围、过滤和截断，并展示过 concise response 约使用
详细响应三分之一 token 的实例。该比例是单个 Anthropic 示例，不应当作 repo-wiki SLO
（[Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)）。

**repo-wiki 推论。** 当前 `catalog tables`（source/schema/count/names）与 `catalog describe` 已经是
正确的 discovery/detail 两级，不需要新命令族。Composition packet 和 page packet 只投影 table
logical ID/name、关系或列计数、content digest 与 detail handle；需要字段、键、comment 时才
`describe`。只有大型 Catalog eval 显示 list 仍超预算，才给 `tables` 补 `--after/--limit` 和过滤；
跨源 compare 成为重复工作后，再考虑一个确定性 compare view，而不是先造通用查询语言。

## 8. 实现决策

1. **已实施：semantic intent 由 kernel 编译为 ledger。** models、validation、references、tests、
   CLI e2e 和 grader 使用同一契约，不保留双写或兼容分支。
2. **已实施：prerequisite-aware aggregation。** `plan inspect` 保留全部可独立检查的分类 issues，
   并显式列出确实无法执行的 `skipped_checks`；Run contract 标识 schema，无需重复的
   `format_version`。
3. **已实施：composition requirements packet。** 现有运行已经证明 derived unit 和隐式路径规则
   导致反复修复，因此在写 Composition 前一次性给出完整约束。
4. **已实施：page-scoped evidence registry 与 digest-bound cache。** 多 writer 重复读取和超时是
   已观察事实；cache 命中复用，失配时由 `page prepare` 重建。
5. **已实施：Catalog summary/compact/full 分层。** cursor/filter 留待大型 Catalog eval 证明现有
   summary 仍超预算后再增加。

不增加 `plan patch`、`bundle refresh-digest`、通用调度器或通用 `catalog compare`。它们会引入
第二套编辑语言、破坏 Run 可复现性，或仍缺少重复需求证据。
