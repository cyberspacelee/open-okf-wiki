# Repo Wiki 图形表达、页面粒度与质量门禁

日期：2026-08-29

范围：为 repo-wiki 的完整 greenfield 修复提供研究依据；不考虑历史 Run、旧 Page Plan
或旧页面兼容。资料只采用官方规范、官方项目文档和原创同行评审研究。

## 结论

问题不能归结为“缺 Mermaid”。当前系统把真实性、引用和 coverage 作为主要优化目标，却没有把
**表达选择、单页认知边界和任务完成效率**纳入同一个 contract。完整修复应当：

1. 把 Architecture、Domain、Flow、Lifecycle、DataModel 等页面定义为不同的信息任务，而不是让
   Domain 承担边界、规则、状态、时序和失败传播的全部散文。
2. 在 Page Plan 中声明预期 diagram 的 `id`、`kind` 和它回答的问题；页面中的 Mermaid 必须与计划
   一一对应，并保持普通文本的结论与证据引用。
3. kernel 校验类型、计划对应、基础 Mermaid 结构、可访问描述和引用连接；reviewer 核验可渲染性以及
   每个节点、边、消息、转换和 cardinality 的语义，而不是让 kernel 实现 Mermaid grammar。
4. eval 不以 Mermaid 数量为质量指标；使用固定维护问题，分别测量人和 agent 的答案正确率、找证据
   的时间或 token、遗漏和错误路径，并与纯 prose 基线做配对比较。

图对人的收益有可靠但有条件的证据；“Mermaid 对 agent 天然优于 prose”目前没有直接证据。它是值得
验证的产品假设，不应写成既定事实。

## 一手证据及边界

