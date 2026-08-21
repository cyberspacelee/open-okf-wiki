# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented here.

## [Unreleased]

### Breaking: knowledge-shaped Wiki tree

- Explicit Workspaces organize repository, Domain, and Concept knowledge under
  `wiki/repos/<scopeId>/`; root pages own cross-Source composition. Implicit
  Workspaces keep the compact root Domain/Concept tree, cite `self`, and must
  not create `wiki/source/` or `wiki/repos/`.
- Multi-Source Runs survey Sources in parallel, then require one read-only
  `synthesize` execution after every survey and before writing. Root
  `architecture.md` must cite every Source, and Repository Section pages may
  cite only their owning Source.
- `architecture.md` is required at wiki root and, on explicit Workspaces, at
  each `repos/<scopeId>/`. Domain-level architecture, `source.md`,
  `interfaces.md`, and `models.md` are removed.
- Template scopes are `wiki` / `repo` / `domain` / `concept`. Dual-placement
  pages use `altitudes` instead of `scope`.
- Write may batch disjoint path prefixes. The writer is injected only the
  skeletons for that prefix and must `read` cited pin files in the same
  session. Survey hints optional templates; it does not bind them.
- Publish requires a sources footnote in every non-diagram H2.

### Breaking: agent-oriented template contract

- Every template requires writer-only `instructions`; its body defines the
  exact H1, summary, and ordered non-empty H2 contract for generated pages.
- Each scope has one required anchor. Architecture and flows moved to optional
  Domain pages; models, states, data, and interfaces are optional Concept pages;
  development and runbook are optional Source pages.
- Publish rejects undeclared pages, wrong scope depth, heading drift, empty
  sections, unresolved placeholders, and missing sources on any page. Generated
  indexes use anchor titles and descriptions for every directory branch.

### Breaking: OKF v0.2 bundle

- Packaged `templates/zh` and `templates/en` are the page contract,
  selected by Workspace `language`. Companion file is `architecture.md`
  with `type: Architecture` (Title Case). Generated pages need
  `description` and `sources`; claims use `[^id]` footnotes, not
  body source links.
- Publish requires a review handoff `verdict: pass` newer than Candidate
  pages. `verified` is stamped only then (`process:open-okf-wiki-review`).
  Host writes root `log.md`. `index.md` entries include descriptions.
- `/wiki init` copies the language pack into `wiki-templates/` and sets
  `wiki.templates`. The field replaces the whole pack. Publish rejects a
  single `overview.md` and missing scope anchors.

### Handoff

- Survey and other subagent results are written under
  `.okf-wiki/runs/<id>/handoffs/` and the Lead receives the path, not the
  full body.

### Source ignores

- Default source ignores are enforced on `read` / `grep` / `find` / `ls`,
  including Java test trees (`src/test/**`, `*Test.java`).

### Board and resume

- Each Run keeps a host-owned Board (`board.json`) for the goal and Tasks.
  The Lead `todo` tool writes it. Compaction re-injects the Board. `/wiki resume`
  continues the same Candidate, Board, and Lead session.
- A Workspace admits one running or paused Run. Start a new Run only after
  success, failure, or cancel.

### Catalog

- Optional `database` in `workspace.yaml`: Postgres URL, schema, and table
  patterns. Agents list and describe matching tables; the host does not dump
  the schema into the prompt. Connections are read-only. `${ENV}` / `$ENV`
  keep secrets out of the file.

### Docs

- README matches the flattened package: no regenerate, no leftover
  `wiki.maxConcurrentAgents` / generation profile, and it documents Board
  plus Catalog.

### Packaging

- The repo is a single Pi package at the root (`extensions/wiki/`, `skills/`,
  `agents/`, `prompts/`). `packages/wiki-workflows` and the pnpm workspace are
  gone. Install with `pi install .`. Pi loads the TypeScript extension
  directly; there is no `dist/` emit.

### Source identity

- `scopeId` is the original Workspace Source directory name and keys its
  Repository Section. Implicit single Source uses internal id `self` and no
  synthetic Source folder. Mixed-case in-flight Runs fail closed on resume;
  start a new Run.
- Published citation resources are POSIX paths from the Workspace root with
  GitHub line anchors (`#Lx` or `#Lx-Ly`). Explicit Workspace paths begin
  with the Source directory; implicit paths do not add `self/`. Published
  claims use GFM footnotes keyed to `sources[].id`. Research and review
  `## Evidence` lists may use those locators as links, definitions, or bare
  locators. Domain and concept segments stay lowercase slugs.

### Lead session budget

- `wiki.sessionTimeoutSeconds` is thinking time for the Lead and wall-clock
  time for delegated sessions. Waiting in `wiki_delegate_collect` does not
  consume the Lead deadline. Collect no longer has a 1200s cap; omit
  `timeoutSeconds` to wait until the wave is terminal.

### Skills

- Research handoff `domains` is the Lead-facing inventory. The host injects
  Source identity, projects it to the board and a taxonomy.yaml draft, and
  keeps blob paths on writer briefs only. YAML `followups` remain taxonomy
  blockers; writer-facing questions stay in Gaps.
- Split the host `/wiki` skill from the production Lead skill. Each run copies
  the production skill into `.okf-wiki/runs/<id>/skill/`, injects the assigned
  role brief, and allows read-only access to templates.
