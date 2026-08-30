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

The Workspace root is a control directory, not a Git repository. Begin with
`okf run status --json`. Navigate registered Source content only with `okf
evidence`; use ordinary filesystem tools only on fixed work Artifact paths
returned by status. Treat `okf` as an opaque kernel: do not read its private
`scripts/_*.py` files or probe `--help` to rediscover commands documented here.
Use `status.sources` as the registered Source-name list.

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
    work/plan-review.json
    work/composition.md
    work/composition-review.json
    work/drafts/<page-id>.md
    work/review.json

These are logical names inside the current Run. Always use the absolute paths
returned in `status.artifacts`; never construct or pass the internal Run ID.

## Coordinator loop

Repeat until `status` is `published` or `blocked`:

Treat each status phase as a disclosure boundary. During Plan load only
`plan.md` and `contract.md`; load Composition, Page and bundle Review references
only after status reaches their phase. Reviewers load their packet reference in
their own context.

1. Run `okf run status --json` after restart and after an action that can change
   the derived phase; do not poll unchanged work.
2. Execute its `next_actions` and repair every reported error.
3. Dispatch independent evidence, page and review work when available; merge
   path-only handoffs into the fixed Artifacts.
4. Run status again. Missing work, rejected review and validation errors are
   loop inputs, never stopping conditions.

Replace a fixed Artifact with one write or update. Do not delete and recreate
the same path in one patch operation.

Keep at most three child agents active at once. For a larger fan-out, fill the
three slots, then dispatch the next item as soon as any slot returns; do not wait
for the slowest member of a batch. Before a new phase, close completed child
handles that will not receive follow-up work; retain only handles still needed
for targeted repair or review.
The same three-agent limit applies when reactivating handles for repairs or
follow-up: send at most three, wait for a slot, then reactivate the remainder.
Record each successful dispatch and its fixed output immediately. If a batch is
partially rejected, retry only the undispatched outputs; never respawn work
whose handle was already returned.
Use the host's child-agent dispatch directly; do not run a separate capability
pre-check or infer availability from prose. Only when the actual tool inventory
lacks dispatch, or dispatch explicitly returns unsupported, block with reason
`host-child-agents-unavailable`; do not substitute the coordinator for an
independent context. A dispatched worker or reviewer executes its assigned role
directly and never changes Run status.

Use `okf run block --reason <external-dependency>` only for credentials,
ambiguous Source selection or another real external dependency. Resume with
`okf run resume`.

## Plan

Read [references/plan.md](references/plan.md) and
[references/contract.md](references/contract.md). One long-lived planner owns
the cross-Source model and continuously overwrites `work/plan.md`. Replace the
initial `work/progress.md` note before Plan review and keep it current before
context compression and after merging worker results.

Dispatch focused evidence subagents for independent Source investigations,
call paths, database facts or unresolved hypotheses. They write bounded notes
under `work/evidence/` and return paths plus gaps. They do not write separate
Plans or choose Wiki pages. Keep each note to the findings needed by its
question, at most 12 KiB; omit inventories and command transcripts. File
existence while its worker is running is not a handoff: wait for the worker to
return the path, request any size repair on that handle, then read the final
note once. Use disjoint chunks if needed rather than overlapping rereads. A
Source count alone is not a reason to create one worker per Source. After one
top-level outline per Source, dispatch two or more independent questions before
deeper evidence navigation when those questions exist; the coordinator does
not perform their searches itself.

Inside one worker, keep `okf evidence` commands sequential. Agent fan-out is
the concurrency boundary; launching many evidence commands concurrently adds
router pressure without producing an additional independent judgment.

Evidence-note granularity does not determine Plan-unit granularity. One bounded
note may support several independently routable units; apply the Task Routing
Test in `references/plan.md` before writing the Plan instead of turning each
worker question into one umbrella unit.

After merging the first evidence batch, treat every significant registered
domain that is merely "not traced" as a residual investigation, not a Gap.
Dispatch a focused worker for it before Plan review. A Gap is valid only when
the registered revisions do not contain the needed evidence, the evidence is
outside the registered Sources, or bounded navigation establishes a concrete
unanswered boundary.

Navigate frozen evidence with:

    okf evidence outline . --source service --json
    okf evidence search "literal" --source service --path src --json
    okf evidence read service/src/App.java#L20-L80 --json

