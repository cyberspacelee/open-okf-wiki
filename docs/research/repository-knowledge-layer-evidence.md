# Repository Knowledge Layer：社区经验与一手证据

日期：2026-09-24。服务于 [ADR 0027](../adr/0027-repository-knowledge-layer.md) 与
[设计文档](../design/repository-knowledge-layer.md)。每条证据后给出对设计的约束。

## 1. 仓库上下文文件是否真的帮助 Coding Agent

**ETH Zurich，Evaluating AGENTS.md（Gloaguen et al., 2026）**
<https://arxiv.org/abs/2602.11988>

- 在多种 agent 与模型上，上下文文件总体没有提升任务成功率，推理成本平均上升 20% 以上。
- LLM 生成的上下文文件倾向于降低成功率；开发者手写的文件略有提升。
- 失效主因是冗余：LLM 生成内容大多复述 README 和目录结构。去掉仓库中全部文档后，
  LLM 生成的文件反而平均提升 2.7%。
- 仓库概览类内容没有让 agent 更快找到相关文件；agent 会忠实执行文件中的指令，
  不必要的要求会让任务变难。作者建议只写最小必要要求，例如仓库特有工具。

**Lulla et al., On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents（2026）**
（经 <https://arxiv.org/pdf/2606.20512> 转引）：精心维护的 AGENTS.md 让聚焦型 PR
的运行时间减少 28.6%，输出 token 减少 16.6%。该研究测的是效率，不是正确率。

**On the Use of Agentic Coding Manifests（253 个 CLAUDE.md）**
<https://arxiv.org/abs/2509.14744>：开发者实际写入的内容以 Build/Run 命令、
实现细节和架构为主，层级很浅。

设计约束：

1. Wiki 不能常驻上下文。常驻部分只保留一个极短的指针块，其余内容按需拉取。
2. 已有文档说过的东西只链接不复述；README 式概览不是价值来源。
3. 高价值内容是仓库特有的要求、命令、约束和不易发现的知识。这与 Grep Test（ADR 0002）一致。
4. 规范必须有证据且写成可执行条目。agent 会逐字执行，错误规范的代价高于缺失。

## 2. 上下文工程与 Harness 实践

**Anthropic，Effective context engineering for AI agents**
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

- 推荐 just-in-time：上下文只保留文件路径、查询、链接这类轻量标识，运行时再用工具加载内容。
- Claude Code 采用混合模式：启动时放入 CLAUDE.md，其余靠 glob/grep 即时检索。

**OpenAI，Harness engineering** <https://openai.com/index/harness-engineering/>

- AGENTS.md 只当目录（约 100 行），不当百科。结构化的 `docs/` 是 system of record。
- 用 linter 和结构测试强制架构约束，失败信息直接给出修复指引；用后台
  “doc-gardening” 任务持续发现过期文档（二手综述：
  <https://www.swequiz.com/articles/openai-harness-engineering>）。

**Codified Context（Vasilopoulos, 2026）** <https://arxiv.org/abs/2602.20478>

- 在一个 108k 行的 C# 系统上，分三层组织项目知识：
  - 常驻的 “constitution”：规范、构建命令、触发表；
  - 19 个领域专家 agent；
  - 34 份按需检索的规格文档（cold memory）。
- 按访问频率分层是核心。

设计约束：

1. Wiki 是 cold memory，入口是一个路由索引，页面 `description` 写“何时该读”。
2. 仓库规范（conventions）是 agent 修改代码时最常用的知识，应单独成页、可独立检索。
3. 确定性检查应把修复建议直接写进报错信息，让 agent 能按报错自行修复。

## 3. Skill 编写最佳实践

**Anthropic，Skill authoring best practices**
<https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>

- SKILL.md 正文控制在 500 行以内，细节按渐进披露拆到一层深的 reference 文件。
- 对复杂流程给 checklist；采用 “运行 validator → 修复 → 重复” 的反馈循环。
- 按任务脆弱度选择自由度：
  - 高自由度：用文字描述判断；
  - 低自由度：直接执行确定性脚本。
- 先写评测再写文档。
- description 用第三人称，同时写清做什么和何时触发，上限 1024 字符。
- 开放规范另有正文约 5000 token 的建议。

设计约束：

- SKILL.md 只写判断和顺序。状态、校验、映射、影响分析交给脚本，
  脚本源码不进入上下文，只有输出进入。
