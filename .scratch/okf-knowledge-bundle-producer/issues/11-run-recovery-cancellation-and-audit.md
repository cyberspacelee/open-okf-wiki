# 11 — Recover, cancel, and audit Production Runs

**What to build:** Operators can recover interrupted runs from deterministic checkpoints, cancel work safely, and trust that authoritative state and audit history never diverge.

**Blocked by:** 07 — Schedule stateless planning and parallel Workers; 09 — Render the full OKF Producer Profile and review it.

**Status:** ready-for-agent

- [ ] Every accepted state transition and corresponding Run Event commit in one transaction.
- [ ] Interrupted runs reopen from the latest valid deterministic checkpoint without depending on Agent message history.
- [ ] In-flight semantic work that cannot be proven complete is safely retried or replanned rather than assumed successful.
- [ ] Cancellation stops new work, records the terminal outcome, and never publishes staging output.
- [ ] Failed and cancelled runs preserve diagnostics, accepted state, and audit events for inspection.
- [ ] `status` reports current phase, active and failed tasks, coverage, budgets, and actionable errors.
- [ ] Recovery cannot duplicate authoritative Claim, Concept, or disposition changes.
- [ ] Fault-injection tests cover crashes before and after state, event, staging, review, and publication transitions.
