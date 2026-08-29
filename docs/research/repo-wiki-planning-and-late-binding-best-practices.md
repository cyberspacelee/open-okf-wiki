# Repo Wiki：规划、持久状态与路径晚绑定最佳实践

日期：2026-08-29  
访问日期：2026-08-29  
范围：greenfield contract，不考虑旧 Run、旧 Artifact 或旧 Target ID 的兼容与迁移。资料只采用官方文档、规范、官方源码/测试计划和原始标准。

> 证据边界：本文先陈述来源直接支持的事实，再标注对 repo-wiki 的设计推论。
> 外部资料没有规定 repo-wiki 的具体字段名、阶段名或预算值；这些是结合当前目标
> （thin wiki、证据 Locator、可恢复 agent 工作和确定性 State Gate）作出的工程设计。

## 结论

四项问题应作为一次 contract 重构处理，而不是在当前路径绑定模型上逐项打补丁：

1. Index 保存完整、无损的规范树，另生成可压缩的显示投影；压缩不能删除真实节点身份或跨越已识别的 module、source root、source set、配置与显式 split 边界。
2. Workspace Plan 由一个持续拥有整体 mental model 的主 Planner 完成；worker 只做有边界取证。对话 compaction 是运行优化，落盘 checkpoint 才是恢复事实源。
3. Plan 改成 Markdown 主 Artifact，但不让 kernel 从自由 Markdown 反推状态机和 DAG。Markdown 保存分析、证据、假设与结构提案；少量机器字段使用经过 schema 校验的 frontmatter/typed submission。
4. 引入稳定的 `concept_id` / `page_id`，不再用 Markdown path 充当 Target ID、依赖 ID 和 review subject。Plan 先确定知识 frontier；Page worker 形成独立 topic draft 和结构提案；全局 Structure Review 处理 split/merge/move；通过后才绑定最终 path 并物化发布结构。

推荐 lifecycle：

```text
capture + canonical index (kernel)
  -> long-lived workspace plan + durable plan.md checkpoints
     -> bounded evidence workers (no page/path ownership)
  -> concept/page-draft DAG keyed by stable IDs
  -> global structure review: coverage + split/merge/move + hierarchy
  -> bind page IDs to final Markdown paths
  -> final page review + deterministic link/path rendering
  -> publish
```

## 1. Index：规范树与压缩投影分离

### 一手资料

