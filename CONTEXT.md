# Repository Wiki Producer

This context defines the language for deriving a source-grounded Markdown wiki from one or more fixed source repositories.

**Implementation note:** The live product is the TypeScript monorepo (`packages/*`: Web UI, localhost server, **Pi agent harness** (`@earendil-works/pi-*`), product WikiRunShell, `@okf-wiki/core` Run Boundary). See [ADR 0030](docs/adr/0030-pi-agent-harness-for-semantic-workflow.md) and [ADR 0021](docs/adr/0021-retire-python-primary-path.md). Terms below remain domain vocabulary; older ADRs may still name historical Python/Mastra packages.

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
_Avoid_: Pi agentDir / single-run workdir synonym, single-source assumption

**Wiki language**:
Workspace setting (`wikiLanguage`: `en` | `zh`) that directs the Semantic Workflow to write Wiki page titles and body prose in English or Simplified Chinese. Independent of the operator UI locale. Paths, code identifiers, and Source Citations stay untranslated.
_Avoid_: UI locale, provider model language default alone

**Run workdir** (implementation term only):
Per Wiki Run cwd for Pi tools: `sources/<id>/`, `skill/`, `wiki/` (staging), `analysis/`. Materialised under `.okf-wiki/runs/<runId>/`. Not the product Workspace entity.
_Avoid_: product Workspace, unrestricted host cwd

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
The trusted, versioned method-and-template bundle that teaches how a Repository Snapshot Set becomes a Wiki—investigation, page design, writing, review, and completion criteria—without owning Snapshot membership, budgets, or publication enforcement. Resolved in Agent Skills order: project `{root}/.agents/skills/<name>` → user `~/.agents/skills/<name>` (when enabled in Settings) → package-embedded `@okf-wiki/skill`. Arbitrary target-repository Skills are not auto-loaded as the Producer Skill.
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

**Produce** (also: Supervisor produce; Layer B Semantic Workflow body):
The thin Workflow shell step that owns Wiki generation work: Root → Domain → Leaf supervisor tree, living WikiRunSpec, Host review council, repair rounds, and **all business Operator Event** emissions (`data-plan-progress`, `data-progress`, `data-defects`, `data-agent-span`, `data-sources-index`, tool/text). Not the Session shell and not Run REST.
_Avoid_: Session-synthesized progress, durable-produce stub, second write path, adaptive stage machine

**Operator Event** (also: Operator timeline parts):
Pi Operator Session events + **whitelist** product SSE injects (`run_phase` / `gate` / `run_link` / thin produce summaries) that form the operator-visible trajectory. Conversation body (text/thinking/tools) is framework-owned; product injects must not invent streaming bodies. Session UI is a pure projector (ADR 0031). Contract: [docs/design/operator-event-contract.md](docs/design/operator-event-contract.md).
_Avoid_: AI SDK UIMessage dual protocol, Session-synthesized fake tools, free-text gate inference, client maps as second true source

**SessionTurn**:
The deep product module for one operator chat turn: intent/mode resolution, turn lock, start/resume param assembly, framework stream tee into Session history, and onFinish drain into Session–Run transition. Owns conversational HITL routing — not Produce semantics or business progress synthesis.
_Avoid_: Semantic Workflow body, second progress author, free-text gate parser

**WikiRunSpec** (also: living Spec; operator plan-gate payload):
The executable specification for one Wiki Run: audience, domains, intended pages with reader questions, acceptance (review rounds / blocking severities), open questions, and replan changelog. Persisted under the run analysis scratch (`spec.json`) and revised when discovery demands it.
_Avoid_: Thin path-only checklist, Todo transcript, Operator Session history as the only plan store

**Run Plan** (legacy synonym):
Older ADRs/skills may say “Run Plan”; map to **WikiRunSpec** / living Spec.
_Avoid_: Treating Run Plan as a separate durable product object

**Operator Session**:
The operator-facing **sole conversation truth surface** for one project thread (ADR 0026 / **0030** / **0031**): durable **Pi JSONL** under `{root}/.okf-wiki/pi-sessions/` (chat, tools, and parent-visible produce progress via framework tool/custom entries such as `okf.produce_progress`), live **AgentSession** events (SSE), thin product injects only (`run_link` / `run_phase` / `gate` / `plan_progress` / `defects`), plan/publish gates via product WikiRunShell, and zero or more Wiki Runs linked to that thread. Produce children are implementation-only; operator-visible produce unit = parent Session tool / parent-visible card — not a product body inject. Layers depend one way (Web→Server→Agent→Pi; Core parallel). Primary UI is the **Agent Workspace** (`/w/:id`). HITL is structured `resume_gate` commands, not free-text. Old UIMessage session files, `operator-work.json`, and trajectory body folds are wiped (no migrator).
_Avoid_: Wiki Run as the main UI, AI SDK UIMessage history, Mastra workflow snapshots, Session-synthesized fake tool trails, `agent_span`/`child_pi`/`work_unit`/`workStreams` dual body channels, empty product streaming shells

**Wiki Reviewer** / **Review council**:
Independent, read-only agent role(s) that inspect the Staging Wiki against sources and Skill review guidance. Host merges outputs into `defects.json`; Root repairs; Host **fail-closes** publish when blocking defects remain. Reviewers never write Wiki pages or publish.
_Avoid_: Optional soft review, Skill self-review alone as the only gate, open-loop receipts that do not block publish

**Wiki Run**:
One bounded attempt to derive and publish a Wiki from a Repository Snapshot Set using one exact Skill Version or Skill Fork revision; **owned by / linked from an Operator Session**. Execution mode may be interactive or background; observable trajectory still belongs on the Session. Not the operator’s home UI.
_Avoid_: Agent turn synonym, Session synonym, Production Run, second HITL center parallel to Session

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

## Reading ADRs

Index and current-stack shortlist: [docs/adr/README.md](docs/adr/README.md).

- Pre-[0019](docs/adr/0019-prefer-run-boundary-over-host.md): **Host** / **Host Instructions** → **Run Boundary** / **Run Instructions**. Do not reintroduce `okf_wiki.host` or `Host*` APIs.
- Pre-[0021](docs/adr/0021-retire-python-primary-path.md): Python / Pydantic AI harness language → TypeScript `@okf-wiki/core` (Run Boundary) + `@okf-wiki/agent` (Pi harness, ADR 0030).
- Pre-[0030](docs/adr/0030-pi-agent-harness-for-semantic-workflow.md): Mastra / AI SDK / UIMessage Session → Pi AgentSession + JSONL + WikiRunShell.
- [0020](docs/adr/0020-typescript-mastra-web-workspace.md) §6 originally forbade product clone; **operator clone** is allowed per [0022](docs/adr/0022-source-clone-into-workspace.md) (Semantic Workflow still never clones).
- Session stream / single write path: [0024](docs/adr/0024-session-as-conversational-workspace.md) + [0025](docs/adr/0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) supersede transitional Session-SSE wording in [0023](docs/adr/0023-operator-session-stream-and-plan-confirm.md).
- Operator Event emit / no-compat cleanup: [0029](docs/adr/0029-architecture-cleanup-no-compat.md) + [0031](docs/adr/0031-unidirectional-framework-first-operator-surface.md) + [operator-event contract](docs/design/operator-event-contract.md) — framework-first Session; inject whitelist; Session UI projects only; no parallel body true-sources.
