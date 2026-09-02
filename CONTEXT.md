# Repository Wiki Producer

A skill-driven producer of an evidence-anchored Domain Wiki over a hub Workspace
whose children are registered Sources.

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
A content-addressed OpenGauss schema description captured for a Run. It is the
primary evidence for the physical structure of covered persistent Concepts.
_Avoid_: database dump, Git Revision

**Source Area**:
A deterministic code or file region classified in the Plan as domain-owned,
shared, test, generated or excluded. Together, Source Areas close Source
coverage without mirroring packages into pages.
_Avoid_: Knowledge Unit, page folder

**Domain**:
A stable business responsibility with explicit boundaries and Concepts. It may
span Sources and packages.
_Avoid_: Source, module, table prefix

**Concept**:
A domain noun with defined meaning, ownership and, when persistent, one data
model owner.
_Avoid_: class, table, generic term

**Model Basis**:
The evidence mode selected per Concept: `opengauss` for Catalog-backed physical
structure, `code` for a logical model recovered from frozen code, or `none` for
a non-persistent Concept.
_Avoid_: Workspace-wide database mode, confidence score

**Table Disposition**:
The Plan's one-time classification of every captured OpenGauss table, recording
its role, owning Domain and Concepts or a concrete coverage Gap.
_Avoid_: page assignment, name-prefix guess

**Physical Relationship**:
A relationship declared by captured OpenGauss constraints, including ordered
composite keys, cardinality and optionality derived by the kernel.
_Avoid_: ORM association, naming inference

**Logical Relationship**:
A relationship recovered from code evidence and recorded separately from the
physical model with its evidence basis.
_Avoid_: undeclared database constraint, Mermaid line-style confidence

**Navigation Index**:
A generated `index.md` view of the Candidate or Publication page hierarchy.
It routes readers and is distinct from the structural Source Index.
_Avoid_: Index, manually authored overview

**Run**:
One resumable generation through planning, writing, bundle review and
Publication. Its internal storage ID is never supplied by the agent.
_Avoid_: conversation, agent session, Target queue

**Run Policy**:
The immutable evidence and agent-resource limits captured from Workspace
configuration when a Run starts and published with its result.
_Avoid_: environment tuning, worker override, scheduler state

**Rolling Window**:
The host scheduling rule that refills one freed child slot immediately while
respecting one Run-wide active-child limit.
_Avoid_: fixed batch barrier, unbounded fan-out

**Artifact Loop**:
The host cycle that reads status, performs the derived next work, repairs every
validation or review issue and repeats until published or externally blocked.
_Avoid_: Target DAG, phase cursor that permits premature exit

**Fixed Artifact**:
A Markdown or JSON file at a stable path, overwritten as understanding improves.
Plan, progress, Composition, the derived Reference Map, drafts and review survive
context compression directly.
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
The evolving cross-Source analysis whose coverage ledger defines Source Areas,
Domains, Concepts, table dispositions and relationships before defining stable
Knowledge Units, scopes, seeds and gaps. It does not choose Wiki paths.
_Avoid_: page tree, Source shard

**Knowledge Unit**:
A stable capability, lifecycle, flow, data model, integration or operations
question requiring evidence-backed coverage.
_Avoid_: package, page, execution task

**Evidence Note**:
Optional bounded Markdown from a focused worker. Its findings are merged into
Plan or pages; it is normally limited to one Source, except for an explicitly
cross-Source handoff question, and is never provenance or scheduler state.
_Avoid_: dossier Target, competing Plan

**Composition Map**:
The global information-architecture decision assigning every Knowledge Unit to
one stable Page ID, representation and final path, plus deterministic reference
roots for captured Catalogs.
_Avoid_: Plan, parent DAG, writer schedule

**Reference Root**:
A Composition path under which the kernel generates one Schema page and the
captured tables' Table pages for an OpenGauss Source.
_Avoid_: authored page, database connection

**Reference Map**:
A read-only derived Artifact mapping every generated Schema and Table Page ID to
its final path, type, Source and table before page writing begins.
_Avoid_: Composition input, naming convention

**Task Routing Test**:
A page-boundary check requiring one concrete maintenance change or failure
question to lead to one cohesive page.
_Avoid_: one unit per page, smallest page count

**Merge Probe**:
A review record comparing nearby Knowledge Units or pages and deciding whether
they remain independently useful. Every routed item participates in one when
more than one item exists.
_Avoid_: issue count, page-count target

**Page ID**:
A stable logical identity used for drafts and logical links before final paths
are bound.
_Avoid_: Markdown path, Target identity

**Page Type**:
The closed semantic class selected by the reader question: Overview,
Architecture, Domain, Concept, Procedure, Flow, Lifecycle, DataModel, Schema or
Table. Procedure owns an internal algorithm or orchestration; Flow owns an
end-to-end handoff; Schema and Table are deterministic reference pages.
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

**Domain Wiki**:
A routing and explanation layer whose mandatory coverage closes Source Areas,
Domains, Concepts and captured tables while avoiding Source mirroring.
_Avoid_: minimal page set, API dump

**Grep Test**:
The admission check for optional depth pages such as Procedure, Flow and
Lifecycle. It never excludes mandatory Domain, Concept, DataModel, Schema or
Table coverage.
_Avoid_: coverage gate, page-count target

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
