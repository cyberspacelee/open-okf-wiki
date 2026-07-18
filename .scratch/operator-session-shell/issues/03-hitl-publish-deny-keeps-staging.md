# 03 — HITL publish: deny keeps Staging

**What to build:** When the operator declines publication, the Published Wiki is unchanged, Staging is retained for further Session work, and the Wiki Run Record records declined publication—not success and not a generic cancel/fail.

**Blocked by:** 02 — HITL publish: approve path

**Status:** completed

- [x] Deny publication leaves the Published Wiki byte-identical to its pre-run (or pre-attempt) state.
- [x] Staging Wiki content from the run remains available after deny.
- [x] Wiki Run Record status is `publication_declined` (or the agreed enum string from the spec).
- [x] Operator Session / caller can continue work against retained Staging without treating the run as published.
- [x] Tests cover deny path: staging kept, published unchanged, correct Record status.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (grill: deny keeps Staging).

## Answer

### Design choice

Deny is a first-class resolution of the Host deferred `publish_wiki` approval (same gate as ticket 02).

When `resolve_publication_approval` returns `denied` (handler supplies `ToolDenied` or bare `False` for the pending approval — helpers `build_deny_results` / `build_approve_results`):

1. Host does **not** call `_publish_wiki`
2. Staging Wiki is left intact (no cleanup)
3. Published Wiki is never opened for write
4. Wiki Run Record terminal status + `publication` payload are both `publication_declined` / `{status: publication_declined, changed: false}`
5. Observer emits `publication_declined` (not `run_succeeded` / `publication_*`)

Approve path unchanged (`build_approve_results` / YOLO / `approve_all`).

### Files changed

- `src/okf_wiki/publication_gate.py` — `build_approve_results`, `build_deny_results`, deny docs
- `src/okf_wiki/wiki_run.py` — denied branch sets `publication_declined` publication status; Staging retained
- `tests/test_publication_gate.py` — deny via ToolDenied, False, async handler
- `tests/test_wiki_run.py` — integration: deny keeps staging + published identity; False deny; approve still publishes
