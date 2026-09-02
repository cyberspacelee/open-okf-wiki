---
name: repo-wiki
description: Generate or refresh an evidence-anchored Domain Wiki and human-reviewed onboarding proposals. Use for codebase Wikis, repository-wide architecture documentation, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run; do not use for a standalone architecture diagram.
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

Run `okf run status --json`. When it returns `run: null`, run
`okf workspace show --json`. If that succeeds, register any missing Sources and
start. If it reports an uninitialized Workspace, initialize, register every
Source, then start without supplying an ID:

    okf workspace init --lang en --freshness-days 90
    okf source add link ../service --name service
    okf run start

Use the matching registration form for another filesystem Source:

    okf source add clone https://example.test/service.git --name service --ref main
    okf source add files ../contracts --name contracts

For OpenGauss, provide an `opengauss://` URL, inspect the live schema, then
register only the selected tables:

    okf db tables --url-env DATABASE_URL --json
    okf db describe orders --url-env DATABASE_URL --json
    okf source add opengauss --name database --url-env DATABASE_URL --schema public --table orders

OpenGauss is the only supported database Source. A failed connection, server
identity check or capture blocks the Run; do not replace it with code evidence.
Without a configured database Source, the Plan recovers logical models from
frozen code evidence.

After `run start`, inspect captured database evidence without reconnecting:

    okf catalog show --json
    okf catalog describe orders --source database --json

When status reports a published or abandoned Run, `okf run start` begins a
refresh from the already registered Sources. To discard a supported active or
blocked Run, use `okf run abandon --json`; legacy state is rejected rather than
migrated.

Disk Artifacts are authoritative after restart or context compression:

    work/plan.md
    work/progress.md
    work/evidence/
    work/plan-review.json
    work/composition.md
    work/composition-review.json
    work/reference-map.json
    work/drafts/<page-id>.md
    work/review.json

These are logical names inside the current Run. Always use the absolute paths
returned in `status.artifacts`; never construct or pass the internal Run ID.

## Artifact loop

Repeat until `status.status` is `published` or `blocked`:

Treat `status.phase` as a disclosure boundary and `status.next_actions` as the
commands or repairs to execute:

| Phase | Load and act |
| --- | --- |
| `plan` | `plan.md` and `contract.md`; investigate or repair the Plan |
| `plan-review` | Run `review plan`; its reviewer loads the returned reference |
| `write` | `composition.md` for Composition work, then `page.md` for drafts |
| `composition-review` | Run `review composition`; its reviewer loads the returned reference |
| `review` | Run `review prepare` or `review complete`; its reviewer loads the returned reference |
| `repair` | The prior review and the named Plan, Composition or page Artifacts |
| `publish` | Run `publication publish` |
| `blocked` | Resolve the external dependency, then run `run resume` |
| `done` | Stop, or run `run start` when a refresh was requested |

Reviewers load the reference named in their packet in their own context.

1. Run `okf run status --json` after restart and after an action that can change
   the derived phase; do not poll unchanged work.
2. Execute its `next_actions` and repair every reported error.
3. Dispatch independent evidence, page and review work when available; merge
   path-only handoffs into the fixed Artifacts.
4. Run status again. Missing work, rejected review and validation errors are
   loop inputs, never stopping conditions.

Replace a fixed Artifact with one write or update. Do not delete and recreate
the same path in one patch operation.

Read `status.policy.agents` at the start of the loop. Only the coordinator may
spawn children. Across evidence, page, repair and review work, keep one global
rolling window no larger than `max_active_children`; a host adapter may impose a
smaller native cap. Base dispatch only on these numeric limits: use the smaller
value when both exist, or the Run value when the host exposes no numeric cap.
Fill the window, then dispatch the next pending item as soon as any child becomes
terminal; do not wait for the slowest member of a batch.
Count unique children across the Run and never exceed `max_children_per_run`.
Record that count in `work/progress.md` after every successful first dispatch;
reactivating a handle does not increase it. When the fuse is reached, merge
residual questions into existing child follow-ups or block with the remaining
work recorded in `work/progress.md`.
Before a new phase, close completed child handles that will not receive
follow-up work; retain only handles still needed for targeted repair or review.
The same window applies when reactivating handles for repairs or follow-up.
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
the cross-Source model and continuously overwrites `work/plan.md`. Its coverage
ledger closes Source Areas, Domains, Concepts and captured tables before Plan
review. Model Basis is selected per Concept, so one Plan may combine
OpenGauss-backed, code-derived and non-persistent Concepts. Replace the
initial `work/progress.md` note before Plan review and keep it current before
context compression and after merging worker results.
Do not copy unit, page or draft counts into Progress; read the derived
`status.artifact_counts` instead.

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

