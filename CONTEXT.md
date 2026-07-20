# Repository Wiki Producer

This context defines the language for deriving a source-grounded Markdown wiki from one or more fixed source repositories.

**Implementation note:** The live product is the TypeScript monorepo (`packages/*`: Web UI, localhost server, Mastra agent, `@okf-wiki/core` Run Boundary). See [ADR 0020](docs/adr/0020-typescript-mastra-web-workspace.md) and [ADR 0021](docs/adr/0021-retire-python-primary-path.md). Terms below remain domain vocabulary; older ADRs may still name historical Python packages.

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

**Workspace rootPath**:
The operator project home and agent working directory for one Workspace. Product meta (`.okf-wiki/`), optional skill fork, session state, and default clone destinations live under this root. Configured sources may live **inside or outside** rootPath.
_Avoid_: Mastra Workspace (framework FS/skills host), single-source assumption

**Wiki language**:
Workspace setting (`wikiLanguage`: `en` | `zh`) that directs the Semantic Workflow to write Wiki page titles and body prose in English or Simplified Chinese. Independent of the operator UI locale. Paths, code identifiers, and Source Citations stay untranslated.
_Avoid_: UI locale, provider model language default alone

**Mastra Workspace** (implementation term only):
Framework object (`@mastra/core/workspace`) bound per Wiki Run with `basePath = product rootPath` and Producer Skill paths for skill discovery. Not the product Workspace entity; never mounts unrestricted multi-source trees.
_Avoid_: product Workspace, Workspace rootPath synonym

**Source origin**:
How a source was attached: `path` (link existing absolute checkout) or `clone` (product-initiated `git clone` into the Workspace). Clone is operator-initiated only; the Semantic Workflow never clones.
_Avoid_: agent shell git, silent network fetch

**Run Boundary**:
The trusted execution boundary for one Wiki Run: freeze Snapshot Set and Skill, mount permissions, credentials and budgets, mechanical validation, staging, and atomic publication. Product implementation: `@okf-wiki/core`. Not the Operator Session and not the Semantic Workflow. (Pre-0019 ADRs may still say “Host” for this role.)
_Avoid_: host OS, Agent Host, host agent, HTTP host, harness, product web app

**Run Instructions**:
The short, non-forkable shell the product injects for every Wiki Run: mount and trust boundaries, activation of the selected Producer Skill, and boundary-enforced role limits.
_Avoid_: system prompt monolith, Producer Skill body, conversation-level one-off prompt, Skill Fork override

**Producer Skill**:
The trusted, versioned method-and-template bundle that teaches how a Repository Snapshot Set becomes a Wiki—investigation, page design, writing, review, and completion criteria—without owning Snapshot membership, budgets, or publication enforcement.
_Avoid_: Target-repository Skill, Run Instructions, system prompt blob, ignore catalog, Python workflow

**Skill Version**:
An immutable release of the Producer Skill identified by its exact content digest.
_Avoid_: Latest Skill, implicit override, re-resolved prompt text

**Skill Fork**:
An explicitly created editable copy of a Skill Version whose changes are owned and versioned separately from product releases.
_Avoid_: Hidden prompt override, automatically upgraded Skill, Run Instructions edit

**Wiki Template**:
An adaptable page scaffold in the Producer Skill that guides structure, questions, style, and diagrams without fixing the final page set.
_Avoid_: Renderer schema, mandatory page taxonomy, typed content block

**Semantic Workflow**:
The model-directed sequence of repository exploration, page design, writing, review, and completion decisions for one Wiki Run, directed by the Producer Skill within Run Boundary limits.
_Avoid_: Python state machine, fixed role pipeline, Run Instructions dump

**Run Plan**:
The current objective, completion gates, evidence gaps, and delegated-scope status that keep one Wiki Run oriented across long investigation and compaction.
_Avoid_: Todo transcript, Operator Session history, durable checkpoint of the Semantic Workflow

**Operator Session**:
The operator-facing **Conversational Workspace** for one project: AI SDK message history (`parts`), pending user decisions (dynamic options / free text by mode), workflow view (plan, linked runs), and zero or more Wiki Runs started from that context. Primary UI is the Session chatbot page (AI Elements + `useChat`), not a one-shot job request.
_Avoid_: Wiki Run, chat session as a resumable Semantic Workflow graph, Production Run, model transcript as the Wiki, Run console as the only operator surface

**Wiki Reviewer**:
An independent, bounded agent role that inspects the Staging Wiki against the Repository Snapshot Set and Producer Skill review guidance, producing a defects receipt for the operator and Root; it does not write Wiki pages or publish.
_Avoid_: Run Boundary mechanical validation, Skill self-review alone, multi-model voting panel, publisher

**Wiki Run**:
One attempt to derive and publish a Wiki from a Repository Snapshot Set using one exact Skill Version or Skill Fork revision; it may be started from an Operator Session but is not the Session itself.
_Avoid_: Agent turn, Operator Session, Production Run

**Wiki Run Record**:
An immutable, secret-free terminal record of one Wiki Run's frozen inputs, outcome, usage, and publication status, used for audit and to create a Manual Retry Run. Terminal statuses distinguish published success, needs input, failure, cancellation, awaiting operator publication approval, and operator-declined publication with Staging retained.
_Avoid_: Operator Session history, Analysis Receipt, durable checkpoint of the Semantic Workflow

**Staging Wiki**:
The isolated candidate Wiki written during a Wiki Run and not visible as the published result until validation succeeds and the operator (or YOLO) approves publication; declining publication leaves Staging intact for further Session work and does not alter the Published Wiki.
_Avoid_: Published Wiki, model memory, automatic discard on publish denial

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
A newly created Wiki Run started by a human from an earlier Wiki Run Record after automatic retries are exhausted; it reuses the earlier run's frozen inputs by default but has its own run identity and does not resume the earlier Semantic Workflow or partial receipts (it may attach to the same Operator Session).
_Avoid_: Resume of a Wiki Run graph, checkpoint recovery of Staging as Published, automatic retry

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

**Default Source Ignores**:
Product-defined repository-relative path patterns that omit common non-evidence tracked paths from every Repository Snapshot unless that repository disables them for the Wiki Run.
_Avoid_: gitignore import, Skill-owned ignore catalog, silent platform filter

**Effective Source Ignores**:
The frozen set of repository-relative path patterns actually applied when materializing one Repository Snapshot for one Wiki Run; the union of Default Source Ignores when enabled and that repository's configured ignore patterns.
_Avoid_: live working-tree filter, re-resolved product defaults at retry, model-chosen excludes

**Wiki Visualization**:
A read-only, deterministically derived presentation of one Published Wiki for human browsing of pages and their cross-link graph; optional beside publication, not the Wiki itself and not the Wiki Run operator surface.
_Avoid_: knowledge graph, product web app, Staging Wiki, model transcript, run dashboard

## Reading older ADRs

ADRs before [0019](docs/adr/0019-prefer-run-boundary-over-host.md) may say **Host** for what is now **Run Boundary**, and **Host Instructions** for **Run Instructions**. Map those phrases; do not reintroduce `okf_wiki.host` or `Host*` APIs.
