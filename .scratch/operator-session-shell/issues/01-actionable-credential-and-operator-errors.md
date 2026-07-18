# 01 — Actionable credential and operator errors

**What to build:** When credentials are missing or a provider fails for an operator-safe reason, the product explains what to fix (secret-redacted) instead of collapsing to a generic withheld message; optional doctor-style credential presence checks help operators see what is set.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] Missing required provider credentials for the configured model fail fast with an actionable, secret-safe message and non-zero exit.
- [x] Clean provider/env failure messages are not reduced solely by exception-type allowlisting to a single withheld string after redaction.
- [x] Live secret values never appear in CLI error JSON, stderr, or diagnostics text.
- [x] Config/Host validation errors remain field-level and readable where already operator-safe.
- [x] Optional doctor (subcommand or Session slash later) reports credential keys as set/unset with redacted previews and source hints.
- [x] Tests cover missing-key / credential-class failures and redaction at the diagnostics seam.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (spec operator-session-shell).
- 2026-07-18: Implemented ticket 01.
  - `safe_error_message`: redact known secrets, surface message; withhold only when residual secret-like markers remain (no exception-type allowlist gate).
  - Preflight in `WikiRunApplication.run` for `openai:` / `openai-chat:` / `openai-responses:` when `OPENAI_API_KEY` missing (unless `OPENAI_BASE_URL` set for local gateways) → `ConfigError` pointing at `.env` / `OPENAI_API_KEY`.
  - `okf-wiki doctor` subcommand: credential keys set/unset with length/source preview (no raw secrets); stderr human summary + JSON stdout.
  - Package: `okf_wiki/diagnostics/` (`preflight.py`, `doctor.py`, re-exports).
  - Tests: `tests/test_errors.py`, `tests/test_diagnostics.py`, CLI coverage in `tests/test_run_cli.py`.
  - Verified: `uv run --locked pytest tests/test_errors.py tests/test_provider_env.py tests/test_diagnostics.py -q` (and `tests/test_run_cli.py`).
