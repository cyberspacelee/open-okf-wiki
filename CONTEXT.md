# Repository Wiki Production

This context turns one or more declared repository sources into an independently
reviewed repository Wiki. Control flow lives in markdown agents and the Lead
prompt; the host pins Sources, guards writes, and installs `wiki/` after OKF
validation.

## Language

**Workspace**:
The repository root that owns Wiki configuration, Sources, Runs, and one Published Wiki.
_Avoid_: Project, working directory

**Source**:
A declared Git repository whose pinned content is admissible evidence for a Run.
Citation id is the workspace directory name, or `self` when the Workspace is
the repository. Source is pin and provenance, not a Wiki knowledge directory.
_Avoid_: Input repository, codebase, Wiki folder

**Run**:
One isolated, full generation of a Wiki from pinned Sources and settings. A Run never derives content or topology from another Run.
_Avoid_: Update, refresh, regeneration

**Focus**:
Optional reader intent that prioritizes part of a Run without narrowing its required source coverage.
_Avoid_: Filter, partial generation

**Candidate**:
The private Wiki assembled by one Run before publication.
_Avoid_: Draft shared across runs, staging Wiki

**Published Wiki**:
The last successfully validated Candidate installed for a Workspace.
_Avoid_: Current Candidate, mutable Wiki

**Board**:
The host-owned Task list for one Run. It lives outside the conversation and is the source of truth for remaining work after compaction or resume.
_Avoid_: Todo list, session memory, plan file

**Task**:
A durable work item on a Board. Status and notes survive compaction and pause.
_Avoid_: Todo, checklist item, agent note

**Catalog**:
A declared Postgres schema whose table definitions are admissible evidence for a Run.
_Avoid_: Database dump, live query result, data source
