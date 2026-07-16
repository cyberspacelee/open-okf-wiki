# 02 — Ship Bounded Adaptive Wiki Orchestration

**What to build:** Large or multi-domain Wiki Runs can use Planning, compaction, and a bounded recursive Root → Domain → Leaf research tree while small runs remain single-Agent; all branches reduce through validated receipts and Root remains the only Wiki writer.

**Blocked by:** 01 — Establish Observable Wiki Run and Receipt Infrastructure

**Status:** ready-for-agent

- [ ] Small-scope runs complete without delegation and do not incur adaptive fan-out by default.
- [ ] Root and Domain Agents maintain the Run Plan, retain goals and evidence gaps after compaction, and use bounded oversized-output handling.
- [ ] The Host constructs an explicit trusted Agent roster and enforces maximum depth two, Root/Domain fan-out limits, child concurrency, per-child budgets/timeouts, whole-tree envelope reservations, and source/Skill/Wiki mount permissions.
- [ ] Root can delegate a self-contained Domain task; Domain can optionally delegate Leaf tasks; children publish receipts and return only bounded Handoff Refs while Root performs cross-domain synthesis and final publication.
- [ ] Critical `partial`/`failed` branches receive only the configured bounded retry/fallback and cannot satisfy completion; unresolved load-bearing evidence preserves the previous Published Wiki.
- [ ] A homogeneous Domain → Leaf fan-out/reduce may use one non-nested DynamicWorkflow with typed reduction; nested DynamicWorkflow and unbounded recursion fail closed.
- [ ] Content-free instrumentation/events report depth, fan-out, usage, concurrency, receipt size, compaction, and terminal status without exposing prompts or source content.
- [ ] Deterministic end-to-end tests cover single-Agent, Root → Domain, Root → Domain → Leaf, budget/depth/concurrency limits, single-writer permissions, receipt reduction, partial failure, and optional DynamicWorkflow behavior.