- 每个阶段以一个确定性命令收尾，形成反馈闭环。

## 4. 代码 Wiki 产品与论文

- **RepoAgent（2024）** <https://arxiv.org/abs/2402.16667>
  - 通过 Git pre-commit hook 检测变更，只更新受影响对象的文档。
  - 缺点是按物理文件和函数组织，本质上是 per-symbol 文档，正是本设计要避免的“代码复读机”。
- **RepoDoc（2026）** <https://arxiv.org/abs/2604.26523>
  - 基于知识图谱做影响传播，增量更新比全量重生成省时 73%、省 token 77%。
  - 论文批评 RepoAgent 的文档孤立、模板化、缺乏交叉引用。
  - 结论：增量更新值得做；但知识图谱只是其中一种实现，本设计用 scope glob 加 git diff
    的更低成本方案，由评测决定是否需要更强机制。
- **CodeWiki（ACL 2026）** <https://arxiv.org/abs/2510.24428>
  - 层级分解加递归多 agent。在其自建 benchmark 上得分 68.79%，DeepWiki 为 64.06%。
  - 第三方评审指出其收益依赖未经验证的 LLM judge（<https://pith.science/paper/2510.24428>）。
  - 结论：复杂编排的收益有限且难以评测，不作为默认设计。
- **Swimm（商业）** <https://swimm.io/blog/how-swimms-github-app-works>
  - 文档与代码路径、符号耦合；每次提交或 PR 验证文档引用的代码是否变化，
    并标记可能过期的文档。
  - 结论：页面到源码的显式映射，加上 CI 中的过期检测，是被验证过的产品形态。
- **Zimmermann et al., Mining Version Histories to Guide Software Changes（ICSE 2004）**
  - 经典的 evolutionary coupling 方法：从提交历史挖掘“改 A 通常也改 B”。
  - 这是“常见修改需同步更新的位置”的低成本确定性线索。

## 5. 术语与 Ubiquitous Language

- DDD 实践（例如 <https://milanjovanovic.tech/blog/ubiquitous-language-ddd>）：
  - 术语表放在代码旁边（仓库内 Markdown 即可）；
  - 重命名代码的同一个 PR 同步更新术语表；
  - 同一词在不同上下文可能有不同含义，要标出边界。
- 社区 skill（例如 mattpocock 的 ubiquitous-language）：
  - 提取候选、标出歧义和同义词，并给出 canonical 名称。
- 本仓库 ADR 0004 曾判断“规范性语言是团队共识，不能由机器 canonize”。
  - 本设计的处理：术语页是有源码引用的描述性事实，写明 canonical 名称和应避免的别名；
  - 所有内容以 git diff 形式经人工 review 后才合入，这一步就是批准。

设计约束：

- 术语表以 canonical 名、含义、别名（避免）、位置四列组织。
- 由确定性 lint 检查其他页面是否使用了应避免的别名。
- 同一文件同一时间只有一个写者，防止术语表冲突。

## 6. 本地参考实现（refs/）

- **OKF v0.2**（`refs/knowledge-catalog/okf/SPEC.md`）
  - `type` 是唯一必填字段，其余为推荐。
  - `sources[].id` 与 footnote label 是归因连接键；`resource` 可以是路径，
    也可以是范围描述（L300-L361）。
  - `generated` / `verified` 与 actor 约定用于派生信任等级（L363-L407）。
  - `index.md` 无 frontmatter（仅根目录可带 `okf_version`），`log.md` 按日期分组（L502-L549）。
  - Consumer 必须容忍未知字段和断链（L733-L759）。
  - 结论：OKF 只约束持久化格式，不规定流程；producer 可以加扩展字段，例如本设计的 `scope`。
- **openwiki**（`refs/openwiki/src/agent/prompts/code.ts`）
  - 以 quickstart 作入口，包含从变更意图到页面、源码入口、测试的路由表。
  - `_plan.md` 是运行期临时文件，运行结束自动删除。
  - update 模式基于 git 变化定位受影响系统。
  - 目录 `index.md` 在运行后确定性生成。
  - 强调 “concise means dense and non-redundant”。
  - 反面教训：它要求“每个 service/package 都必须有独立页面”，这会重新引入目录镜像。
- **pi-llm-wiki**（`refs/pi-llm-wiki/skills/llm-wiki/SKILL.md`）
  - 元数据（registry、backlinks、index、log）归扩展所有，知识页面归 agent 所有；任务开始先 recall。
  - 结论：机械工作归确定性层，内容归 agent，这个边界清晰。
  - 但其 13 个工具和轨迹记忆超出本设计范围。

