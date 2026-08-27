# Repository Wiki Producer

A skill-driven producer of a thin, evidence-anchored Wiki over a hub
Workspace whose children are registered Sources.

## Language

**Workspace**:
The hub directory that owns `workspace.json`, registered Sources as direct
children, Runs and one current Publication. It is not itself a Source.
_Avoid_: Source, worktree, sidecar

**Source**:
A registered Git repository, files directory or selected OpenGauss input
used as Run evidence. Git and files Sources occupy `<workspace>/<name>/`.
_Avoid_: Workspace, live input

**Revision**:
The immutable Git commit that identifies one Git Source's evidence for a Run.
_Avoid_: Snapshot, mutable worktree state, live HEAD

**Pin**:
The detached Git worktree or copied files tree at a Run's recorded Revision,
which workers read. The live Source tree may move independently.
_Avoid_: live worktree, clone

**Catalog**:
A content-addressed description of explicitly selected OpenGauss tables
captured for a Run.
_Avoid_: Database dump, Git Revision

**Run**:
One resumable generation attempt under '.okf-wiki/runs/<id>', owned by a
producer session until approval, publication or abandonment.
_Avoid_: Conversation, Publication

**Target**:
One validated unit of phase work with a fixed artifact path and retry state.
_Avoid_: Page (unless it is a write Target)

**Handoff**:
A bounded worker result that names artifacts written to disk without repeating
their bodies in coordinator context.
_Avoid_: Transcript, Artifact body

**State Gate**:
The CLI-owned transition boundary that validates a Target artifact before
completion and phase advancement.
_Avoid_: Self-reported completion

**Compose Gate**:
The CLI-owned fan-in after every plan shard completes: it unions shards,
checks global finding and connection coverage, then spawns write Targets.
_Avoid_: compose worker, plan:wiki

**Candidate**:
The exact concept page tree produced by one Run before reserved files and
publication metadata are generated.
_Avoid_: wiki export, Publication

**Publication**:
An immutable content-addressed OKF bundle under publication/generations,
selected by the atomic current.json pointer.
_Avoid_: wiki directory

**Export**:
A recoverable physical copy of the current Publication, normally wiki/, for
source control or tools that cannot follow the generation pointer.
_Avoid_: Atomic publication

**Thin Wiki**:
A routing layer for knowledge expensive to reconstruct, bounded by the Grep
Test rather than file or directory coverage.
_Avoid_: Source mirror, API reference

**Locator**:
A claim anchor to Revision, Pin or Catalog evidence: a plain source-relative
path with an optional line range, e.g. 'src/service/UserService.java#L42-L68'.
Contract files live on a files Source and use the same shape.
_Avoid_: Live path, custom URI scheme, URL

**Connection**:
A multi-participant, evidence-backed boundary between Sources, with a contract
summary, optional contract locators and failure propagation.
_Avoid_: pairwise link, Finding

**Page Plan**:
The composed mapping from findings and connections to portable concept paths,
owners and exclusions. It is assembled by the Compose Gate from plan shards.
_Avoid_: Suggested outline, single plan.json

**Plan shard**:
One Source-owned page list (`plan:<source>`) or the workspace-owned page list
(`plan:workspace`). Reuse and review reopen act at shard grain.
_Avoid_: Page Plan (the composed object)

**Machine-confirmed**:
Verification recorded by an independent agent review batch.
_Avoid_: Human-reviewed

**Human-reviewed**:
Verification explicitly added by a named human to selected published concepts.
_Avoid_: Agent approval

**Review batch**:
One review Target covering Candidate pages of a single owner (a Source or
workspace).
_Avoid_: single-session verdict

**Proposal**:
A post-publication Run artifact for a source-facing AGENTS managed block,
CONTEXT terms or ADR stub that requires human ratification. It is not a Wiki
phase and does not block publication.
_Avoid_: Applied change, derive phase

**Refresh**:
Replace one Source's Pin and recorded Revision, rebuild its Index and Triage,
then rebuild all downstream derived phases.
_Avoid_: abandon the Run, follow branch

**Index**:
A bounded CLI-authored structural summary of one Pin, consumed by its Triage
Target. It contains no semantic importance score.
_Avoid_: repo map, semantic index

**Triage**:
One Source-owned Target that assigns every eligible file exactly once to a
`deep`, `standard` or `inventory` scope.
_Avoid_: workspace triage, survey split

**Coverage Ledger**:
The inventory scopes retained in Triage as proof of structural coverage;
they create neither Findings nor survey Targets.
_Avoid_: inventory Finding, source mirror

**Evidence Cache**:
A disposable Pin-bound JSON projection of validated Finding locators and
source windows, derived by the kernel after Survey completion.
_Avoid_: Evidence pack, canonical artifact
