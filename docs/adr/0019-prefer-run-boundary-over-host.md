# Prefer “Run Boundary” over “Host” in product language

The trusted execution boundary for one Wiki Run—freezing the Repository Snapshot Set and Producer Skill, mount permissions, credentials and budgets, mechanical validation, staging, and atomic publication—is the product’s **Run Boundary**. Product language, documentation, and code identifiers use this name (and related terms: **Run Instructions**, **run-owned** / **boundary-owned**, **RunValidationError**, **RunReadiness**, **WikiReviewer**).

**Host** appears only as a historical word in ADRs written before this decision; read those as Run Boundary unless they clearly mean a machine, OS, HTTP host, VS Code Agent Host, or a DeepAgents “host agent.” The implementation package is **`okf_wiki.run`** only. There is no `okf_wiki.host` package and no `Host*` type/function aliases in code.

This decision does not change ADR 0006 (Python stays a thin product layer over the Pydantic AI harness), Session vs Wiki Run (ADR 0018), or portable filesystem publication (ADR 0017). It only renames the boundary role so it is not confused with host OS, agent hosts, or main/host agents in multi-agent frameworks.

_Avoid as synonyms for Run Boundary_: host OS, Agent Host, host agent, HTTP host, harness (the harness is pydantic-ai-harness capabilities, not this product package).