## 7. 汇总：设计含义

1. 采用拉取式知识层，而非常驻上下文。入口索引按任务路由，页面独立可检索。
2. 只记录再发现成本高的知识；已有文档只链接不复述。
3. 规范和术语是一等公民，并且必须有证据：规范来自配置文件或至少两处代码实例；
   命令尽量实际运行过。
4. 引用采用 claim 到 locator 的 footnote。重要事实（术语、规范、不变量、why）必须引用，
   普通描述不要求。
5. 页面到源码的映射（`scope` 加引用文件），配合 git diff，同时支撑增量更新、过期检测和变更影响查询。
6. 确定性 validator 把修复建议写进报错信息；agent 按“验证 → 修复”闭环工作。
7. 使用一次独立 review，信任等级用 OKF `verified` 如实记录。
8. 评测以任务为中心：路由命中率、引用支撑率、术语与规范召回、有无 wiki 的任务 A/B
   成本与成功率，以及增量更新召回。

## 8. Review 协议与 status 推导（2026-09-25 补充）

**Cross-Context Review（arXiv 2603.12123，2026）** <https://arxiv.org/html/2603.12123>

- 30 个产物、150 个注入错误、Claude Opus 4.6，对比四种审查方式：同会话自审（SR）、
  同会话二次自审（SR2）、带生成提示的子 agent 审查（SA）、只给产物的新会话审查（CCR）。
- CCR 的 F1 比 SR 高 4.0pp、比 SR2 高 6.9pp、比 SA 高 4.8pp；关键错误检出率 40% 对 29%。
- 同会话再审一次没有帮助：SR2 的发现更多，但精度更差（21.0% 对 25.8%）。
- 多轮独立的新会话审查，2–3 轮就能发现大部分可发现的错误，之后收益递减。

**LLM 自我纠错的局限**（Huang et al., ICLR 2024 <https://arxiv.org/pdf/2310.01798>；
CRITIC 综述 <https://beancount.io/bean-labs/research-logs/2026/04/26/critic-llm-self-correct-tool-interactive-critiquing>）

- 没有外部反馈时，模型难以纠正自己的推理，甚至越改越差；有效的反馈来自工具
  （例如 validator、源码）告诉模型它原本不知道的信息。

**Codified Context（arXiv 2602.20478）的维护教训** <https://arxiv.org/html/2602.20478v1>

- 过期是首要失效模式："agents trust documentation absolutely and out-of-date specs
  cause silent failures"。两起事故都是过期规格让 agent 走了已废弃的路径，只在测试时暴露。
- 维护成本约每周 1–2 小时；作者后来补了一个会话启动时的 drift 检测器，
  在源码变化而规格未更新时报警。

**同类 skill 与产品**

- deepwiki-skill（<https://github.com/natsu1211/deepwiki-skill>）：scan → TOC → 写页 →
  校验 Mermaid → 汇总 → 增量同步；中间产物有 `toc.yaml`、`context_pack.json`；
  没有自动 review，靠人工改 TOC 控制结构。
- microsoft/skills deep-wiki（<https://github.com/microsoft/skills/tree/main/.github/plugins/deep-wiki>）：
  architect / writer / researcher 三类 agent，每页要求 3–5 张图，另生成 onboarding、
  `llms.txt`、`AGENTS.md`；偏向面向人的全量文档站。
- Dosu `/doc-it`（<https://dosu.dev/blog/claude-code-skill-doc-it>）：以审计现有文档中的过期路径、
  命令、配置键为主；实测仍会编造看似合理的参数，建议每个模块人工审 10–15 分钟；
  忘记运行时文档照样漂移。
- Swimm（<https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work>）：每次提交校验文档引用的
  代码片段和路径；能判定为无害的自动同步，其余让验证失败并交给人处理。
- Anthropic skill 编写实践（<https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>）：
  确定性操作交给脚本，采用"validator → 修复 → 重复"的循环，关键检查由脚本做而不是由文字要求；
  复杂流程给 checklist；避免给出太多选项。

设计约束：

1. **review 保留，而且必须是新上下文。** 同一个 reviewer 带着上一轮上下文复审，
   正是证据里效果最差的 SR2 形态。改为每轮派新 reviewer，它把上一轮 `_review.json`
   当作输入；因此跨轮的 issue ID 与 open/resolved 状态不再需要。
