# 06 — Evaluate the single-Agent Wiki producer

**What to build:** A product maintainer can run a repeatable evaluation over representative repositories and decide from measured Wiki quality, cost, and latency whether the single-Agent design is sufficient.

**Blocked by:** 02 — Validate and atomically publish a Wiki; 03 — Version and fork the Producer Skill; 04 — Refresh a Published Wiki; 05 — Harden untrusted source and side-effect boundaries.

**Status:** ready-for-agent

- [ ] Select at least two or three representative small, medium, and large repositories, including structurally different codebases.
- [ ] Run each case through the same public Wiki Run seam used in production rather than a role-specific evaluation path.
- [ ] Record the exact Repository Snapshot, Producer Skill digest, model identity, limits, output digest, cost, and latency for each case.
- [ ] Evaluate factual grounding, unsupported statements, useful topic coverage, navigation, duplication, page organization, citation quality, and reader usefulness.
- [ ] Repeat representative runs to measure material stability without requiring identical prose.
- [ ] Keep deterministic fixture tests and live-model evaluation separate so normal CI does not require credentials.
- [ ] Produce a human-reviewable report containing failures, trade-offs, and representative generated pages or summaries.
- [ ] Establish explicit evidence for retaining the single-Agent design or opening a later capability ticket.
- [ ] Do not add SubAgents, DynamicWorkflow, custom orchestration, compaction, or durable execution in this ticket.
- [ ] Any proposed capability must identify a repeatable measured failure and a success metric that the existing design does not meet.
