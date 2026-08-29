---
name: repo-wiki
description: Generate or refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wikis, architecture maps, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from frozen Source revisions. Python owns Capture,
Index, validation, late binding and Publication. The host agent owns planning,
subagents and the loop. Requires Git, Python 3.12+ and `uv`.

Run commands from the Workspace root. `<skill>` is this directory; `okf` means:

    uv run <skill>/scripts/okf.py

## Resume

Run `okf run status --json`. If no Run exists, initialize, register every
Source, then start without supplying an ID:

    okf workspace init --lang en --freshness-days 90
    okf source add link ../service --name service
    okf run start

Disk Artifacts are authoritative after restart or context compression:

    work/plan.md
    work/progress.md
    work/evidence/
    work/composition.md
    work/drafts/<page-id>.md
    work/review.json

These are logical names inside the current Run. Always use the absolute paths
returned in `status.artifacts`; never construct or pass the internal Run ID.

## Coordinator loop

Repeat until `status` is `published` or `blocked`:

1. Run `okf run status --json`.
2. Execute its `next_actions` and repair every reported error.
3. Dispatch independent evidence, page and review work when available; merge
   path-only handoffs into the fixed Artifacts.
4. Run status again. Missing work, rejected review and validation errors are
   loop inputs, never stopping conditions.

Use `okf run block --reason <external-dependency>` only for credentials,
ambiguous Source selection or another real external dependency. Resume with
`okf run resume`.

## Plan

Read [references/plan.md](references/plan.md) and
[references/contract.md](references/contract.md). One long-lived planner owns
the cross-Source model and continuously overwrites `work/plan.md`. For a long
run it also keeps `work/progress.md` current before context compression and
after merging worker results.

Dispatch focused evidence subagents for independent Source investigations,
call paths, database facts or unresolved hypotheses. They write bounded notes
under `work/evidence/` and return paths plus gaps. They do not write separate
Plans or choose Wiki pages. A Source count alone is not a reason to create one
worker per Source.

Navigate frozen evidence with:

    okf evidence outline . --source service --json
    okf evidence search "literal" --source service --path src --json
    okf evidence read service/src/App.java#L20-L80 --json

Plan is complete when status advances to `write` with no Plan issues.
If no knowledge passes the Grep Test, write an empty `units` list and explain
the exclusion in `gaps`; this is a valid reviewed and published empty Wiki.

## Write

Read [references/composition.md](references/composition.md). The planner or one
composer turns the completed knowledge units into `work/composition.md`.
Composition is the first Artifact that defines page IDs, titles and physical
paths. It assigns every knowledge unit exactly once and carries no scheduler or
hierarchy graph; the final path is the published hierarchy.

Then read [references/page.md](references/page.md) and dispatch one writer per
independent page when useful. Each writer receives the Plan, Composition,
relevant evidence-note paths, the matching template under `assets/templates/`
and its fixed output `work/drafts/<page-id>.md`. Writers reopen frozen Source
evidence for load-bearing claims. Status derives missing and invalid drafts
directly from Composition.

Use `[label][page-id]` without a definition for logical page links. The kernel
binds known IDs to final paths; unknown IDs fail review preparation.

## Review and publish

Run `okf review prepare --json`. It validates all work, binds the exact
Candidate and returns one fixed review packet. Dispatch that packet to a fresh,
independent reviewer; the producing context must not review its own work. The
reviewer reads [references/review.md](references/review.md) and writes
`work/review.json`.

When the packet includes `previous_review`, the reviewer reads that fixed
Artifact before overwriting it with the follow-up verdict.

Run `okf review complete --json`. `changes_requested` returns to the coordinator
loop: repair the named Plan, Composition or page files, prepare a new Candidate
and review the complete bundle again. Structural `split`, `merge` and `move`
changes belong in Composition. There is no review-round limit.

After approval, status returns `publication publish`. Run it, then verify:

    okf publication publish
    okf validate --published

Publication installs an immutable content-addressed generation and atomically
switches the current pointer. Optional source-facing proposals run afterward:

    okf propose start --json
    okf propose complete --json
