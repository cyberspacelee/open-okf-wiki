# Knowledge planning, composition and late path binding

Status: accepted

Supersedes the lifecycle contracts in ADR 0015, ADR 0016 and ADR 0017. It does
not change OKF version 0.2 and has no compatibility or migration path.

## Context

The previous contract used per-Source Brief Targets, one JSON Page Plan and
`page:<path>` identities. It mixed four decisions too early: domain coverage,
page admission, information architecture and physical storage. Small planning
shards produced local recall without a durable cross-Source model; large
natural-language JSON caused avoidable schema repair; changing a path deleted
the logical Target identity and its dependency edges.

Index also constructed a compact record set and then recreated every missing
ancestor while rendering, so Java package chains were not actually compact.

Primary-source research is recorded in
`docs/research/repo-wiki-planning-and-late-binding-best-practices.md`. Relevant
precedents are VS Code compact folders, Markdown plus schema-validated YAML
frontmatter, durable agent checkpoints, DITA key-based addressing and stable
DAG keys.

## Decision

Index builds the complete canonical directory shape in memory and emits a
visible projection. Maximal single-child chains compact to their deepest full
path. Build modules, source sets, branches and direct-file directories are
semantic anchors. Structural `compressed_dirs` and budget `truncated_dirs` are
separate metrics.

One long-lifecycle `plan:workspace` owns the whole cross-Source Knowledge Plan.
There are no per-Source Plan Targets. Focused workers may gather evidence but
cannot own Plan fragments. Plan and composition Attempts require a persisted
Markdown checkpoint with completed work, findings, hypotheses, gaps and next
actions. A failed Attempt's checkpoint is an input to its retry.

Knowledge Plan, Knowledge Dossier and Composition Map are Markdown bodies with
small schema-validated YAML frontmatter. Review remains strict JSON because it
directly controls the state machine. The new Target graph is:

    plan:workspace
      -> review:plan
      -> page:research/<unit-id>*
      -> page:compose
      -> review:composition
      -> page:write/<page-id>*
      -> review:<page-id>*
      -> deterministic bind

Knowledge Plan owns what knowledge requires coverage and does not name Wiki
pages. Dossiers deepen one stable unit and may dynamically split only inside
the parent scope. Composition owns global split, merge, hierarchy,
representation and proposed paths after all active dossier leaves complete.

Page Targets, dependencies, reviews and internal links use stable page IDs.
Writers store drafts under `drafts/pages/<page-id>.md` and use Markdown
reference links `[label][page-id]`. After every review completes, the kernel
resolves IDs against the approved Composition Map, writes the Candidate tree
at final paths and validates it. A path-only move preserves the draft and its
content review.

Run contract is `knowledge-composition-late-bind`. Existing Run state is
rejected. `source-plan.md`, Source Brief models and path-keyed Page Plan models
are removed rather than retained behind compatibility branches.

## Consequences

Planning has one durable owner and can recover after context compression
without rescanning. Domain analysis, information architecture and storage each
have a distinct gate. Page moves no longer destroy logical identity. The
kernel and evals must validate dynamic dossier expansion, exact unit coverage,
stable-ID DAGs, logical link binding and checkpoints.

The lifecycle has an additional composition artifact and review. This is
intentional: it is the first point with enough evidence to make global page
split, merge and move decisions.