2. **轮数封顶 3。** 超过后把剩余 issue 交给用户，而不是无限循环。
3. **digest 绑定保留。** 它只有约 30 行实现，却是 `verified` 可信的唯一机械保证；
   agent 会无条件信任文档，把未经审查的修改标成已审查，代价比多一次审查高。
   我此前"删掉 digest"的建议（B1 初稿）撤回。
4. **status 的阶段推导保留。** 它就是 best practice 里的 checklist 与反馈循环，
   也是上下文丢失后恢复的唯一入口。收缩阶段只能省下约 20 行，但会把
   "现在该做什么"推回给模型判断。B2 初稿（收成 5 个状态）撤回，只修两处缺陷：
   - 单仓提交 wiki 本身会移动 HEAD，原规则会把所有 draft 判为过期；
     改为比较 wiki 目录之外的源码内容。
   - 已 stamp 的 wiki 遇到代码变化时，原规则先报 `structure`（覆盖错误），
     改为先进入 `update`，由 `okf update` 把变化写进对应页面的 todo 块。

## 9. 消融审查：逐项去掉会失去什么

判定标准：去掉某项后，Agent 后续开发会失去什么；它的成本落在 SKILL.md（每次运行的上下文）
还是 kernel（一次性代码）。

| 组件 | 去掉后失去什么 | 成本位置 | 结论 |
|---|---|---|---|
| `okf scan` | 术语、规范、命令、co-change 候选只能靠 agent 临时 grep；coverage 没有确定的模块清单 | kernel | 保留 |
| scan 的 co-change 挖掘 | "改 A 还要改 B"没有确定性来源，变更影响只能靠猜 | kernel | 保留 |
| todo 块作为工作状态 | 上下文压缩或换人接力后，发现阶段的候选全部丢失 | 页面内 | 保留 |
| Scout 并行发现 | 小仓不需要；大仓 coordinator 上下文会被撑爆 | SKILL 两行 | 保留为可选 |
| Structure 阶段 | 页面按目录镜像生成，失去 Grep Test 的过滤 | SKILL 五行 | 保留 |
| canon 先写 | 各页术语不一致；alias lint 没有依据 | SKILL | 保留 |
| canon 固定表头与取值 | 失去可校验性，也失去 `rg "^\| Invariant"` 这样的跨页检索 | kernel | 保留 |
| 规则 `Area` 枚举 | 只影响分类；去掉 `co-change`（改由变更影响表承载）和 `extension`（改由 Conventions 的扩展方式与 Module 的扩展点承载），新增 `vcs` 承载提交、分支与 PR 约定 | kernel | 保留并收窄 |
| 命令 `Status` | pointer 无法只列真正跑通的命令 | kernel | 保留 |
| 页面 `revision` 加 git diff | 没有 staleness 判定，而过期是首要失效模式 | kernel | 保留 |
| `stamp.content_sha256`（unreviewed-edit） | stable 页的正文或 frontmatter 被悄悄手改后仍显示为已审查 | kernel | 保留 |
| review digest | `verified` 无法证明对应被审过的内容 | kernel | 保留 |
| 跨轮 issue 台账（ID、open/resolved） | 同一 reviewer 复审才需要它，而证据表明这种复审更差 | reference 与 kernel | **删除** |
| 三处重复的同步修改章节 | 同一知识三个位置必然漂移 | 模板 | **合并**为一处 cited 变更影响表 |
| `parrot` 启发式 | 只是提示，最终由 reviewer 裁决 | kernel | 保留为 warning |
| `okf verify --actor human` | 人工确认只能靠 commit 记录体现 | kernel 约 20 行 | 保留（完整实现） |
| `okf pointer` | 常驻上下文只能手写，容易写成冗余概览 | kernel | 保留 |
| hub、OpenGauss | 核心流程不依赖它们 | reference 一份、kernel 约 900 行 | 保留为扩展 |
| 设计文档里的 SKILL.md 副本 | 两处副本会漂移 | 文档 | **删除**，改为链接 |

结论：真正的过度设计集中在旧 pipeline（Plan、Composition、packet、ledger、pin、
generation），已由 ADR 0027 删除。新方案里剩下的每一项都直接对应一条正确性不变量，
或一类 Agent 开发时需要的知识；本轮只删除跨轮 issue 台账，并合并同步修改章节。
