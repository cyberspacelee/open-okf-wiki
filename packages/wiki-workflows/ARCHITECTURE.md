# Wiki Producer architecture

Canonical language lives in [CONTEXT.md](../../CONTEXT.md). Run isolation and persistence decisions are recorded in [ADR-0001](../../docs/adr/0001-isolated-full-generation-runs.md) and [ADR-0002](../../docs/adr/0002-recoverable-snapshot-transactions.md).

## External seam

`createProductionWikiProducer()` returns the deep production module. Callers start one independent Run and consume live `{ event, view }` updates:

```ts
const run = await producer.start({ cwd, focus });
for await (const { event, view } of run.updates()) render(event, view);
await run.control("pause");
await run.control("resume");
const result = await run.result();
```

`view()` is a point query. `updates()` is a live hub: each value is the current Run view plus a notify-worthy lifecycle fact when one happened. There is no retained event log and no catch-up by sequence. The overlay keeps the latest view. The root package export contains only this caller surface; CLI and Pi adapters use explicit subpaths.

## Run isolation

Every Run reads Workspace settings once, pins the resolved Sources, model choices, generation profile, language, and budgets, then prepares a fresh empty Candidate. The Published Wiki and final WikiSpec are provenance only. They never seed pages, topology, or model context.

One Workspace admits one non-terminal Run. A durable Workspace claim enforces that rule across producer instances and processes; a separate attempt lease fences execution of the active Run and permits stale-owner recovery. Different Workspaces may run concurrently. Pause preserves the Candidate, artifacts, exact Pi sessions, and pinned settings. The complete materialized production-skill tree is durably copied and digested into the Run plan; resume verifies that exact digest before reopening the pinned sessions and re-inspects Sources. Source or skill drift fails the Run. A new Run is always a full generation.

## Production module

The implementation owns fixed deterministic gates around one dynamic Lead loop:

```text
claim Workspace -> pin settings and Sources -> create empty Candidate
  -> Lead research/write/review -> deterministic validation
  -> recoverable publication -> terminal cleanup
```

Inspection, Candidate preparation, validation, publication, lifecycle persistence, and cleanup are fixed Wiki implementation, not adapters. `WikiLeadRun` owns the dynamic Lead loop (WikiSpec, Board, waves, Candidate, review, Publication Seal). Pi is a session adapter under `src/pi/` (`createAgentSession`, compaction, provider retry, `followUp`, abort, path-guarded tools, session observer). Tests inject `runLead` or `createAgents` on the already-opened `WikiLeadRun`. The Lead chooses research scope, fan-out, and follow-up questions without exposing a workflow language. The host derives source-local write waves bottom-up (concept → domain → source page → root); root is the only cross-source assignment. Artifact identity is `contractId` (the delegate contract id). One `inspectHandoff` accepts or rejects research/write/review work files.

Pages sit beside their concept. There are no type-bucket directories.

```text
wiki/
  index.md                 # host
  overview.md
  architecture.md          # optional
  <domain>/
    index.md
    domain.md
    <concept>/
      concept.md
      models.md / flows.md / sequences.md / states.md / data.md / modules.md
```

A Cluster is the dispatch unit: root overview (and optional architecture), one domain page, or the evidence-backed pages under one concept. The host projects remaining work to `.okf-wiki/runs/<id>/board.md` and exposes it to the Lead as `.okf-wiki/current/board.md`. The Lead reads that board after compaction and before dispatch or finish.

The Lead may write directly only for a one-domain Spec with at most three content pages and no compaction. Otherwise writers are delegated per cluster. Review is always independent. Research is delegated only when the scope needs parallel coverage or the Lead cannot cover it.

`repository-wiki-producer` is the only model-facing host skill. Production `wiki-production/SKILL.md` is the Lead Pi skill. Worker roles are Pi skills from `briefs/*.md` with the same skill `baseDir`. Templates stay on-demand references under that directory.

## Candidate and review

