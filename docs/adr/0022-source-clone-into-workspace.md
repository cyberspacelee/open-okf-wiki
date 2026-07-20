# Allow operator-initiated git clone into Workspace

**Status:** accepted  
**Date:** 2026-07-19  
**Supersedes (partial):** ADR 0020 decision §6 “Git sources: existing local checkouts only; no remote clone”

## Context

Workspace `rootPath` is the operator project home and agent working directory. Sources are multi-root: they may live outside `rootPath` (linked checkouts) or inside it (materialized clones). Requiring every repo to be cloned manually outside the product is friction for Windows-first local use.

## Decision

1. **Link existing path** remains the primary, zero-network path: register an absolute local Git working tree (may be outside `rootPath`).
2. **Clone into workspace** is an explicit operator action: the product runs host `git clone` into `{rootPath}/sources/{sourceId}` (path-contained), then registers the absolute path with `origin: { type: "clone", remoteUrl, … }`.
3. Clone/fetch is **never** performed by the Semantic Workflow agent or unrestricted shell tools.
4. Credentials use the host git credential helper / SSH agent only; secrets are **not** stored in `workspace.json`.
5. Wiki Runs still freeze local revisions via probe; no implicit pull before each run.

## Consequences

- Sources UI offers both “Link existing” and “Clone into workspace”.
- Agent source tools continue to map `sourceId → absolute path` and do not assume sources live under cwd.
- ADR 0020’s sandbox/path-policy and “no agent network git” posture remain.
