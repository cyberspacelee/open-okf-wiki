# Prefer “Run Boundary” over “Host” in product language

**Status:** accepted  
**Date:** (historical naming decision; still in force)  
**Does not change:** portable filesystem publication ([ADR 0017](0017-portable-host-filesystem-and-directory-rename-publication.md)); Session vs Wiki Run ([ADR 0018](0018-operator-session-hitl-publication.md), refined by [ADR 0024](0024-session-as-conversational-workspace.md)).

## Decision

The trusted execution boundary for one Wiki Run—freezing the Repository Snapshot Set and Producer Skill, mount permissions, credentials and budgets, mechanical validation, staging, and atomic publication—is the product’s **Run Boundary**. Product language, documentation, and code identifiers use this name (and related terms: **Run Instructions**, **run-owned** / **boundary-owned**, **RunValidationError**, **RunReadiness**, **WikiReviewer**).

**Host** appears only as a historical word in ADRs written before this decision; read those as Run Boundary unless they clearly mean a machine, OS, HTTP host, VS Code Agent Host, or a DeepAgents “host agent.”

## Implementation (current)

- **Package:** `@okf-wiki/core` (TypeScript monorepo). There is no `okf_wiki.host` / `okf_wiki.run` Python package and no `Host*` type/function aliases in product code.
- **Historical note:** An earlier draft of this ADR said “Python stays a thin product layer” and named `okf_wiki.run`. That product layer is **retired** ([ADR 0021](0021-retire-python-primary-path.md)); the **naming** decision (Run Boundary, not Host) remains.

_Avoid as synonyms for Run Boundary_: host OS, Agent Host, host agent, HTTP host, harness (framework capabilities, not this product package).
