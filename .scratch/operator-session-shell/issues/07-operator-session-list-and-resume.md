# 07 — Operator Session: multi-session list and resume (minimal)

**What to build:** Operators can create, list, and resume multiple Operator Sessions with persisted conversation history (prefer harness StepPersistence), without treating Session resume as Semantic Workflow or Staging publication resume.

**Blocked by:** 06 — Operator Session: conversation, cards, gates, Needs Input

**Status:** completed

- [x] Operator can start a new Session without destroying project Host config.
- [x] Operator can list Sessions for the project (minimal metadata: id, updated time, status/title if available).
- [x] Operator can resume a Session and continue multi-turn history.
- [x] Persistence prefers pydantic-ai-harness StepPersistence (or equivalent official store)—no second checkpoint protocol for graph resume.
- [x] Resuming a Session never marks Staging as Published or resumes a half-finished Wiki Run graph; Wiki Runs remain new bounded jobs / Manual Retry semantics.
- [x] Tests cover create → list → resume history with fakes at the Session seam.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (minimal multi-session).
- 2026-07-18: Implemented ticket 07.
  - **Store:** `okf_wiki/session/store.py` — file-based `SessionStore` under project-local `.okf-wiki/sessions/` (`create_session` / `list_sessions` / `load_session` / `resume_session` + `SessionSnapshot` / `SessionSummary`).
  - **Why not StepPersistence:** harness `StepPersistence` is an Agent capability for provider-valid `ModelMessage` snapshots + tool-effect ledger / `continue_run` of a single agent investigation. Operator Session multi-session continuity is metadata + lightweight `SessionMessage` history across Host Wiki Runs (each a new bounded job). Ticket 06 stubs conversation `Agent.iter`, so there is no conversation Agent to attach StepPersistence to without inventing a second “resume” meaning that looks like graph resume. Documented in `store.py` module docstring; StepPersistence can attach later to a conversation Agent without replacing this Session index.
  - **Runtime:** `OperatorSession` gains `store`, `session_id`, `to_snapshot` / `apply_snapshot` / `persist` / `start_new_session` / `resume_from_store`. Resume restores history + YOLO flag only; clears cards / last Host result; never publishes.
  - **Slash:** `/sessions`, `/new`, `/resume <id|prefix>` (prefix match). Interactive loop defaults to `SessionStore(default_sessions_dir())`.
  - **Tests:** `tests/test_session.py` — create→list→resume history; resume does not auto-publish / write run records; `/new` leaves Host config intact; slash list/resume.
  - Verified: `uv run --locked pytest tests/ -q --ignore=tests/test_package_release.py` green.
