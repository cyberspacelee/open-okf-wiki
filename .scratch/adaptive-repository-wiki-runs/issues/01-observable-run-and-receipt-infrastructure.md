# 01 — Establish Observable Wiki Run and Receipt Infrastructure

**What to build:** The existing Wiki Run remains behaviorally compatible while exposing one bounded Host-owned observation and evidence handoff foundation for adaptive orchestration, retries, and the TUI.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Existing `WikiRunApplication.run(request) -> WikiRunResult`, JSON CLI output, validation, staging, and atomic publication behavior remain unchanged.
- [ ] A run can emit ordered, bounded, content-free public events with run/node identifiers and secret redaction; events are diagnostics and never completion signals.
- [ ] Every terminal run writes a bounded immutable Wiki Run Record containing exact non-secret frozen inputs, outcome, usage, retry counters, and publication status, without prompts, messages, receipts, source excerpts, or secrets.
- [ ] Analysis Workspace lifecycle is run-local and cleaned after success, failure, or cancellation unless explicit diagnostic retention is requested.
- [ ] Host-owned `publish_receipt` and `read_receipt` operations support versioned immutable JSON receipts, bounded artifacts, evidence revision/path/line/hash validation, quotas, opaque identities, and atomic publication.
- [ ] `complete`, `partial`, `failed`, and `cancelled` receipt statuses and short Handoff Refs are enforced; directory scans, file existence, lockfiles, and JSONL events cannot declare completion.
- [ ] Deterministic tests cover event redaction/order, run-record contents, receipt schema/quota/hash/path validation, atomic writes, cleanup, and unchanged existing Wiki Run behavior.
