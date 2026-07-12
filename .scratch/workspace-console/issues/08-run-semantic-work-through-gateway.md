# 08 — Run semantic work through the selected Gateway Profile

**What to build:** A user can execute and understand a complete semantic Production Run through the selected Gateway Profile, including bounded planning, extraction, verification, coverage progress, and operational cost.

**Blocked by:** 06 — Configure reusable Gateway Profiles; 07 — Start and watch a deterministic Production Run.

**Status:** ready-for-agent

- [ ] Starting semantic execution uses the Workspace's selected Gateway Profile and resolved model assignments.
- [ ] Planner, Worker, and Verifier activity advances the existing deterministic Scheduler rather than introducing browser-owned workflow state.
- [ ] Run detail shows Analysis Tasks with Source, path scope, obligation IDs, state, budgets, and compact receipts.
- [ ] Coverage Obligations show priority, disposition, source, role, and state changes while the Run progresses.
- [ ] Token usage, tool calls, retries, latency, model, and failure totals are aggregated from existing audit records.
- [ ] Secret values and secret-bearing headers are absent from task displays, audit output, errors, and diagnostics.
- [ ] Budget, timeout, gateway, structured-output, and verification failures remain controlled and actionable.
- [ ] Successful semantic execution reaches Review Required only after Major closure and required verification.
- [ ] A model or role-routing change is visible in the Run snapshot and remains subject to the existing release and Agent Evaluation policy.
- [ ] Tests use deterministic and fake gateway fixtures for all normal/error paths, with explicitly configured live gateway tests remaining optional and isolated.

