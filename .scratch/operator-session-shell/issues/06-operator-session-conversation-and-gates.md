# 06 — Operator Session: conversation, cards, gates, Needs Input

**What to build:** Default TTY entry is an Operator Session conversation: stream simplified analysis cards, present HITL publish approve/deny, close Needs Input by starting a new Wiki Run with explicit answers, and support essential slash controls—without making raw `clai` the product.

**Blocked by:** 01 — Actionable credential and operator errors; 02 — HITL publish: approve path; 03 — HITL publish: deny keeps Staging; 04 — Wiki Reviewer before publish; 05 — Context capabilities on every agent

**Status:** completed

- [x] Interactive TTY default enters Operator Session (not silent one-shot-only); non-TTY / print automation path remains usable.
- [x] Agent progress is driven by framework stream/iter events plus Host events into L1 simplified cards (no CoT dump, secrets redacted).
- [x] Publish gate UI/API supports approve and deny consistent with tickets 02–03; YOLO indicator when active.
- [x] Needs Input presents questions, collects answers, and starts a **new** Wiki Run with `explicit_answers` (does not resume the prior Semantic Workflow).
- [x] Essential slash or equivalent: at least yolo toggle, doctor/diagnostics, quit/exit; usage optional if cheap.
- [x] Primary tests target the Operator Session API / view-model seam; only thin non-TTY checks for the adapter—not Rich escape codes.
- [x] Missing credentials at Session entry use ticket 01 diagnostics.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (Session-first product shell).
- 2026-07-18: Implemented Operator Session API under `okf_wiki/session/`; `okf-wiki tui` is the Session entry. Multi-turn natural-language "ask" is stubbed as history + fresh Wiki Run (full conversation Agent.iter deferred). Tests in `tests/test_session.py`. Full suite green.

## Implementation notes

### Primary seam: `okf_wiki/session/`
- `cards.py` — `SessionCard` view model + `project_event(s)` from Host `WikiRunEvent` (secret-redacted L1 labels).
- `runtime.py` — `OperatorSession`: message history, YOLO flag, Wiki Run jobs via `WikiRunApplication` + observer + `publication_approval_handler`, Needs Input → new Run with `explicit_answers`, slash `/yolo` `/doctor` `/quit` `/help`.
- `interactive.py` — TTY prompt loop adapter (Rich line print + `input()`).
- `tty.py` — `require_tty` (shared with `tui`).

### CLI
- `okf-wiki tui` uses Session API; supports `--yes`/`--yolo`; non-TTY rejected.
- `okf-wiki wiki-run` JSON automation unchanged.

### Documented stub
- Full multi-turn conversation agent (Agent.iter) is not required for this ticket; operator goals are recorded in Session history and each goal starts a fresh Host Wiki Run from config.