Inside one worker, keep evidence commands sequential. Agent fan-out is
the concurrency boundary; launching many evidence commands concurrently adds
router pressure without producing an additional independent judgment.

Evidence-note granularity does not determine Plan-unit granularity. One bounded
note may support several independently routable units; apply the maintainer
probes in `references/plan.md` before writing the Plan instead of turning each
worker question into one umbrella unit. Composition later applies the Task
Routing Test in `references/composition.md`.
Default each note to one Source and one bounded question. A cross-Source handoff
note is the exception and separates findings by Source; its locators still must
be translated into participant-complete Plan scopes.

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

Search and read limits come from `status.policy.evidence`, not per-call
overrides. When `has_more` is true, continue with the returned `next_after` or
`next_locator`; never restart the same bounded search from the beginning.

Finish Plan normalization, including scope and evidence-seed trimming, before
requesting review; any later Plan edit invalidates the digest-bound approval.
When the Plan passes deterministic validation, `next_actions` returns `review
plan`. Run that exact action; do not substitute the later bundle action `review
prepare`.
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

## Write

Read [references/composition.md](references/composition.md). The planner or one
composer turns the completed knowledge units into `work/composition.md`.
Composition is the first Artifact that defines page IDs, titles and physical
paths. It assigns every knowledge unit exactly once and one Reference Root per
OpenGauss Source; the final paths are the published hierarchy. The kernel
derives Schema and Table references from those roots.

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
read-only `status.artifacts.reference_map`,
exact template under `assets/templates/<status.language>/`, its fixed output
`work/drafts/<page-id>.md` and `status.language` verbatim. There is no language
fallback; a missing locale template is a broken skill package.
Map authored Page Types to templates as follows: `Overview` to `overview.md`,
`Architecture` to `architecture.md`, `Domain` to `domain.md`, `Concept` to
`concept.md`, `Flow` to `flow.md`, `Procedure` to `procedure.md`, `Lifecycle`
to `lifecycle.md` and `DataModel` to `data-model.md`. Schema and Table templates
belong to deterministic generation and are never writer assignments.
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
binds known IDs to final paths; generated reference IDs come only from the
Reference Map. Unknown or guessed IDs fail review preparation.

## Review and publish

Run `okf review prepare --json`. It validates all work, binds the exact
Candidate, generates OpenGauss reference pages and model blocks plus the root
and directory Navigation Indexes, and returns one fixed review packet. Dispatch
that complete packet
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
verbatim in the corresponding writer follow-up. Schema and Table IDs have no
writer draft: route their classification or placement defects to the Plan or
Composition owner, then regenerate them. A generic "read the review" request
is not a repair packet. Repair the named Plan, Composition or page files and
prepare a new Candidate. Follow-up review verifies every prior issue and only
regressions introduced or unmasked by those repairs; it does not restart
repository-wide discovery. Structural `split`, `merge` and `move` changes
belong in Composition.

After approval, `next_actions` returns `publication publish`. Run it, then
verify:

    okf publication publish
    okf validate --published
    okf publication export --to wiki --json

Publication installs an immutable content-addressed generation and atomically
switches the current pointer. Optional source-facing proposals run afterward:

    okf propose start --json

The coordinator owns this optional pass. After `propose start`, read the
returned [references/propose.md](references/propose.md), write only inside its
returned proposal directory, then run its `complete_command` (normally `okf
propose complete --json`).

Publication maintenance commands are explicit and optional:

    okf publication current --json
    okf publication verify --actor human:reviewer --page architecture.md --json
    okf publication rollback --json
    okf publication prune --keep 5 --json
