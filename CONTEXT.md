# Repository Wiki Producer

## Language

**Workspace**:
The directory that owns source registration, Runs and one current Publication.
_Avoid_: Source, worktree

**Source**:
A registered clean Git repository or selected PostgreSQL catalog used as Run
evidence.
_Avoid_: Workspace, live input

**Snapshot**:
An immutable content-addressed copy of one Source captured at Run start. Git
Snapshots bind a commit and per-file hashes; database Snapshots contain only
selected tables.
_Avoid_: Clone, cache

**Run**:
One resumable generation attempt under '.okf-wiki/runs/<id>', owned by a
producer session until approval, publication or abandonment.
_Avoid_: Conversation, Publication

**Target**:
One validated unit of phase work with a fixed artifact path and retry state.
_Avoid_: Page (unless it is a write Target)

**State Gate**:
The CLI-owned transition boundary that validates a Target artifact before
completion and phase advancement.
_Avoid_: Self-reported completion

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
A claim anchor to frozen evidence. Concepts use
'okf-source://source/commit/path#Lx-Ly'.
_Avoid_: Live path

**Page Plan**:
The complete mapping from findings and connections to portable concept paths,
owners and exclusions. It is the boundary for page-level incremental reuse.
_Avoid_: Suggested outline

**Machine-confirmed**:
Verification recorded by an independent agent review session.
_Avoid_: Human-reviewed

**Human-reviewed**:
Verification explicitly added by a named human to selected published concepts.
_Avoid_: Agent approval

**Proposal**:
A Run artifact for a source-facing AGENTS managed block, CONTEXT terms or ADR
stub that requires human ratification.
_Avoid_: Applied change
