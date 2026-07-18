# 02 — HITL publish: approve path

**What to build:** After Host validation succeeds, publication waits for approval (Pydantic AI deferred tool approval). Approving publishes atomically and records success; explicit YOLO / `--yes` auto-approves deferred publication only without disabling Host guards.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] A validated Staging Wiki does not become the Published Wiki until publication is approved (interactive) or auto-approved (YOLO / explicit non-interactive yes).
- [x] Wiki Run Record uses `awaiting_publication` while waiting for the publish decision.
- [x] On approve, publication uses existing Host atomic publish + lock semantics; Record status is `complete` for successful publish (including documented no-op refresh success).
- [x] YOLO / `--yes` maps to deferred `approve_all` (or equivalent) and still enforces validation, mounts, and publication lock.
- [x] YOLO is off by default.
- [x] Tests at the Host / Session seam cover: no publish before approve; approve publishes; YOLO auto-publishes; lock fail-closed unchanged.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (ADR 0018 HITL publish).

## Answer

### Design choice

**Host-side deferred publication gate** (`publication_gate.py`), not a model-called tool.

After Host validation of Staging (existing `Complete` output_validator) and when `summary.publication_changed` is true, the Host builds a pydantic-ai `DeferredToolRequests` approval for tool name `publish_wiki`, then resolves it via:

1. `WikiRunRequest.auto_approve_publication` / CLI `--yes`/`--yolo` → `requests.build_results(approve_all=True)` (YOLO path)
2. Optional `WikiRunApplication(publication_approval_handler=...)` → in-process approve for Session/tests
3. Else → stop with Record status `awaiting_publication` (no publish)

On approve, existing `_publish_wiki` + lock path runs unchanged. No-op refresh (`publication_changed=False`) still completes without approval. Validation/mounts/locks still run before the gate. Deny status enum is expand-only (`publication_declined`); full deny UX is ticket 03.

### Files changed

- `src/okf_wiki/publication_gate.py` (new)
- `src/okf_wiki/run_models.py` — statuses + `auto_approve_publication`
- `src/okf_wiki/run_records.py` — status type
- `src/okf_wiki/wiki_run.py` — gate after validation
- `src/okf_wiki/cli.py` — `--yes`/`--yolo` on wiki-run and wiki-retry
- `src/okf_wiki/evaluation/wiki_evaluation.py` — auto-approve eval runs
- Tests: helpers default auto-approve; new HITL + gate unit tests; package release `--yes`

### Migration for existing tests

Pass `auto_approve_publication=True` on complete runs that expect publish (helpers default True). Non-interactive CI: `okf-wiki wiki-run --yes`.
