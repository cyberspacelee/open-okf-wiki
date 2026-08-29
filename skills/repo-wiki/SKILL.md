---
name: repo-wiki
description: Generate or refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wiki, architecture maps, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from frozen Source revisions and selected database
catalogs. `scripts/okf.py` owns Run state, validation and Publication; never
edit `.okf-wiki` state by hand. Requires Git, Python 3.12+ and `uv`.

Run commands from the Workspace root. `<skill>` is this directory; `okf` means:

    uv run <skill>/scripts/okf.py

## Resume first

1. Run `okf run status --json`.
2. If a Run exists, execute its `next_actions`. Disk state and persisted
   checkpoints win over conversation memory.
3. Otherwise initialize the Workspace, register every Source, and start:

       okf workspace init --lang en --freshness-days 90
       okf source add link ../service --name service
       okf run start --producer repo-wiki/<model> --session <unique-id>

Drive the Run through Publication. Stop only for a real human dependency such
as credentials or ambiguous Source selection.

## Lifecycle

Capture, Index, binding and Publication are deterministic. Agent work has only
the Target kinds `plan`, `page` and `review`:

    plan:workspace
      -> review:plan
      -> page:research/<unit-id>*
      -> page:compose
      -> review:composition
      -> page:write/<page-id>*
      -> review:<page-id>*
      -> deterministic bind and approve

There are no per-Source Plan shards. Assign `plan:workspace` to one
long-lifecycle planner that owns the cross-Source mental model. It may use
focused evidence workers for bounded searches, call paths or database facts,
but those workers return evidence and gaps only; they do not create competing
plans or page paths.

`run status --json` exposes the Ready Set. Independent research or write
Targets may run concurrently. For each ready Target:

    okf task start <target-id> --json

Read the returned `reference`, `contract` and typed `inputs`; a write or write
review also reads its exact `template`. Use only packet scopes and the bounded
`outline`, `search` and `read` commands. Write to the attempt-specific
`artifact`, then run `complete_command`.

For long work, write the packet's `checkpoint` Markdown with the exact headings
`Completed`, `Findings`, `Hypotheses`, `Gaps` and `Next actions`, then run
`checkpoint_command`. Plan and composition cannot complete without a current
checkpoint. On failure the checkpoint remains on disk and the retry packet
includes it as `previous_checkpoint`; resume from it instead of rescanning.

Recover a lost packet only with:

    okf task packet <target-id> --attempt <token> --json

On rejection, repair the same Attempt Artifact. On an unrecoverable worker
failure run `okf task fail <target-id> --reason <short-reason>`. Handoffs contain
only paths, gate verdicts, counts and blockers, never artifact bodies.

## Index and navigation

Index builds a complete canonical directory tree in the deterministic kernel
and emits a compact visible projection. A maximal directory chain is one line
when intermediate nodes have no direct files and one child. Full deepest paths
remain visible. Build modules, source sets, branch nodes and direct-file nodes
stop compaction. `compressed` counts structural folding; `truncated` means the
byte budget coarsened the projection. Use `outline` to expand either case.

The Index is navigation, not semantic ranking. Maven modules, source roots and
package clusters are not automatic Wiki pages.

## Knowledge planning

The planner reads every Source Index and Catalog index, navigates all relevant
Sources and writes a Markdown Knowledge Plan. Its small YAML frontmatter lists
stable knowledge units with kind, owner, question, scopes and one to three
opened evidence seeds. The body records cross-Source understanding, lifecycle
relationships, decisions, gaps and rejected hypotheses.

The Plan answers what knowledge must be covered. It must not choose Wiki page
paths, titles, hierarchy, diagrams or page dependencies. `review:plan`
independently checks domain recall, boundaries, evidence and gaps before
research fan-out.

Each `page:research/<unit-id>` deepens one unit into a Knowledge Dossier. A
dossier is `ready`, or `split` with two to eight child units inside its parent
scope. Split is for an incoherent research boundary, not length or package
count. The State Gate creates child research Targets dynamically and waits for
all active leaves.

## Composition and writing

`page:compose` reads the complete dossier set and is the first Target allowed
to define pages. Its Markdown Composition Map assigns every active unit to
exactly one stable `page_id`, selects page type and representation, defines
hierarchy and dependencies by ID, and proposes final paths. IDs, paths and the
two relation graphs are unique and independently acyclic. `parent` defines
information architecture only. `depends_on` defines scheduling and names the
reviewed pages a synthesis writer consumes.

`review:composition` checks coverage and may request `split`, `merge` or `move`.
Only after approval do writers run. A writer works at
`drafts/pages/<page-id>.md`; its Target identity never contains the final path.
Reviews for every page in `depends_on` unlock the synthesis writer.

Use standard Markdown reference links for logical page links:

    See [request recovery][request-recovery].

Do not add a reference definition. The deterministic binder resolves known
page IDs to root-relative final paths after all page reviews. An unknown ID
fails binding. A path-only move therefore preserves the page draft and its
content review.

Every page reopens Source evidence for load-bearing claims. Dossiers and child
pages are synthesis inputs, not provenance. Implement planned Mermaid diagrams
with matching ID/kind, accessibility title and description, and an adjacent
cited conclusion. Use honest partial coverage with a Gaps section when needed.

## Review and Publication

When a review first becomes ready, bind a distinct session:

    okf review start --actor repo-wiki/<reviewer> --session <new-session> --json

Review reports remain small strict JSON because they control state transitions.
They bind the exact subject digest. Content repair reopens the write Target;
structural `split`, `merge` or `move` reopens `page:compose`; missing knowledge
may reopen an exact research Target or `plan:workspace`. Two consecutive change
rounds pause the Run for an explicit resume decision.

When all Targets complete, the kernel binds IDs to paths, validates the exact
Candidate and marks the Run approved. Then run:

    okf publication publish

Publication writes reserved `index.md` and `log.md`, installs an immutable
content-addressed generation and atomically switches the current pointer.
Human verification is separate from Machine-confirmed review.

Optional source-facing proposals run only after Publication:

    okf propose start --json
    okf propose complete --json