Finish Plan normalization, including scope and evidence-seed trimming, before
requesting review; any later Plan edit invalidates the digest-bound approval.
When the Plan passes deterministic validation, status returns `review plan`.
Run that exact action; do not substitute the later bundle action `review prepare`.
Its JSON stdout is the review packet, while its `artifact` field is the output
path the reviewer must replace, not a packet file to read. Dispatch the packet
verbatim to one independent reviewer; do not paraphrase the packet or retype its
digest separately. The reviewer reads
[references/plan-review.md](references/plan-review.md). The reviewer owns the
fixed `work/plan-review.json`; send repaired Plans back to the same reviewer.
For follow-up, tell the reviewer that the prior report is embedded in the new
packet as `previous_review` and that the replacement report must copy the new
packet's top-level `subject_digest`, never the nested prior digest.
Plan is complete only when that digest-bound report is approved and status
advances to Composition. Retain that reviewer handle through Composition review.
If no knowledge passes the Grep Test, write an empty `units` list and explain
the exclusion in `gaps`; this is a valid reviewed and published empty Wiki.

## Write

Read [references/composition.md](references/composition.md). The planner or one
composer turns the completed knowledge units into `work/composition.md`.
Composition is the first Artifact that defines page IDs, titles and physical
paths. It assigns every knowledge unit exactly once and carries no scheduler or
hierarchy graph; the final path is the published hierarchy.

Run `okf review composition --json` and send its packet to the retained Plan
reviewer verbatim; do not restate its digest in prose. That reviewer reads
[references/composition-review.md](references/composition-review.md) and writes
`work/composition-review.json`. Send repaired Compositions back to the same
reviewer with the new top-level digest and embedded `previous_review`. Start
page writers only after status accepts this digest-bound review.

If Composition review finds that the mapped Plan unit itself contains
independent change surfaces, repair the Plan rather than manufacturing empty or
duplicate page assignments. That invalidates Plan approval by design: repeat
Plan review, rebuild Composition, then repeat Composition review with the same
reviewer.

Then read [references/page.md](references/page.md). For two or more independent
pages, dispatch one writer per page instead of drafting them in the coordinator.
Each writer receives the Plan, Composition, relevant evidence-note paths, the
exact template under `assets/templates/<status.language>/`, its fixed output
`work/drafts/<page-id>.md` and `status.language` verbatim. There is no language
fallback; a missing locale template is a broken skill package.
Resolve these paths once from `<skill>` and `status.artifacts`, then pass those
exact strings to writers; do not reconstruct runtime paths.
For every dispatch, copy the literal Composition `pages[].id` into the output
filename. A Plan unit ID is never a draft ID unless it is also that page's
declared ID.
Never infer output language from Source text. Writers reopen frozen Source
evidence for load-bearing claims. Status derives missing and invalid drafts
directly from Composition. Send page repairs back to the original writer while
it remains available.

Use `[label][page-id]` without a definition for logical page links. The kernel
binds known IDs to final paths; unknown IDs fail review preparation.

## Review and publish

Run `okf review prepare --json`. It validates all work, binds the exact
Candidate and returns one fixed review packet. Dispatch that complete packet
verbatim to a fresh, independent reviewer; do not copy its digest into separate
prose. The producing context must not review its own work. The reviewer reads
[references/review.md](references/review.md) and writes `work/review.json`.

When the packet includes `previous_review`, send it back to the same reviewer.
Reactivate a completed reviewer through the host's follow-up operation using
the exact handle returned at dispatch; do not reconstruct that handle. Only if
a correctly addressed follow-up reports the reviewer unavailable, use one
replacement with follow-up-only scope. The reviewer reads the prior report
before replacing it in one write; reviewers do not patch the fixed JSON
incrementally or run `review complete`, status, Publication, or export commands.

Run `okf review complete --json`. On `changes_requested`, use its complete
`issues` array rather than the compact status summary. Group open issues by
their named `page_ids` and include each issue's ID, claim and resolution
verbatim in the corresponding writer follow-up; a generic "read the review"
request is not a repair packet. Repair the named Plan, Composition or page
files and prepare a new Candidate. Follow-up review verifies every prior issue
and only regressions introduced or unmasked by those repairs; it does not
restart repository-wide discovery. Structural `split`, `merge` and `move`
changes belong in Composition.

After approval, status returns `publication publish`. Run it, then verify:

    okf publication publish
    okf validate --published
    okf publication export --to wiki --json

Publication installs an immutable content-addressed generation and atomically
switches the current pointer. Optional source-facing proposals run afterward:

    okf propose start --json
    okf propose complete --json
