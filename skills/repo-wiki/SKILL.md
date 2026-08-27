---
name: repo-wiki
description: Generate or incrementally refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wiki, architecture map, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from frozen Git revisions and selected PostgreSQL
catalogs. `scripts/okf.py` owns all state, validation and publication — never
edit `.okf-wiki` JSON by hand. Requires Git, Python 3.12+ and `uv` on PATH.

Run every command from the workspace root. `<skill>` is this directory; the
short form `okf` below always means:

    uv run <skill>/scripts/okf.py

`okf --help` and `okf <command> --help` document every command.

## Start here — on entry, resume, or any uncertainty

1. Run `okf run status --json`.
2. If a run exists, perform exactly its `next_actions`. Disk state wins over
   conversation memory; completed tasks are immutable unless review reopens
   them.
3. If there is no workspace: `okf workspace init --lang en|zh
   --freshness-days 90`, register every Source explicitly (next section),
   then `okf run start --producer repo-wiki/<model> --session <unique-id>`.

Drive the run to publication without pausing for permission: the gates are
the checkpoints, and a rejected completion is a repair task, not a question
for the user. Stop and ask only when something genuinely needs a human —
missing credentials, an ambiguous source selection, or a review verdict a
human must ratify.

## Sources

Add each Source explicitly before starting a run:

    okf source add link ../API --name API
    okf source add clone https://host/web.git --name web --ref main
    okf source add postgres --name appdb --url-env DATABASE_URL --schema public --table orders --table customers

`link` accepts any local Git worktree; targets outside the workspace are
mounted automatically under `.okf-wiki/sources/<name>` (symlink on POSIX,
junction on Windows). `clone` fetches a URL to the same place. Use `okf db
tables` / `okf db describe` to choose PostgreSQL tables — only selected
tables become evidence, and credentials never enter state or citations.

`run start` records each Git Source's clean HEAD. Dirty worktrees, submodules
and non-portable paths are rejected, and every later gate rejects revision
drift, so citations always resolve from the recorded commit.

## The task loop

A run is a fixed phase sequence: survey → synthesize (multi-Git only) → plan
→ write → derive → review → publish. `run start` creates one survey task per
Git source with a CLI-computed scope — there is no separate inspect step.
`run status` lists the current phase's tasks; task ids are `<phase>:<name>`
(e.g. `survey:api`, `write:overview.md`). For each task:

    okf task start <phase>:<name> --json    # returns a dispatch packet
    # dispatch ONE worker session with the packet (paths, never pasted content)
    okf task complete <phase>:<name>        # validates the artifact; advances on success

If completion is rejected, relay the issue list to the same worker as a
repair task and complete again. Never mark work done yourself — the gate is
the only authority. If a worker returns artifact content instead of writing
the file, treat the task as failed and redispatch; the coordinator never
writes an artifact on a worker's behalf.

## Coordinator and workers

The coordinator (this session) must stay small enough to steer a long run,
so it never reads source files, drafts, candidate pages or Wiki bodies. It
consumes only: `run status --json`, `task start` dispatch packets, worker
handoffs, and validator issue lists. Every content task runs in a worker
session. If workers are unavailable, stop the run and say
so; the coordinator taking over content work defeats the design.

What goes where:

- **Long-form content** (concept pages, proposals): the worker writes
  Markdown directly to the packet's `artifact` path. It never travels
  through JSON or chat.
- **Structured decisions** (survey, synthesize, plan, review): small
  JSON artifacts at the `artifact` path, shaped per the phase reference and
  hard-capped by the gate (e.g. 16 findings, 24 KiB per survey) so no single
  file outgrows what a model can produce reliably.
- **Worker → coordinator handoff**: at most 10 lines / 2 KiB — the artifact
  path, item ids when the reference asks for them, and a gap count. Never
  artifact bodies.

Each phase reference (`references/<phase>.md`, named in the dispatch packet)
tells the worker what to read, do, write and return. Read it before working.

The plan phase assigns every finding exactly once; page count follows the
Grep Test (see `references/contract.md`), not a quota. Unchanged pages from
the previous publication are reused automatically when their plan entry,
cited Git blobs and `stale_after` all still hold.

## Review, publish, verify

Review runs in a fresh session, never the producer's:

    okf review start --actor repo-wiki/<reviewer> --session <new-session> --json
    # dispatch the review packet to a fresh worker; it writes report.json
    okf review submit --report <packet report path>

Approval stamps pages `machine-confirmed`. Then:

    okf publication publish            # immutable generation + atomic pointer switch
    okf publication export --to wiki   # optional Git-managed copy
    okf publication rollback           # switch back to the previous generation

Reserved `index.md` and `log.md` are generated by publish — never author them.
After a human actually inspects pages, record it as a new generation:

    okf publication verify --actor human:<identity> --page overview.md
