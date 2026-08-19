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
_Avoid_: Input repository, codebase

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
