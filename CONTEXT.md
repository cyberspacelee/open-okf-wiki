# Repository Wiki Producer

A skill-driven producer of a Thin Wiki over a hub Workspace whose children
are registered Sources.

## Language

**Workspace**:
The hub that owns registered Sources, Runs and one current Publication. It is
not itself a Source.
_Avoid_: Source, worktree, sidecar

**Source**:
A registered Git repository, files directory or selected OpenGauss input used
as Run evidence.
_Avoid_: Workspace, live input

**Revision**:
The immutable Git commit or files content identity that fixes one Source's
evidence for a Run.
_Avoid_: Snapshot, mutable worktree state, live HEAD

**Pin**:
The frozen Source tree at a Run's recorded Revision that workers read while
the live Source may move independently.
_Avoid_: live worktree, clone

**Catalog**:
A content-addressed description of explicitly selected database tables
captured for a Run.
_Avoid_: Database dump, Git Revision

**Run**:
One resumable generation attempt owned by a producer session until approval,
Publication or abandonment.
_Avoid_: Conversation, Publication

**Target**:
One retryable agent task of kind `plan`, `page` or `review`, released when its
dependencies are satisfied.
_Avoid_: Phase, worker session

**Attempt Artifact**:
Worker output for one Target attempt that becomes canonical only after its
State Gate accepts it.
_Avoid_: Candidate page, completed artifact

**Handoff**:
A bounded worker result that names disk artifacts and gate outcomes without
repeating their bodies.
_Avoid_: Transcript, artifact body

**State Gate**:
The CLI-owned transition that validates and promotes an Attempt Artifact,
then recalculates downstream readiness.
_Avoid_: Self-reported completion, phase gate

**Ready Set**:
All pending or failed Targets in a Run whose declared dependencies are
satisfied.
_Avoid_: Current phase, task queue

**Index**:
A deterministic structural account of a Pin exposed to workers through
bounded hierarchical views and queries.
_Avoid_: Wiki index, semantic importance ranking

**Page Scope**:
One registered Source paired with relative paths that a planned page may
investigate and cite; a page carries one or more entries as `scopes`.
_Avoid_: Package task, file inventory

**Knowledge Plan**:
The durable Workspace analysis that defines stable knowledge units, evidence
scopes, seeds and gaps without choosing Wiki pages or paths.
_Avoid_: Page tree, Source shard, file inventory

**Knowledge Unit**:
A stable, evidence-seeded capability, lifecycle, flow, data model, integration
or operations question that requires one bounded research pass.
_Avoid_: Package, planned page, directory row

**Knowledge Dossier**:
The Markdown evidence analysis for one Knowledge Unit. It is ready for global
composition or splits into bounded child units inside the parent scope.
_Avoid_: Wiki page, Source summary, transcript

**Composition Map**:
The global information-architecture decision that assigns active Knowledge
Units to stable page IDs, hierarchy, relations, representation and proposed
publication paths.
_Avoid_: Knowledge Plan, page body, directory tree

**Page ID**:
A stable logical identity used by Targets and page relations independently of
the page's current publication path.
_Avoid_: Markdown path, title, Target artifact path

**Page Type**:
The closed semantic class of a planned concept page, selected by the reader
question the page answers.
_Avoid_: Template name, arbitrary frontmatter label

**Diagram Spec**:
A Composition Map decision naming one page-local visual question by stable id
and kind; the page supplies its evidence-backed expression.
_Avoid_: Diagram body, rendered image, graph sidecar

**Representation Test**:
The admission check that chooses prose, table or diagram according to which
form minimizes reconstruction of an admitted relationship.
_Avoid_: Mermaid quota, visual decoration

**Plan Review**:
Independent verification of domain recall, Knowledge Unit boundaries and
evidence, bound to one exact Knowledge Plan before dossier work is released.
_Avoid_: Composition Review, schema validation, planning retry

**Composition Review**:
Independent verification of coverage, split, merge, move, hierarchy and
representation before page writing is released.
_Avoid_: Plan Review, page content review

**Page DAG**:
The stable-ID `depends_on` graph in which Machine-confirmed dependency pages
unlock synthesis pages; it is separate from the `parent` information-
architecture hierarchy and physical paths are bound later.
_Avoid_: Phase pipeline, directory tree

**Candidate**:
The exact page tree produced by deterministic ID-to-path binding after all
content reviews and before Publication metadata is generated.
_Avoid_: Wiki export, Publication

**Publication**:
An immutable content-addressed OKF bundle selected by an atomic current
pointer.
_Avoid_: Candidate, wiki directory

**Export**:
A recoverable physical copy of the current Publication for source control or
tools that cannot follow its pointer.
_Avoid_: Publication, atomic publication

**Thin Wiki**:
A routing layer for knowledge expensive to reconstruct, bounded by the Grep
Test rather than file or directory coverage.
_Avoid_: Source mirror, API reference

**Locator**:
A plain Source-relative evidence path with an optional line range, bound to a
Run's Revision, Pin or Catalog.
_Avoid_: Live path, custom URI scheme, URL

**Machine-confirmed**:
Verification recorded by an independent page review bound to the exact page
digest.
_Avoid_: Human-reviewed, batch approval

**Human-reviewed**:
Verification explicitly added by a named human to selected published
concepts.
_Avoid_: Agent approval, Machine-confirmed

**Proposal**:
A post-Publication draft for source-facing onboarding or project vocabulary
that requires human ratification and never blocks Publication.
_Avoid_: Applied change, Wiki Target

**Refresh**:
Replacement of one Source's Pin and Revision followed by reopening the durable
Knowledge Plan and rebuilding evidence-dependent downstream Targets.
_Avoid_: New Run, follow branch

**Checkpoint**:
A bounded Markdown Attempt record of completed analysis, findings, hypotheses,
gaps and next actions used to resume after compaction or worker failure.
_Avoid_: Conversation summary, artifact body, State file
