---
name: repo-wiki
description: Generate or incrementally refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wiki, architecture map, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from frozen Git revisions and selected OpenGauss
catalogs. `scripts/okf.py` owns Run state, validation and Publication; never
edit `.okf-wiki` state by hand. Requires Git, Python 3.12+ and `uv` on PATH.

Run every command from the Workspace root. `<skill>` is this directory; the
short form `okf` below means:

    uv run <skill>/scripts/okf.py

Use `okf --help` and `okf <command> --help` for the current command contract.

## Start here

On entry, resume or uncertainty:

1. Run `okf run status --json`.
2. If a Run exists, perform its `next_actions`. Disk state wins over
   conversation memory; a completed Target changes only through State Gate
   invalidation.
3. If there is no Workspace, run `okf workspace init --lang en|zh
   --freshness-days 90`, register every Source explicitly, then run
   `okf run start --producer repo-wiki/<model> --session <unique-id>`.

Drive the Run to Publication. A rejected completion is a worker repair, not a
reason to bypass the gate. Stop only for a genuine human dependency such as
missing credentials or ambiguous Source selection.

Legacy phase-based Runs are not migrated. Start a new Run against the
registered Sources; the OKF version stays unchanged.

## Sources

Register each Source before starting a Run:

    okf source add link ../API --name API
    okf source add clone https://host/web.git --name web --ref main
    okf source add files ../contracts --name contracts
    okf source add opengauss --name appdb --url-env DATABASE_URL --schema public --table orders --table customers

The Workspace is a hub, not a Source. `link` mounts an external worktree at
`<workspace>/<name>/`; `clone` places a clone there. Use `okf db tables` and
`okf db describe` before selecting database tables. Credentials never enter
Run state or citations.

`run start` records each Git/files Source Revision, materializes its Pin and
captures selected Catalogs. Workers read Pins and captured Catalog shards, not
live Sources or databases. `source refresh --name` may reopen the current
active, paused or approved Run: it replaces one Pin and Index, then
invalidates pages whose scopes use that Source and their dependent parent
pages. Unrelated branches of the Page DAG remain complete.

## Target loop

Capture and Index are deterministic setup; Publication is deterministic
finalization. Agent work has only three Target kinds:

    plan:workspace -> page:<path> -> review:<path>

There is no global phase cursor. `run status --json` returns the ready set:
every pending or failed Target whose dependencies are satisfied. Independent
branches may run concurrently. For each ready Target:

    okf task start <target-id> --json
    # dispatch one short-lived worker with the returned packet

The packet's `artifact` path is inside an attempt-specific temporary directory;
it also carries exact dependency inputs and bounded navigation commands. The
worker:

1. Reads the packet's `reference` and `references/contract.md`.
2. Uses only the named inputs, Page Scope, Pins/Catalogs and bounded
   `outline`, `search` and `read` commands.
3. Writes the Attempt Artifact at the packet's `artifact` path.
4. Runs `complete_command` from `workdir`.
5. Repairs gate issues and completes again, or runs `task fail` when the
   failure cannot be repaired inside the Target.

On success the State Gate promotes the Attempt Artifact to its canonical
plan, Candidate page or review location. On rejection it remains attempt-local
and cannot affect downstream Targets.

The worker Handoff contains only the artifact path, gate verdict, item or gap
counts requested by the reference, and any blocking reason. It never repeats
artifact bodies.

## Plan and pages

`plan:workspace` is one bounded planning Target. It navigates the Index as
`Source -> build module -> source set -> package cluster`, then writes the
smallest Page Plan that passes the Grep Test. Package clusters are navigation
scopes, not automatic Targets; the plan need not classify every file or
package.

The State Gate validates the complete Page DAG before creating page Targets.
Leaf pages research and write directly from their `scopes`. A parent page
becomes ready only after every child is Machine-confirmed, and receives those
approved child pages as inputs. Each page Target still reopens Pin or Catalog
evidence for every load-bearing claim; child pages are synthesis inputs, not
provenance.

Page boundaries are fixed by the Page Plan. Record an honest partial gap when
evidence is incomplete. A routing or ownership error belongs to plan repair,
not an invented page or dynamic split.

## Coordinator conservation

The host coordinator consumes only `run status --json`, dispatch packets,
Handoffs and validator issue lists. It does not read Pins, plan bodies,
Candidate pages or review reports. Every content Target runs in a worker
session. If workers are unavailable, use `okf run pause`; resume with
`okf run resume`.

Long-form Markdown stays on disk. Structured plan and review decisions are
bounded JSON Attempt Artifacts. Dispatch packets contain paths and counts,
never copied file bodies or whole-repository JSON. Weigh every packet field
against coordinator context.

## Review and Publication

Bind an independent review session when review Targets first become ready:

    okf review start --actor repo-wiki/<reviewer> --session <new-session> --json

Review is per page, not per owner batch. Each review Target binds the exact
page digest, reopens its Locator evidence from Pins/Catalogs and writes one
verdict. Approval stamps that page Machine-confirmed and may unlock its parent.
A page repair invalidates its review and dependent parents; plan repair applies
the new Page Plan and preserves unaffected branches.

When every required root page is Machine-confirmed, status exposes:

    okf publication publish

Publication validates the approved Candidate, writes reserved `index.md` and
`log.md`, installs an immutable content-addressed generation and atomically
switches the current pointer. Optional operations remain:

    okf publication export --to wiki
    okf publication rollback
    okf publication verify --actor human:<identity> --page overview.md

Human verification creates a new Publication generation; it is distinct from
Machine-confirmed review.

Optional source-facing proposals run only after Publication:

    okf propose start --json
    okf propose complete --json