Candidate page replacement, Page Revision advancement, Review Assignment capture, and review acceptance belong to one deep module. A write is canonicalized and validated before replacement and review invalidation commit together. Reviewers receive exact read-only paths and durable revision identity. A receipt is accepted only while its assignment matches the current WikiSpec and Page Revisions. Publication fails closed on missing, stale, or `changes_requested` coverage.

Indexes are deterministic projections. Final governance issues an opaque Publication Seal bound to the Run, current execution authority, canonical Candidate root, complete tree digest, page set, and final WikiSpec. The publication store re-verifies that seal immediately before the Candidate rename; callers cannot supply page or Spec metadata independently. A Workspace publication lease serializes publish, reconcile, candidate preparation, and provenance reads across store instances and processes, waits for a live owner, and reclaims a dead owner. Publication retains its rename journal because installing `wiki/` has a filesystem lifetime separate from Run state. On recovery, the store reconciles that journal before Candidate preparation and projects a committed publication directly into the Run terminal transition, closing the crash window between install and Run commit. After that terminal transition is durable, acknowledgement moves the active journal into an immutable per-Run audit archive so historical journals never participate in recovery of a later Published Wiki.

## Durable Run state

Lifecycle and Lead facts live in `run.json` format 3. Progress is a projection of those facts plus live tails. The pinned plan is `plan.json`. Files under `agents/` are tails only. There is no event log and no ledger. Live `updates()` is an in-memory hub of the current view. Publication still uses `publish.json` because installing `wiki/` has a different filesystem lifetime. Atomic file replace uses the platform `rename`; Windows `MoveFileEx` lock windows (`EPERM`/`EACCES`/`EBUSY`, read-only attribute) are absorbed inside the durable-files module so a successful `writeText`/`renamePath` remains durable.

The current Run format is 3; anything else fails closed. Opening another format reports an actionable compatibility error; a human preserves needed evidence and removes stale `.okf-wiki` Run state. Automatic cleanup applies only to transient data of a successfully published current-version Run. Published provenance remains durable. The Published Wiki is independent. The root package factory (`src/production.ts`) returns `WikiProducer` without leaking Pi types into the public declaration graph; CLI and the Pi extension import `production-run` explicitly.

## Observability

Observability is a projection, never a control plane. One pure semantic module interprets the strict event variants plus status, stage, health, liveness, activity, tone, marker, context pressure, and batch progress. Events have typed variant fields rather than an extensible data bag. CLI, live footer/widget, and overlay are media adapters over those semantics; the overlay does not depend on CLI rendering. They never reduce events into independent state.

The overlay and Pi stream consume `updates()`, so a live fact is never rendered with a separately queried stale view. The overlay keeps the latest view and accepts the terminal update before its stream ends. Agent inspection is a point query; there is no run-level activity log.

## Failure ownership

Pi owns one Agent model loop, persistent session, compaction, provider/turn retry, cancellation, usage observation, and tool execution. Wiki classifies the session's terminal outcome into a Task Receipt or a durable pause (`quota` / `usage_limit`). There is no wiki-level fresh-session retry for 429/5xx/network. Authentication, billing, schema, validation, hard quota, and usage-limit failures fail or durably pause.

The current publication format is 1; anything else fails closed. Every new publication writes version 1 with the source fingerprint, summary, sealed WikiSpec, page set, and final tree digest. The journal binds that complete canonical metadata with its own digest, and reconciliation requires exact equality with current provenance. Publication journals, audit acknowledgement, active markers, artifact blobs and manifests, production-skill snapshots, and cleanup use fsynced file and directory transitions so recovery knowledge or a returned receipt is durable before the next lifecycle step.

Successful publication removes transient Candidate, transaction, session, finalization preimage, and materialized skill data. Content-addressed artifact blobs, their per-Run manifest, task receipts, Run state, published provenance, and acknowledged publication audit remain as durable evidence. Failed, paused, and cancelled Runs retain their recovery material. Cleanup failure is explicit and does not rewrite a successful publication as failed.