| 证据 | 研究发现 | 对 repo-wiki 的约束 |
| --- | --- | --- |
| [Larkin 与 Simon：Why a Diagram is (Sometimes) Worth Ten Thousand Words](https://doi.org/10.1111/j.1551-6708.1987.tb00863.x) | 与句子表达信息等价时，图可把相关信息置于同一位置、显式化原本需要推导的关系，并减少搜索。标题中的 “Sometimes” 很重要：收益取决于任务和可用推理操作。 | 当读者必须从多段文字重建拓扑、顺序、转换或 cardinality 时用图；定义、理由和单一规则继续用短 prose 或表格。 |
| [Bauer 与 Johnson-Laird：How Diagrams Can Improve Reasoning](https://doi.org/10.1111/j.1467-9280.1993.tb00584.x) | 仅用图标替换文字的预实验没有收益；把备选可能性显式表示后，受试者约快 35 秒，并多得出近 30% 的有效结论。 | 图必须显式化分支、约束、失败或替代路径，不能只是把名词装进方框。review 要审“图新增了什么可推理结构”。 |
| [Petre：Why Looking Isn't Always Seeing](https://doi.org/10.1145/203241.203251) | 图形可读性依赖布局、分组等 secondary notation，也依赖读者已习得的阅读惯例；图形本身不保证清晰。 | 采用少量固定图种和一致语法；控制单图范围；不能让任意 boxes-and-lines 或超大图进入产物。 |
| [Ricca 等：五个 sequence diagram 实验](https://doi.org/10.1109/TSE.2012.27) | 112 名学生与专业人员的实验中，sequence diagram 对能力较高、经验较多的参与者改善功能需求理解。 | Sequence 适合熟悉软件交互的维护者，但页面仍需简短文字结论，不能要求所有读者只靠图解码。 |
| [Scanniello 等：UML 对源码理解的实验与复现](https://doi.org/10.1016/j.jvlc.2014.12.004) | 较有经验的维护者在代码加 class/sequence diagram 时平均理解收益约 12%；经验不足者没有同等收益。 | Wiki 的主要受众虽是开发者，仍不能用图替换边界、术语和失败语义的文本说明。 |
| [OASIS DITA topic 规范](https://docs.oasis-open.org/dita/v1.1/CD02/archspec/topics.html) | Topic 应短到只回答一个主题或问题，又长到能独立理解；更大的内容通过嵌套或引用组合。 | 拆页依据是“独立问题和独立路由”，不是字数、目录或图数量。父页负责导航和综合，不复制子页。 |
| [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) | 长上下文模型对信息位置不稳健，相关内容位于长输入中部时性能常显著下降。 | 对 agent 也应保持单页单问题、短 routing description 和按需加载；不能用“大 context 能装下”支持长篇页面。 |
| [Talk Like a Graph](https://proceedings.iclr.cc/paper_files/paper/2024/hash/bf72f65f30eedf5d48da6980ee02b589-Abstract-Conference.html) | LLM 的图推理性能受文本编码、任务和图结构影响；选择编码可带来 4.8% 到 61.8% 的差异。论文测试了多种 edge/node 文本编码，但没有证明 Mermaid 最优。 | Mermaid 源码可能给 agent 更显式的边结构，但收益必须按模型和问题实测；保留短文字结论，不把图当作唯一 agent 接口。 |
| [Ferrari 等：LLM 生成 sequence diagram 的研究](https://arxiv.org/abs/2404.06371) | 生成图通常可理解且符合标准，但相对于输入需求仍经常不完整或不正确，尤其在歧义、矛盾和隐含领域知识存在时。 | 能 parse 不等于语义正确。独立 reviewer 必须检查渲染结果，并回到代码核验图中关系及遗漏。 |
| [Treude 等：Beyond Accuracy](https://doi.org/10.1145/3368089.3417045) | 软件文档仅有准确和完整仍不充分；其框架还评估 readability、understandability、structure、cohesion、conciseness、consistency 和 clarity 等维度。 | 当前 citation/coverage gate 不能代表文档质量；review 和 live eval 必须加入表达与任务效率维度。 |

## Mermaid 图种选择

Mermaid 官方语义已经给出足够窄的选择边界：flowchart 表示节点与边，sequence diagram 表示参与者如何
交互及其顺序，state diagram 表示状态与转换，ER diagram 表示实体及关系。因此无需发明 repo-wiki
专用图语言。

| 读者要回答的问题 | 表达 | 必须显式的内容 | 不该使用的情况 |
| --- | --- | --- | --- |
| 系统由什么组成，依赖、数据或失败向哪里传播？ | [Mermaid flowchart](https://mermaid.js.org/syntax/flowchart.html) | 边界、方向、关键分支、外部系统；多 source 时以 source 分组而非只允许 source 作为节点 | 只有一个调用或一条无分支链；用一行文字更短 |
| 一次请求、事务或恢复在参与者之间按什么顺序发生？ | [Mermaid sequence diagram](https://mermaid.js.org/syntax/sequenceDiagram.html) | actor、同步/异步消息、返回、条件、循环、错误与补偿 | 描述对象可处于哪些状态；这不是时间线问题 |
| 一个领域对象能处于什么状态，什么事件允许或拒绝转换？ | [Mermaid state diagram](https://mermaid.js.org/syntax/stateDiagram.html) | 起止状态、事件/guard、失败/终止状态、可恢复路径 | 描述多个服务的调用顺序；状态图不应冒充 sequence |
| 数据实体如何关联、基数和可选性是什么？ | [Mermaid ER diagram](https://mermaid.js.org/syntax/entityRelationshipDiagram.html) | 选中实体、关系名、cardinality、ownership 边界 | 单表 schema；列细节继续留在 Table 页 |
| 哪些条件、owner、影响面或错误相互对应？ | Markdown table | 可逐行比较的固定字段 | 需要追踪路径、环、顺序或状态可达性 |

一个图只回答一个命名问题。选择的判据不是“至少 N 个节点”，而是：该关系是否通过 Grep Test 被 Wiki
收录，以及不用图时读者是否必须跨句搜索并自行重建关系。若图只是逐句复制 prose，就删除图或 prose
中的重复部分。

## 页面信息架构

### 页面类型

建议将 `PagePlanEntry.type` 从任意短字符串改为封闭枚举，并采用七种公开类型：

| Type | 单一主问题 | 主要结构 |
| --- | --- | --- |
| `Overview` | 从哪个页面开始处理当前任务？ | scope、task entry points；只链接 Architecture，不复制结构图 |
| `Architecture` | 系统边界、静态依赖和传播面是什么？ | responsibility map、boundary contracts、一个必需 flowchart、change/failure matrix、ADR links |
| `Domain` | 此能力拥有什么、遵守什么规则、使用什么术语？ | responsibility、public surface、invariants、concept vocabulary；图默认非必需 |
| `Flow` | 一次端到端行为如何跨参与者或分支执行？ | trigger/outcome、必需 sequence 或 flowchart、alternatives/failures、change points |
| `Lifecycle` | 一个核心对象如何转换状态和恢复？ | state ownership、必需 state diagram、transition/guard table、terminal/recovery paths |
| `DataModel` | 选中的持久化实体如何关联并跨越代码边界？ | ownership、必需 ER view、selected table links、code-to-data mapping |
| `Table` | 该表的 row shape、keys 和使用边界是什么？ | schema、keys、usage；不重复父 DataModel 的 ER 图 |

`Flow` 和 `Lifecycle` 是完整修复中最关键的新类型：它们从当前
[`domain.md`](../../skills/repo-wiki/assets/templates/domain.md) 的“Lifecycle and failure paths”中
拆出两种不同的推理任务。不要新增 `Diagram` 页面类型；图是页面的视图，不是知识边界。

### 拆页规则

Plan worker 只有在以下条件全部成立时才拆 child page：

1. child 回答一个可独立表述的维护或调试问题；
2. child 有独立 routing description，用户或 agent 会有理由只打开它；
3. child 的 owner/scope/evidence 或生命周期与 sibling 明显不同；
4. child 自身通过 Grep Test，脱离 parent 仍可理解；
5. parent 可缩成链接和跨 child 综合，而不是复制 child 正文。

同一对象的短生命周期和两个相邻失败分支可留在 Domain 页；跨多个参与者的重试时序、独立状态机或
独立变更面应成为 Flow/Lifecycle child。单页出现两张图不是自动拆页条件，但若两张图回答不同且可单独
路由的问题，通常已经满足拆页条件。

## 完整目标契约

### Plan 与模型

在 `PagePlanEntry` 增加必填（允许空列表）的 `diagrams`，由 Plan 唯一拥有：

```yaml
diagrams:
  - id: invoice-retry
    kind: sequence
    question: How does an invoice retry cross queue, service and payment gateway?
```

`id` 是页内唯一 ASCII slug；`kind` 仅允许 `flowchart | sequence | state | er`；`question` 是短 routing
文本。State Gate 将完全相同的字段写入 Candidate frontmatter，page worker 不得改变它。这样 status、
dispatch、review 和下游 agent 都能在不读取长正文时知道页面有哪些结构化视图。

Plan 模型同时实施以下规则：

- `Architecture` 恰有至少一个 `flowchart`；
- `Flow` 至少有一个 `flowchart` 或 `sequence`；
- `Lifecycle` 至少有一个 `state`；
- `DataModel` 至少有一个 `er`；没有值得收录的关系视图时使用 `Table` 或 `Domain`，不创建 DataModel；
- `Overview` 和 `Table` 不计划 diagram；
- `Domain` 只有在关系本身通过 Grep Test、但尚不足以成为独立 child 时才计划 diagram。

这属于 contract 变更，因此按仓库规则必须同步 `_models.py`、`_validate.py`、Target references、测试、
`run_cli_e2e.py` 和 `grade_run.py`；旧 Run 直接拒绝，不增加默认值、迁移器或双 schema。

### Writer 与模板

每个 planned diagram 在正文中使用一个 `mermaid` fence，并在 Mermaid comment 中声明稳定 id：

```text
%% okf-id: invoice-retry
sequenceDiagram
    accTitle: Invoice retry interaction
    accDescr: Queue dispatches an invoice retry; payment failure returns to retry scheduling.
```

每张图紧邻一个短 caption/结论段，并用正常 Markdown footnote 引用图的 load-bearing evidence。不要把唯一
引用放进 fence，因为当前 Markdown 抽取器跳过 fenced code。图不能成为唯一信息载体：保留结论、失败
语义和证据，但删除逐边复述。

模板应按上面的七类重写，而不是给所有模板机械加入 `## Diagram`。Architecture 允许 source subgraph
中存在模块节点，删除当前“node IDs are source identifiers”的过窄限制；DataModel 的 ER 图只包含选中
scope，不暗示全库已检查；Flow/Lifecycle 模板明确要求正常路径和异常/恢复路径。

### Kernel

kernel 只执行可确定判定：

- page type 枚举和 type-specific diagram 规则；
- frontmatter `diagrams` 与 Plan 完全相同；
- `%% okf-id` 唯一，planned/actual id 与 kind 一一对应；
- 用标准库识别四种受支持的 diagram declaration、非空图内容和明显悬空 connector；不尝试用正则
  复刻 Mermaid grammar；
- 每个 fence 有非空 `accTitle` 和 `accDescr`。Mermaid 会把它们渲染为 SVG 的 title/description；
  [官方 accessibility 文档](https://mermaid.js.org/config/accessibility.html)给出了对应 ARIA 输出；
- 每张图相邻 caption 至少引用一个属于页面 scope 的 source id；现有 locator、ownership 和 revision
  验证继续承担证据真实性；
- diagram source 计入页面预算并禁止残留 placeholder。

调研未发现适合该门禁的轻量 Python parser：
[`mermaid-syntax-parser`](https://pypi.org/project/mermaid-syntax-parser/) 实际通过 `pythonmonkey` 嵌入
JavaScript 引擎；[`mermaid-py`](https://pypi.org/project/mermaid-py/) 面向生成和渲染，不是 Python
grammar parser；[`mermaidx`](https://github.com/mohammadraziei/mermaidx) 同样嵌入 QuickJS 和渲染栈。
引入任一方案都没有消除 Mermaid 的 JavaScript/runtime 成本。完整语法与渲染又随 Mermaid 版本演进，
把它塞进每次 page gate 会造成重依赖和“parser 通过即产物正确”的假保证。因此 deterministic gate 只做
稳定、低误报的基础结构检查；独立 reviewer 在实际消费环境检查 renderability。需要批量发布渲染时，
再在发布链路固定最终 renderer 版本，而不是扩大写作 gate。

kernel 不判断图是否选择正确、节点是否遗漏或某条边是否真实，这些都需要语义理解。也不建立 connection
graph、图数据库、独立图 artifact 或 Mermaid frontmatter 中的 locator 副本。

### Accessibility

[WCAG 2.2 Success Criterion 1.1.1](https://www.w3.org/TR/WCAG22/#non-text-content)要求非文本内容有等价
文本替代；复杂图通常需要短描述加邻近的长描述。repo-wiki 的最小完整做法是：

- 每张图提供 `accTitle` 与说明关键路径/边界的 `accDescr`；
- 图后保留一段可独立理解、带证据的关键结论；
- 不以颜色作为唯一语义，边和状态使用文字标签；
- Mermaid 渲染不可用时，源码和结论仍可读取。

这不是额外 prose 副本：替代文本说明图的目的和关键含义，不枚举每个视觉元素。

### Review

在 review schema 增加 `representation` category。Plan review 负责：页面是否该拆、page type 是否正确、
是否遗漏必要视图、diagram question 是否与 routing 和 scope 一致。Page review 负责：

- 图种是否匹配问题；
- 每个决策相关 node/edge/message/transition/cardinality 是否有源码证据；
- 是否遗漏正常、失败、重试、补偿、终止或 optional relationship；
- 图与 caption 是否矛盾或重复；
- 命名、方向、分组和标签是否能按目标语言稳定阅读；
- `accDescr` 是否表达等价目的，而非“这是一个流程图”之类空话。

错误的 Plan 选择 reopen `plan:workspace`，错误图内容 reopen 当前 page；沿用现有 ownership 规则，不新增
review phase。

## 评测设计

### Deterministic suite

为四种 diagram 各保留一个最小正例，并覆盖以下负例：未知 page type、缺 planned diagram、额外 diagram、
id/kind 不匹配、未知 declaration、空图、明显悬空 connector、缺 accessibility 字段、caption 无 citation、DataModel relationship
存在但无 ER。`run_cli_e2e.py` 的 Architecture fixture 必须真正含 flowchart；当前无图 Architecture 不能再
作为成功基线。

### Semantic live eval

从真实仓库冻结一组有 oracle 的任务，每类至少覆盖：

- Architecture：判断改动的上下游和失败传播；
- Flow：恢复一次请求的参与者顺序、分支和重试；
- Lifecycle：判断某状态可达性、非法转换和恢复路径；
- DataModel：判断 ownership、cardinality 和删除/迁移影响。

同一 revision 生成两组产物：现有 prose baseline 与“diagram + short evidence text”。对人记录答案正确率、
完成时间和信心；对 agent 记录答案正确率、正确 locator 比例、遗漏、输入 token、工具调用数和延迟。
图只有在正确率不下降且时间/token 有可重复改善时才证明有效。

另用 Treude 等人的十维框架抽取适合本项目的 reviewer rubric：readability、understandability、structure、
cohesion、conciseness、consistency 和 clarity；accuracy/completeness 继续由 evidence gate 和 domain rubric
覆盖。人工或独立模型评分不能替代任务结果，只用于解释失败原因。

不要采用以下替代指标：Mermaid fence 数量、含图页面比例、节点数量、平均字数或单一 LLM-as-judge 分数。
它们能被装饰性图和机械拆页轻易优化，却不能证明读者更快、更正确。

## 实施顺序与完成定义

这是一个原子 contract 变更，建议按依赖顺序实现，但在同一变更中交付：

1. 定稿 page type、diagram admission/selection、拆页、证据和 accessibility contract；
2. 修改 Plan/Frontmatter models 与所有模板；新增 Flow/Lifecycle 模板；
3. 修改 planner/page/review references 和 review category；
4. 用 Python 标准库完成 Mermaid 基础结构 gate，并补齐 deterministic tests；
5. 更新 CLI e2e fixtures 和 grade rubric；
6. 跑真实仓库的 prose/diagram 配对 live eval，根据任务结果调整模板，而不是放宽真实性门禁。

完成标准不是“页面能渲染 Mermaid”，而是：计划明确选择表达、产物结构可验证、图逐关系有证据、无图用户
仍能获得等价结论，并且真实维护任务在人或 agent 至少一类消费方上表现出可测收益。
