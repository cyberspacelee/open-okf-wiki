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

**Page Plan**:
The bounded Workspace decision that assigns concept paths, owners, routing
metadata, Page Scopes, evidence seeds and child dependencies.
_Avoid_: Suggested outline, plan shard

**Plan Review**:
Independent verification of domain recall, concept boundaries and routing,
bound to one exact Page Plan before page work is released.
_Avoid_: Schema validation, page review, planning retry

**Page DAG**:
The dependency graph of planned pages in which Machine-confirmed children
unlock parent synthesis pages.
_Avoid_: Phase pipeline, directory tree

**Candidate**:
The exact concept page tree produced by one Run before reserved files and
Publication metadata are generated.
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
Replacement of one Source's Pin and Revision followed by invalidation of
pages whose Page Scopes use it and their dependent parents.
_Avoid_: New Run, follow branch
