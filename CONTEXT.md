# Repository Wiki Producer

This context defines the language for deriving a source-grounded Markdown wiki from one or more fixed source repositories.

## Language

**Wiki**:
A set of source-grounded Markdown pages that explains one Repository Snapshot Set for human readers.
_Avoid_: Knowledge Bundle, knowledge graph, model transcript

**Repository Snapshot**:
An immutable, read-only view of one named target repository at the exact revision used by one Wiki Run.
_Avoid_: Live checkout, mutable branch

**Repository Snapshot Set**:
The non-empty collection of named Repository Snapshots used together by one Wiki Run.
_Avoid_: Workspace, implicit repository list

**Producer Skill**:
The trusted, product-provided method and template bundle that guides how a Repository Snapshot Set becomes a Wiki.
_Avoid_: Target-repository Skill, Python workflow, prompt fragment

**Skill Version**:
An immutable release of the Producer Skill identified by its exact content digest.
_Avoid_: Latest Skill, implicit override

**Skill Fork**:
An explicitly created editable copy of a Skill Version whose changes are owned and versioned separately from product releases.
_Avoid_: Hidden prompt override, automatically upgraded Skill

**Wiki Template**:
An adaptable page scaffold in the Producer Skill that guides structure, questions, style, and diagrams without fixing the final page set.
_Avoid_: Renderer schema, mandatory page taxonomy, typed content block

**Semantic Workflow**:
The model-directed sequence of repository exploration, page design, writing, review, and completion decisions for one Wiki Run.
_Avoid_: Python state machine, fixed role pipeline

**Run Plan**:
The current objective, completion gates, evidence gaps, and delegated-scope status that keep one Wiki Run oriented across long investigation and compaction.
_Avoid_: Todo transcript, message history, durable checkpoint

**Wiki Run**:
One attempt to derive and publish a Wiki from a Repository Snapshot Set using one exact Skill Version or Skill Fork revision.
_Avoid_: Agent turn, chat session, Production Run

**Wiki Run Record**:
An immutable, secret-free terminal record of one Wiki Run's frozen inputs, outcome, usage, and publication status, used for audit and to create a Manual Retry Run.
_Avoid_: Message history, Analysis Receipt, durable checkpoint

**Staging Wiki**:
The isolated candidate Wiki written during a Wiki Run and not visible as the published result until validation succeeds.
_Avoid_: Published Wiki, model memory

**Published Wiki**:
The complete validated Markdown tree made visible as the result of a successful Wiki Run.
_Avoid_: Staging Wiki, Accepted Knowledge Model

**Wiki Manifest**:
The bounded terminal summary of pages produced by a Wiki Run.
_Avoid_: Page contents, workflow state, knowledge graph

**Source Citation**:
A resolvable reference from a Wiki page to a repository ID, path, and line range inside the pinned Repository Snapshot Set.
_Avoid_: Unsupported filename mention, Claim record

**Refresh**:
A Wiki Run that updates an existing Published Wiki for a newer Repository Snapshot Set while following the selected Producer Skill.
_Avoid_: Knowledge-graph invalidation, patch-only rendering

**Manual Retry Run**:
A newly created Wiki Run started by a human from an earlier Wiki Run Record after automatic retries are exhausted; it reuses the earlier run's frozen inputs by default but has its own run identity and does not resume the earlier conversation or partial receipts.
_Avoid_: Resume, checkpoint recovery, automatic retry

**递归委派树**:
一个 Wiki Run 内按 Root、Domain 和 Leaf 分层的有界 Agent 委派结构；每个 child 使用独立上下文调查受限 source scope，并向 parent 返回可复核的 Source Citation evidence。
_Avoid_: 无限递归、把所有源码塞进 Root、Python 固定角色流水线

**Leaf 协调工作流**:
Semantic Workflow 内一个可选的单层 fan-out、chain 或 reduce 阶段；它协调同构的 Leaf 研究任务，不负责全局页面决策，也不是递归委派树本身。
_Avoid_: Semantic Workflow、全局调度器、durable workflow

**Analysis Receipt**:
一个研究分支对其受限 source scope 的有界证据记录；包含 findings、Source Citation、未解决问题和子分支指针，供 parent 复核和归约，不是最终 Wiki 页面。
_Avoid_: model transcript、临时聊天记录、最终页面

**Analysis Workspace**:
Wiki Run 内保存 Analysis Receipt 和可选中间 artifact 的隔离临时空间；它只服务于本次 Semantic Workflow，不是 Published Wiki，也不是消息队列。
_Avoid_: /wiki、共享控制总线、永久知识库
