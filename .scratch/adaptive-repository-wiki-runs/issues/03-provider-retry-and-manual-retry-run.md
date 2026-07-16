# 03 — Make Provider Failures and Manual Retry Recoverable

**What to build:** Transient provider failures are retried within a bounded transport budget, and an operator can explicitly create a fresh Manual Retry Run from a failed or cancelled Wiki Run Record without reusing stale execution state.

**Blocked by:** 01 — Establish Observable Wiki Run and Receipt Infrastructure

**Status:** ready-for-agent

- [x] HTTP `408`, `429`, `500`, `502`, `503`, `504`, transient connection/read failures, and timeout failures retry at most three total transport attempts per model request.
- [x] Stable authentication, invalid-request, and other non-transient `4xx` responses fail immediately.
- [x] Valid `Retry-After` values are honored within the configured cap; otherwise exponential backoff with bounded jitter is used, and all waits count against the Wiki Run wall-clock deadline.
- [x] Provider transport retries are independent from tool, output-validation, CodeMode, child, and whole-run retry budgets; ambiguous network retries emit a possible-duplicate marker.
- [x] Transport exhaustion fails only the current Wiki Run and writes safe retry metadata to its Wiki Run Record; it never silently restarts the whole run.
- [x] An explicit human retry action creates a new run identity, Plan, message histories, staging area, Analysis Workspace, and receipts while reusing the exact recorded snapshot revisions, Skill digest, model, limits, and explicit answers.
- [x] Retry never follows a moved branch, substitutes a missing revision/Skill/model, or reuses old messages, partial receipts, old staging, or old Plan state.
- [x] Tests cover retry predicates, `Retry-After`, backoff/caps, wall-clock exhaustion, duplicate markers, record persistence, exact-input replay, changed branch behavior, and fail-closed missing inputs.

## Comments

- 2026-07-16: Complete. `provider_retry.py` + `WikiRunRequest.from_run_record` + `okf-wiki wiki-retry`.