- Candidate pages live in concept clusters (`<domain>/<concept>/`); type-bucket
  directories are rejected. Remaining work is projected to host-owned `board.md`.
- Lead `wiki_plan` submits a page path list. Dispatch uses Remaining cluster
  ids; collect uses the batch id shown on the board.

### Breaking architecture change

- Plan and delegate envelopes are small. WikiSpec is a Candidate page list.
  There is no migration from the previous fat Spec JSON.

- Runs are isolated full generations. Every Run starts from an empty Candidate;
  the Published Wiki and final WikiSpec are provenance only.
- `WikiRunHandle.updates()` is a live hub of the current view plus notify-worthy
  lifecycle facts. There is no retained event log.
- Version-1 Run state is incompatible and requires explicit human cleanup; it is
  never migrated or automatically deleted.

- Replaced the fixed DAG, phases, barriers, staged submission tools, node/phase
  retry, snapshot protocol, and TUI with one `WikiProducer` interface and plain
  CLI progress events. Previous run state is intentionally incompatible.
- Added a dynamic Pi Lead loop. The Lead can complete small repositories
  directly or use the single `wiki_delegate` tool for bounded research, write,
  and review tasks.
- Moved long research and review prose to content-addressed Markdown artifacts.
  Durable JSON contains only compact receipts, events, and run state.
- Made the candidate Wiki the only content truth. Page topology is derived from
  candidate Markdown for deterministic frontmatter, evidence, link, Mermaid,
  path, and symlink validation before atomic publication.

### Reliability

- Durable file replace uses the platform `rename`, then retries `EPERM` /
  `EACCES` / `EBUSY` with backoff, clears the Windows read-only attribute via
  `chmod`, and serializes in-process writers to the same path. Candidate page
  install and workspace config updates share that path. Exhausted replace
  keeps the previous file and names the source, target, and attempt count.

- Added `wiki.sessionTimeoutSeconds` so each Lead and delegated Agent session's
  wall-clock deadline is configurable; the default remains 1200 seconds.
- Added durable run ledgers, workspace-scoped run discovery, pause/resume,
  cancellation, and cross-process single-run ownership.
- Resume preserves the candidate and rejects source fingerprint drift before
  re-entering the Lead, preventing mixed-source publication.
- Disabled Pi and provider automatic retry. `WikiTaskRuntime` is the sole
  transient retry owner and permits at most one fresh session.
- Added shared 429 admission control with `Retry-After`; hard quota and usage
  limits durably pause the run, while authentication, billing, local
  schema/validation, artifact I/O, and publication I/O failures do not retry.
  Provider HTTP 400 is retried as a transient Agent failure.
- Research briefs no longer inherit the Wiki reader language. Only writer and
  reviewer prompts require Simplified Chinese or English.
- Publication continues to use a recoverable rename journal and atomic swap.
- Added an opaque, Run-bound publication seal over the final Candidate tree,
  page set, and WikiSpec. Publication re-verifies the seal immediately before
  install, reads provenance metadata v1/v2, and writes v2 only.
- Added a Workspace publication lease shared across store instances and
  processes. Recovery waits for a live publisher and reclaims only a dead
  owner; successful Run commit acknowledges the active journal into a durable
  per-Run audit archive so historical publications cannot affect later Runs.
- Publication journal v2 binds the complete canonical provenance record
  (source fingerprint, summary, WikiSpec, page set, and tree digest) with a
  metadata digest, and reconciliation rejects any field-level divergence.
- Centralized fsynced atomic write, append, exclusive active-marker, rename,
  and removal operations so ledger and publication recovery transitions make
  both file content and directory-entry changes durable.
- Artifact blobs and manifests, and every file and directory in the
  materialized production skill, are durable before their receipt or Run plan
  commits. Resume verifies the pinned complete skill-tree digest. Successful
  cleanup retains content-addressed artifacts and their Run manifest as audit
  evidence while removing the transient Candidate, sessions, transactions,
  finalization preimage, and skill snapshot.

### Observability

- TUI live chrome is a hung widget plus footer status. `/wiki status` opens a
  centered overlay: Lead and named agents, Board tasks, and the selected
  agent's tool process (running `◆`, complete `✓`, failed `✗`).
- Parallel `subagent` tasks keep distinct rows (execution id, not agent name).
  Overlay shows turns, tools, tokens, and context-window usage for the
  selected agent.
- `WikiRunHandle.subscribe` pushes the current `WikiRunView`. Each agent row
  holds a bounded in-memory tool tail (start/update/end). Nested subagent
  tools stay on that agent. `run.json` does not persist process.
- Transcript `notify` is lifecycle only (start snapshot, pause/fail/success).

### Commands

- Added `/wiki init` with language, repeatable source excludes, and default
  ignore controls for explicit multi-source workspaces.
- Added `/wiki source add link` for local Git roots and `/wiki source add clone`
  for local or remote URLs, with optional source names, workspace paths and refs.
- Run commands are `/wiki [focus]`, `status [run-id] [task-id] [--process]`,
  `runs`, `pause`, `resume`, and
  `cancel`. A Git repository without `workspace.yaml` remains an implicit
  single source and needs no initialization.
