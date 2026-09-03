# Wiki 生成 Artifact 与工作流最佳实践

日期：2026-09-03  
范围：针对 repo-wiki 的 Plan、数据库证据、Domain 页面、验证、writer dispatch 与跨平台 CLI。  
资料边界：只采用官方规范、官方项目文档和原始研究。

> 外部资料不会规定 repo-wiki 的 Artifact 名称、locator 语法或阶段划分。本文先陈述来源
> 支持的通用原则，再给出项目内推论；`source/table`、`plan-ledger.json` 和
> `okf page prepare` 都是 repo-wiki 设计选择，不是外部标准原文。

## 结论

当前方向应调整为：**可读 Plan 与机器账本分离；数据库 locator 使用稳定逻辑名，运行环境
坐标只留在 Source/Run 绑定中；Domain 是厚概览和导航入口，但不复制详细页事实；unit 继续
exact-once ownership；日常工作看阶段状态，全量 `validate` 保留为审计；每个 writer 只接收
一个由 kernel 派生的页面 packet。**

推荐数据流：

```text
frozen Source/Catalog
  -> plan-ledger.json (机器事实、coverage、scope、seed、gap)
  -> plan.md          (全局模型、生命周期、结论、反证、缺口)
  -> composition.md   (unit exact-once -> page/path)
  -> page packet      (单页所需的最小高信号上下文)
  -> one writer / one page
  -> phase status -> full validation -> review -> publication
```

### Anthropic、OpenAI、MCP/QMP 对照

| 来源 | 官方主张 | 对 repo-wiki 的直接含义 |
|---|---|---|
| [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context 是有限资源；使用最小高信号集合、轻量标识和按需检索 | writer 接收页面 packet，再按 locator 读取证据，不预装完整 Plan/Reference Map |
| [Anthropic effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 从简单、可组合工作流开始；只有任务可独立拆分时才并行 | 保留确定性阶段编排；一页一 writer，避免多页大任务和通用 scheduler |
| [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) | 删除重复指令和无关工具；有界的过滤、连接、去重、聚合、验证适合程序化处理；以代表性任务评测 | 账本投影、coverage、dedupe 和 packet 生成放在 kernel；LLM 负责证据综合与写作 |
| [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) | host 负责编排和权限，server 暴露聚焦能力并只接收必要上下文 | 页面 packet 可未来暴露为 resource/tool，但本地 CLI 已能满足时不增加 MCP server |
| [QEMU QMP](https://www.qemu.org/docs/master/interop/qmp-spec.html) | QMP 是控制 QEMU 的 JSON machine protocol | 与 Wiki/agent context 无关；若“QMP”不是笔误，需要提供全称再评估 |

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

当前契约已经写明“small frontmatter、body holds analysis”，但又让 Plan frontmatter 承担完整
coverage ledger，两条规则存在结构性张力，见
[`references/contract.md`](../../skills/repo-wiki/references/contract.md) 与
[`references/plan.md`](../../skills/repo-wiki/references/plan.md)。拆分 Artifact 才能真正消除张力。

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

共享 issue record 至少增加 `code`、`severity`、`phase`、`artifact/location`、`message` 和
`next_action`。未来页面尚未写时，在阶段视图中省略或标为 `pending/notApplicable`，不能计入
当前 `error_count`；真正违反当前阶段前置条件的项才是 blocking error。

当前 `_state.status()` 已按阶段短路，所以第一步只是统一 issue metadata、明确两个命令的职责
并让 SOP 默认调用 status。只有实际使用仍需要任意阶段审计时，才增加 `validate --phase`。

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

当前“一 writer 一页”是正确修复，但仍把完整 Plan、Composition 和 Reference Map 都交给每个
writer，输入边界仍过大。建议新增唯一一个较深的只读 CLI 接口：

```text
okf page prepare <page-id> --json
```

kernel 从已批准 Artifact 派生并落盘 `work/page-packets/<page-id>.json`，只包含：page spec、
owned units、相关 Domain/Concept/model/relationship 摘要、允许的 scopes/seeds、该页使用到的
Reference Map entries、模板与输出路径、diagram obligations 和验收条件。writer 再通过现有
`evidence search/read` 按需打开 frozen evidence。

packet 必须 digest-bind 到 Plan ledger、Plan narrative 和 Composition；它是投影，不是新事实源。
handoff 继续只返回 draft path、citation count 和 gap count。不要增加通用 scheduler、共享 writer
memory 或多页 writer。

OpenAI 与 Anthropic 的官方实践在这里一致：入口应短、Source of Truth 应持久且可检索、当前任务
只装载相关上下文。它们没有规定“一页一个 writer”或上述 packet schema；这是结合本项目 page
ownership、超时数据和确定性 kernel 作出的推论。

### “QMP” 检索结论

对 `"QMP" LLM agent context engineering`、`"QMP" documentation generation AI agent` 等精确
组合检索，未找到与 Wiki 生成、agent context packet 或文档工作流相符的权威方法/产品。检索到的
同名项包括原始研究 [Q-switch Mixture of Policies](https://arxiv.org/abs/2302.00671)（多任务强化
学习）以及 [QEMU Machine Protocol](https://www.qemu.org/docs/master/interop/qmp-spec.html)，均与
本问题无关。因此本文不把 QMP 纳入设计依据；需要其全称或官方链接后才能可靠比较。

如果这里想表达的是 **MCP（Model Context Protocol）**，其官方
[architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) 要求 host 负责
编排与权限、server 提供聚焦能力，server 只接收必要上下文且不能读取整个 conversation；
[server primitives](https://modelcontextprotocol.io/specification/2025-06-18/server/index) 则把
application-controlled resources、model-controlled tools 和 prompts 分开。
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

## 7. 调整后的实施顺序

1. **P0：修 plain Catalog locator 全链路。** 清除所有 Artifact 中的连接坐标，并加入真实
   OpenGauss capture CLI e2e；这是契约、安全边界和跨环境稳定性的共同前提。
2. **P1：拆分 Plan narrative 与 machine ledger。** 同步 models/validation、Artifact references、
   tests、CLI e2e 和 grader；不保留双 schema 或迁移分支。
3. **P1：新增 `okf page prepare`，随后加厚 Domain 模板。** Domain 的聚合信息由 packet 派生，
   unit ownership 仍 exact-once。
4. **P2：统一阶段诊断字段与命令语义。** 日常 SOP 用 status，全量 validate 用于审计/review。
5. **P2：补公开路径规则、完整端到端示例、PowerShell 示例和 `pwsh 7` smoke test。**

暂不增加 `plan patch`、`bundle refresh-digest`、通用调度器或通用 `catalog compare`。前两者分别
引入第二套编辑语言、破坏 Run 可复现性；后两者应等重复需求和性能数据证明值得维护时再加。
