# 07 — Retire the legacy semantic control plane

**What to build:** The shipped product uses the greenfield Wiki Run as its only semantic execution path, with the old Scheduler, persisted knowledge workflow, role pipeline, and Renderer removed rather than maintained behind compatibility layers.

**Blocked by:** 01 — Establish the Wiki Run harness; 02 — Validate and atomically publish a Wiki; 03 — Version and fork the Producer Skill; 04 — Refresh a Published Wiki; 05 — Harden untrusted source and side-effect boundaries; 06 — Evaluate the single-Agent Wiki producer.

**Status:** ready-for-agent

- [x] The Wiki Run application seam is the only executable repository-to-Wiki semantic path.
- [x] Remove the legacy Scheduler, Planner, Worker, Verifier, Renderer, Coverage Obligation, Accepted Knowledge Model, Knowledge Impact Graph, transactional Run Event, review, query, and source-investigation runtime where it is no longer used.
- [x] Disconnect or remove callers that exist only to operate the retired semantic control plane.
- [x] Remove old state schemas, databases, migrations, fixtures, and compatibility adapters that have no new Wiki Run consumer.
- [x] Remove or replace tests and evaluations that assert only retired domain contracts, preserving reusable failure-injection and security patterns where they still test new behavior.
- [x] No compatibility shim translates old Workspaces, Production Runs, Knowledge Bundles, review state, or APIs into the new model.
- [x] Shipping imports, commands, and package startup no longer load retired semantic modules.
- [x] The new Generate, Refresh, validation, security, and evaluation tests remain green after each contraction step.
- [x] Keep the contraction mechanical and avoid introducing replacement abstractions beyond the approved Wiki Run, Producer Skill, validator, and publisher seams.
