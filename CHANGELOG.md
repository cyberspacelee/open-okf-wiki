# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented here.

## [Unreleased]

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

- `scopeId` is the original workspace Source directory name. Implicit single
  Source still uses the synthetic folder `source`. Mixed-case in-flight Runs
  fail closed on resume; start a new Run.
- Citations are CommonMark source links `[label](<scopeId>/<path>#Lx)`
  with GitHub line anchors (`#Lx` or `#Lx-Ly`). Research and review
  `## Evidence` lists those links (also `[n]: url` definitions or a bare
  locator). Published pages keep GFM footnotes whose link target is that
  URL. Wiki source folders use that same scope name; domain and concept
  segments stay lowercase slugs.

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

- Added a `/wiki status` progress card, `inspect()` for task receipts and
  handoffs, `--process` compact history, TUI footer/widget, and a bordered
  status overlay that shows context stats for the selected task.
- Centralized shared status, stage, health, liveness, activity, context, and
  batch presentation semantics while keeping the Run projection limited to
  fields consumed by live surfaces.
- Replaced extensible event data bags with strict event variants and moved event
  visibility/text/tone projection into the observability module. UI adapters no
  longer depend on CLI compatibility presentation wrappers.

### Commands

- Added `/wiki init` with language, repeatable source excludes, and default
  ignore controls for explicit multi-source workspaces.
- Added `/wiki source add link` for local Git roots and `/wiki source add clone`
  for local or remote URLs, with optional source names, workspace paths and refs.
- Run commands are `/wiki [focus]`, `status [run-id] [task-id] [--process]`,
  `runs`, `pause`, `resume`, and
  `cancel`. A Git repository without `workspace.yaml` remains an implicit
  single source and needs no initialization.
