# Repository Wiki Producer

A skill-driven producer of a Thin Wiki over a hub Workspace whose children are
registered Sources.

## Language

**Workspace**:
The hub that owns Sources, Runs and one current Publication. It is not a Source.
_Avoid_: worktree, sidecar

**Source**:
A registered Git repository, files directory or selected database input used as
Run evidence.
_Avoid_: Workspace, live input

**Revision**:
The immutable Git commit or files content identity that fixes one Source's
evidence for a Run.
_Avoid_: mutable worktree state, live HEAD

**Pin**:
The frozen Source tree at a Run's Revision.
_Avoid_: live worktree, clone

**Catalog**:
A content-addressed description of explicitly selected database tables captured
for a Run.
_Avoid_: database dump, Git Revision

**Run**:
One resumable generation through planning, writing, bundle review and
Publication. Its internal storage ID is never supplied by the agent.
_Avoid_: conversation, agent session, Target queue

**Artifact Loop**:
The host cycle that reads status, performs the derived next work, repairs every
validation or review issue and repeats until published or externally blocked.
_Avoid_: Target DAG, phase cursor that permits premature exit

**Living Artifact**:
A fixed Markdown or JSON file overwritten as understanding improves. Plan,
progress, Composition, drafts and review survive context compression directly.
_Avoid_: Attempt Artifact, checkpoint history

**Handoff**:
A bounded worker result naming Artifact paths, counts, gaps and blockers without
repeating bodies.
_Avoid_: transcript, random execution ID

**Index**:
A deterministic structural account of a Pin exposed through bounded outlines
and evidence queries.
_Avoid_: Wiki index, semantic importance ranking

**Page Scope**:
One Source paired with relative paths that a Knowledge Unit may investigate and
cite.
_Avoid_: package task, inventory

**Knowledge Plan**:
The living cross-Source analysis defining stable Knowledge Units, scopes, seeds
and gaps without choosing Wiki pages or paths. It may be empty only when its
gaps explain why no knowledge passes the Grep Test.
_Avoid_: page tree, Source shard

**Knowledge Unit**:
A stable capability, lifecycle, flow, data model, integration or operations
question requiring evidence-backed coverage.
_Avoid_: package, page, execution task

**Evidence Note**:
Optional bounded Markdown from a focused worker. Its findings are merged into
Plan or pages; it is never provenance or scheduler state.
_Avoid_: dossier Target, competing Plan

**Composition Map**:
The global information-architecture decision assigning every Knowledge Unit to
one stable Page ID, representation and final path. An empty Plan has an empty
Composition and produces no placeholder page.
_Avoid_: Plan, parent DAG, writer schedule

**Page ID**:
A stable logical identity used for drafts and logical links before final paths
are bound.
_Avoid_: Markdown path, Target identity

**Page Type**:
The closed semantic class selected by the reader question: Overview,
Architecture, Domain, Flow, Lifecycle, DataModel or Table.
_Avoid_: arbitrary template name

**Diagram Spec**:
A Composition decision naming one page-local visual question by stable ID and
kind.
_Avoid_: diagram body, rendered sidecar

**Wiki Review**:
Independent verification of the complete Candidate plus Plan and Composition,
bound to their exact combined digest. It may request repair, split, merge or
move and is rerun after every change.
_Avoid_: schema validation, per-page approval

**Candidate**:
The exact page tree produced by deterministic Page-ID-to-path binding before
Publication metadata is generated.
_Avoid_: draft directory, Publication

**Publication**:
An immutable content-addressed OKF bundle selected by an atomic current pointer.
_Avoid_: Candidate, export

**Export**:
A recoverable physical copy of the current Publication.
_Avoid_: authoritative Publication

**Thin Wiki**:
A routing layer for knowledge expensive to reconstruct, bounded by the Grep
Test rather than file or directory coverage.
_Avoid_: Source mirror, API reference

**Locator**:
A plain Source-relative evidence path with an optional line range, bound to the
Run Revision or captured Catalog.
_Avoid_: live path, URI scheme

**Machine-confirmed**:
Trust recorded after an independent Wiki review approves the exact bundle.
_Avoid_: human-reviewed, self-review

**Human-reviewed**:
Verification explicitly added by a named human to selected published concepts.
_Avoid_: agent approval

**Proposal**:
A post-Publication draft for source-facing onboarding or vocabulary that
requires human ratification and never blocks Publication.
_Avoid_: applied change, Wiki Artifact
