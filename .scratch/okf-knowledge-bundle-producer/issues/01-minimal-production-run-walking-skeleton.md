# 01 — Build the minimal Production Run walking skeleton

**What to build:** A user can run one fixed-revision Markdown repository through `build`, inspect its status, check a staged minimal OKF Bundle, approve or reject Review Required, and publish atomically. The semantic result may use a deterministic fixture in this slice, but the complete Production Run path must be real.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A Producer Project can identify one Git repository and exact revision for a Production Run.
- [ ] The Python 3.14 project uses `pyproject.toml`, `.python-version`, and a committed `uv.lock`; CI fails if `uv lock --check` or `uv sync --locked` detects drift.
- [ ] pytest, `ruff check .`, and `ruff format --check .` are required CI gates; exact-pinned `ty 0.0.58` is available as a non-required advisory check.
- [ ] `build` creates durable Production Run state and a transactional Run Event history in SQLite.
- [ ] The run advances through preparation, rendering, checking, and Review Required without relying on model conversation state.
- [ ] A minimal conformant staged Bundle contains reserved files, an overview, and a coverage report.
- [ ] `status` and `check` expose machine-readable success and failure without mutating the run.
- [ ] Approving Review Required performs final checks and atomically publishes the complete Bundle.
- [ ] Rejecting, failing, or cancelling a run leaves any previously published Bundle unchanged.
- [ ] End-to-end tests exercise this behavior through the Production Run seam.
