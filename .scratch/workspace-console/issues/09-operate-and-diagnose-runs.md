# 09 — Cancel, recover, and diagnose Production Runs

**What to build:** An operator can safely intervene in a Production Run, recover from deterministic checkpoints, and understand failures and costs without risking duplicate knowledge or partial publication.

**Blocked by:** 08 — Run semantic work through the selected Gateway Profile.

**Status:** ready-for-agent

- [ ] An active non-terminal Run can be cancelled from the Console, stops admitting new work, records the terminal outcome, and never publishes staging output.
- [ ] A recoverable interrupted Run can resume from its latest valid deterministic checkpoint without relying on Agent conversation history.
- [ ] Recovery cannot duplicate accepted Claims, Concepts, Findings, dispositions, task receipts, or Run Events.
- [ ] Failed, cancelled, and interrupted Runs preserve diagnostics, audit data, accepted state, and staging information for inspection.
- [ ] The Run page distinguishes actionable failures from terminal outcomes and review blockers.
- [ ] Diagnostics summarize active/failed tasks, budget use, token and tool totals, retries, latency, gateway/model identity, and redacted errors.
- [ ] Read-only status and diagnostic operations cannot mutate Run state.
- [ ] Cancellation or recovery during rendering, checking, review, or publication preserves the existing atomic publication guarantees.
- [ ] CLI and Console operations return equivalent outcomes and illegal-transition errors.
- [ ] Fault-injection and browser tests cover intervention before and after state, event, task, staging, review, and publication checkpoints.