[VS Code 1.41 release notes](https://code.visualstudio.com/updates/v1_41) 把连续单子目录渲染成一个组合树节点，并以 Java package tree 为典型场景；这是显示层压缩，而不是修改文件系统树。

[VS Code compact folders 官方测试计划](https://github.com/microsoft/vscode/issues/85928) 要求 compact node 仍完整支持选择、展开、键盘导航、上下文菜单、过滤、拖放和无障碍。直接含义是：压缩节点背后必须保留完整路径链和操作语义，不能只保存一个不可逆的显示字符串。

[IntelliJ IDEA Project tool window](https://www.jetbrains.com/help/idea/project-tool-window.html) 只压缩“empty middle packages”，同时独立表达 Modules、Packages、source/content/repository roots。它把“结构折叠”和“语义边界”作为两个不同问题处理。

[Maven standard directory layout](https://maven.apache.org/guides/introduction/introduction-to-the-standard-directory-layout.html) 明确区分 `src/main/java`、`src/test/java`、resources、site 和 integration tests；只有 language source directory 以下才是普通 package hierarchy。[Maven multi-module reactor](https://maven.apache.org/guides/mini/guide-multiple-modules.html) 还把 module 作为有依赖和构建顺序的项目单元。

[Gradle multi-project builds](https://docs.gradle.org/current/userguide/multi_project_builds.html) 同样把 root project、subproject、project path、project directory 和 project dependency 作为显式模型；逻辑 project path 默认映射到目录，但可通过 descriptor 改名或改目录。这证明物理目录形状本身不足以识别 module 边界。

### 对 repo-wiki 的设计推论

Index 应拆成两个明确层次：

```text
Canonical tree
  path, parent, direct files, recursive files, children, semantic roles
        |
        v
Projection policy
  visible nodes + nearest visible parent + compact display path
```

规范树覆盖 Pin 中全部 eligible paths，是 coverage、局部浏览和验证的事实源。显示投影只负责控制 agent context；重新渲染投影不能改变 coverage 或 Locator。

一条链可以压缩，当且仅当每个中间节点同时满足：

- 恰好一个 eligible 子目录；
- 没有直属 eligible 文件，因此该节点和子目录的递归文件数一致；
- 没有必须保留的 semantic role；
- 不是 root、branch、leaf 或 configured split。

`recursive_file_count` 相等适合作为确定性校验，但不是独立语义规则；在“一个子目录且无直属文件”成立时它本来就应相等。

阻断压缩的 semantic role 至少包括：

- Workspace/build/module root，由实际 manifest 或 build descriptor 识别；
- source root 和 source set，例如 Maven/Gradle 的 main、test、resources；
- manifest/config-bearing boundary；
- 用户配置的 split/protected boundary；
- generated/vendor/excluded policy 的边界。

不要仅靠目录名猜测所有 module 或配置边界。`services`、`config`、`main` 等名字可以是普通 package；可信顺序应是 build metadata、显式 workspace policy、已知标准 layout，最后才是普通目录。

压缩行显示最深完整路径，例如：

```text
src/main/java/com/company/project/  (214 files)
```

但它的逻辑父节点是“最近的可见祖先”，缩进不能继续按被隐藏的物理深度计算。所有隐藏节点仍可由 bounded `outline/ls` 下钻查看。

60–70% 只能作为 Java fixture 和真实仓库 eval 的观测指标，不能成为跨语言 contract。正确性断言应是：文件 coverage 不变、semantic anchors 不丢、稳定排序不变、压缩投影可无歧义映射回规范路径。

## 2. Plan：一个主 Planner，外置状态，有界 worker

### 一手资料

[Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 把长任务的核心手段分为 compaction、structured note-taking 和 multi-agent architectures。它明确以 `NOTES.md` 为例保存进度和依赖；在 multi-agent 模式中，lead agent 保留高层计划并综合，subagent 隔离深度搜索上下文，只返回压缩结果。

[Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 的实验结论是 compaction 本身不够：harness 使用 `claude-progress.txt`、feature state、git history 和每个 session 的 structured update，使新上下文能恢复工作；每次只推进一个清晰单元并留下可验证状态。

[OpenAI: From model to agent](https://openai.com/index/equip-responses-api-computer-environment/) 将 compaction 与 persistent filesystem、skills 和 durable artifacts 视为互补能力：compaction 缩短模型上下文，文件系统保存可查询的结构化状态。两者不是替代关系。

[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 区分 thread checkpoint 和跨 thread store；checkpoint 用于中断恢复、故障恢复和状态检查。官方同时警告内存 checkpointer 在进程重启后丢失，生产环境需要持久后端。

[LangGraph subgraph persistence](https://docs.langchain.com/oss/python/langgraph/use-subgraphs) 推荐独立 subagent 使用 per-invocation state：调用内有 checkpoint/durable execution，各调用彼此隔离；只有确实需要跨调用记忆时才使用 per-thread state。

### 对 repo-wiki 的设计推论

Plan 的所有权应是：

```text
workspace planner
  owns: workspace model, coverage, concept frontier, unresolved conflicts

evidence worker
  owns: one bounded question, source/path scope, evidence locators
  returns: concise findings + gaps; never page paths or global IA
```

这不是“一个 agent 读取一切”。主 Planner 可以并行派发搜索、调用链、数据库 schema、跨 Source counterpart 等取证任务，但它必须持续消费 worker 结果、消解冲突并维护一个整体模型。worker 的预算按问题边界给足，不按“多开几个小 budget agent”平均切碎。

每个 Plan Attempt 应有正式的 durable working artifact，而不是临时聊天摘要。建议 `plan.md` 固定包含：

```markdown
# Objective and scope
# Source/module coverage
# Confirmed findings and Locators
# Open hypotheses
# Rejected hypotheses
# Cross-source relationships
# Candidate concepts and logical relations
# Coverage gaps
# Worker handoffs
# Next investigations
# Decision log
```

checkpoint 时机至少包括：完成一个 Source/module pass 后、派发 worker 前、合并 worker 结果后、重要假设状态改变后、主动 compaction/reset 前，以及 Attempt 交接前。写入必须原子化；失败 Attempt 的最后有效 checkpoint 应保留供下一 Attempt 恢复，不能随 active artifact 一起无条件删除。

恢复协议应是确定性的：读取 Run/Target machine state，读取最新有效 `plan.md` checkpoint，核验其 Pin/Attempt binding，再从 `Next investigations` 和未完成 worker handoff 继续。conversation compaction 可以加速恢复，但不能成为进展的唯一副本。

为了防止 Markdown progress 被模型误判为完成，机器状态仍应保存小型字段，例如 checkpoint sequence、artifact digest、Pin digest、worker status 和 gate verdict。Anthropic 的长任务实验还发现严格 feature 状态用 JSON 比 Markdown 更不容易被误改；这正说明叙事进展与机器状态应分层，而不是把全部状态迁进自由 Markdown。

## 3. Plan Artifact：Markdown 主体，严格机器投影

### 一手资料

[CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) 定义 heading、paragraph、list、code block 和 link 等文档语法，但没有 required field、类型、唯一性、引用完整性或 DAG 无环约束。Markdown 是文档格式，不是状态机 schema。

[YAML 1.2.2](https://yaml.org/spec/1.2.2/) 定位为 human-friendly serialization language，提供缩进 block 和 literal/folded scalar；它比 JSON 更适合混合短机器字段与长自然语言，但仍需要标准 parser 和独立语义验证。

[Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) 采用 YAML frontmatter 保存少量受约束 metadata，Markdown body 保存自然语言 instructions，并把更长 references 按需拆出。这是“机器元数据 + 人类/agent 叙事”的直接先例。

[GitHub Docs YAML frontmatter](https://docs.github.com/en/contributing/writing-for-github-docs/using-yaml-frontmatter) 也采用 Markdown body 加 YAML metadata，并由 schema/tests 校验 frontmatter，而不是从正文标题和列表猜测机器状态。

[OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) 和 [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) 都使用 JSON Schema 加 constrained decoding 保证输出可解析并符合 schema。OpenAI 同时明确：schema 合规不保证字段值在语义上正确，refusal、截断和 stop condition 仍需处理。

### 对 repo-wiki 的设计推论

“避免让 LLM 写大段自然语言 JSON”是正确目标；“最终可执行 Plan 变成自由 Markdown”不是完整方案。推荐一个逻辑 Plan、两个职责清楚的表示：

1. `plan.md` 是主 Artifact：整体理解、证据、假设、coverage、候选 concept、逻辑层级和 decision log。
2. typed submission 是 kernel projection：稳定 ID、scope、依赖、状态、少量枚举和 Locator。优先由 strict structured output/tool call 产生；文件型 runtime 可使用同一 `plan.md` 的 YAML frontmatter，再由标准 YAML parser + Pydantic 验证。

不要写自定义 Markdown heading/list parser 来重建 DAG。标题重命名、列表缩进或解释性段落变化不应破坏 kernel state。

frontmatter 只保存机器真正要执行的字段，自然语言说明放正文，并通过 ID 关联。例如：

```yaml
---
schema: repo-wiki-plan-v2
checkpoint: 12
concepts:
  - id: request-lifecycle
    scopes: [api-core]
    depends_on: []
    evidence:
      - API/api-core/src/main/java/example/Request.java#L20-L48
---
```

正文则解释该 concept 的生命周期、边界证据、反例和 coverage gap。Gate 继续验证 ID 唯一、scope 合法、Locator 绑定 Pin、依赖存在且无环；语义 Review 检查 concept 是否值得成为独立 topic。

如果宿主能提供 constrained decoding，应在模型采样时约束 typed submission，而不是生成后反复做 JSON repair。如果宿主只能让 agent 写文件，YAML frontmatter 仍可能有 parse error；正确处理是标准 parser 的明确 gate error 和局部修复，不是容错猜测或 ad hoc repair。

## 4. 晚绑定路径：稳定身份、独立信息架构和动态 DAG

### 一手资料

[OASIS DITA 1.3 indirect key-based addressing](https://docs.oasis-open.org/dita/dita/v1.3/os/part2-tech-content/archSpec/base/key-based-addressing.html) 定义 key 作为资源的间接引用层；实际 URI 和 metadata 在 map 中绑定，而 topic 内引用 key。其 [`keyref` 规范](https://docs.oasis-open.org/dita/dita/v1.3/os/part1-base/langRef/attributes/thekeyrefattribute.html) 明确称其为 indirect、late-bound reference。

[OASIS DITA maps](https://dita-lang.org/2.0/dita/archspec/base/definition-of-ditamaps) 把 topic 内容和 map 信息架构分开：map 表达 hierarchy、navigation order、非层级关系和 key resolution context；topic 可以保持相对 context-free，并在不同 map 中复用。

[OASIS DITA topic definition](https://docs.oasis-open.org/dita/v1.0/archspec/topics.html) 给出成熟的拆分尺度：topic 应短到聚焦一个 subject/answer 一个 question，又长到可独立理解和独立创作。这比按目录、字符数或 package 数拆页更接近 Wiki 的知识边界。

[Docusaurus create-doc](https://www.docusaurus.io/docs/create-doc) 分开了 document `id`、文件位置、sidebar hierarchy 和 URL `slug`；显式 `slug` 可以覆盖由文件路径推导的 URL。它证明常见文档系统不要求“身份 = 文件路径 = 导航位置 = URL”。

[W3C: Cool URIs don't change](https://www.w3.org/Provider/Style/URI) 特别警告把 subject classification 写死到 URI：主题关系是网状的，不同人会选择不同树，分类也会变化。W3C 建议把 URI 当抽象标识空间，再映射到当前文件系统实现。[GitHub Docs redirects](https://docs.github.com/en/contributing/writing-for-github-docs/configuring-redirects) 则展示了已发布页面重命名或移动后保留旧入口的实际做法。

[Bazel Skyframe](https://bazel.build/reference/skyframe) 以短且不可变的 `SkyKey` 标识节点，以显式依赖构造增量 DAG；节点可多轮发现依赖，完整依赖登记用于精确失效和并行执行。这是“稳定节点身份”和“当前物理输出位置”分离的有力工程先例。

[Apache Airflow Dynamic Task Mapping](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/dynamic-task-mapping.html) 和 [LangGraph `Send`](https://docs.langchain.com/oss/python/langgraph/graph-api) 都允许上游结果确定后再在 runtime fan-out 下游工作，并对 fan-out 设置显式边界。DAG 不必在最早阶段知道最终任务数量。

### 对 repo-wiki 的设计推论

当前若以 `page:<path>` 同时承担 Target ID、dependency key、review subject、candidate location 和增量身份，则一次 move 等价于删除旧节点并创建新节点；split/merge 会重写节点集和所有入边/出边。这正是过早绑定 path 的结构性成本。

greenfield 模型应至少区分：

```text
concept_id   稳定知识调查身份，Plan 创建
page_id      稳定 topic/page 身份，结构收敛后创建或确认
parent_id    当前信息架构关系
path         最终 bundle-relative Markdown 位置，可晚绑定
slug/title   展示与路由属性，不充当内部 identity
```

ID 不应包含 owner directory 或最终 hierarchy。可读的稳定 slug 足够，不必引入 UUID；关键是不因 title、parent 或 path 改变而改变。内部依赖、review subject、artifact directory 和 invalidation 都引用 ID。

Plan 只确定：需要覆盖的知识、concept scope、证据 seeds、逻辑关系、候选 topic 和 gap。它不创建最终 Markdown path。

Page worker 以 concept/page ID 写入 Attempt workspace，例如 `drafts/pages/<page-id>/page.md`。正文使用 ID-based internal references，不能在尚未绑定时写相对 Markdown path。worker 同时可以提出：

- `keep`：边界可独立理解；
- `split`：包含多个可独立回答的问题；
- `merge`：单独页面无法自洽或与另一 topic 重复；
- `move`：内容成立，但 logical parent/section 不正确。

局部 Page worker 无法单独解决全局 hierarchy 和重复 concept，因此必须有一个读取全部已审 draft 摘要的全局 Structure Review/Composition Gate。它负责：

- 每个用户目标和 Source role 是否被覆盖；
- topic 是否满足“一个 subject/question 且可独立理解”；
- split/merge 后 scope、evidence、入边和出边是否完整重映射；
- parent tree 是否无环、是否存在无内容的必要 synthesis node；
- 页面标题、导航标签和候选 path 是否唯一、可理解且不过度扁平。

Structure Review 接受后，kernel 一次性绑定 `page_id -> path`，解析 ID-based links，验证 path 冲突和依赖 DAG，再物化最终 Page/Review targets。动态 fan-out 必须有 page count、depth、retry 和总预算上限；晚绑定不是让 agent 无界递归创建任务。

split/merge 的身份规则必须明确：

- move 只改 parent/path，保留 page ID；
- split 保留原 ID 给仍代表原主要问题的页面，其他新 topic 获得新 ID；若原边界不再存在，则原 ID retired，并记录 successors；
- merge 选择一个 surviving ID 或创建新 ID，并记录 absorbed IDs；不能让同一 ID 静默改变成无关知识；
- 已发布 Run 发生 path 改动时，Publication 生成 redirect/alias；“不迁移旧 Run schema”不等于允许破坏已发布链接。

## 5. 推荐的完整 contract

### Artifact

| Artifact | 作者 | 格式 | 责任 |
|---|---|---|---|
| Canonical Index | kernel | strict machine data | 全量路径、统计、semantic roles |
| Index Projection | kernel | bounded text/JSON | 压缩显示与下钻入口 |
| Plan checkpoint | 主 Planner | Markdown + 小型 validated frontmatter | mental model、证据、假设、coverage、concept graph |
| Worker brief | evidence worker | bounded Markdown/typed result | 一个问题的事实、Locator、gap |
| Page draft | Page worker | Markdown keyed by ID | 独立 topic 内容与结构提案 |
| Structure decision | independent review/gate | typed result | keep/split/merge/move、最终 hierarchy |
| Page binding map | kernel | strict machine data | `page_id -> path`、resolved links、redirects |
| Run/Target state | kernel | JSON/database | status、digest、attempt、dependency、budget |

### Gate 顺序

1. Index Gate：canonical coverage 完整，projection 无丢失、无错误 semantic folding。
2. Plan Checkpoint Gate：frontmatter 可解析、Pin 绑定正确、ID/scope/Locator 合法；正文非空并含恢复章节。
3. Concept Graph Gate：依赖存在且无环，但不要求物理 path。
4. Page Draft Gate：ID、scope、证据和正文对应；内部链接只引用已知 ID。
5. Structure Gate：coverage、topic 边界、split/merge/move 和 logical tree 一致。
6. Binding Gate：path 唯一、portable、内部链接可解析、published move 有 redirect。
7. Final Review/Publish Gate：最终渲染、Grep Test、证据语义和 bundle 完整。

### Eval

彻底重构应以失败模式和质量指标验收，而不是只跑 schema 测试：

- Java multi-module fixture：module/source roots 保留，package 单链显著压缩，canonical coverage 不变；
- Plan compaction/reset：在任意 checkpoint 后启动新上下文，不重复已完成探索，并能继续未决调查；
- worker recall：主 Planner 能追踪每个委托、证据和 unresolved gap，worker 不能写全局 path；
- Artifact reliability：记录 parse/gate retry；分别比较大 JSON、Markdown+frontmatter 和 constrained typed submission；
- IA quality：统计平级页面比例、重复页面、人工要求的 split/merge/move、断链和遗漏概念；
- mutation cases：对同一知识做 move、split、merge，验证稳定 ID、依赖重映射、精确失效和 redirect；
- crash recovery：进程在 worker、checkpoint、structure binding 和 publish 前后中断，恢复后不重复已确认工作、不发布半成品。

没有来源支持预设一个通用的 60–70% 压缩率、固定 scout budget 或“Markdown 天生比 JSON 稳定”。这些都必须由 repo-wiki 的真实 enterprise eval 决定。来源稳定支持的是：显示与规范状态分离、长任务状态外置、叙事与机器 schema 分层、逻辑身份与路径/导航解耦，以及由 scheduler 对晚发现的 DAG 工作做有界物化。
