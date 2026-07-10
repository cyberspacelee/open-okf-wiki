# 13 — Evaluate Agent Roles and tool trajectories

**What to build:** Model, prompt, tool, and workflow changes can be evaluated per Agent Role and trajectory before they affect Production Runs.

**Blocked by:** 06 — Classify Java source and aggregate Data Contracts; 07 — Schedule stateless planning and parallel Workers; 08 — Verify semantic proposals from multiple perspectives; 09 — Render the full OKF Producer Profile and review it.

**Status:** ready-for-agent

- [ ] `pydantic-evals` datasets exist for Planner, Worker, Verifier, and Renderer Agent Roles.
- [ ] Planner Eval measures valid bounded tasks, priority, overlap, role selection, scope, concurrency, and budgets.
- [ ] Worker Eval measures scope adherence, Claim atomicity, Evidence validity, conditions, Data Carrier handling, and unsupported output.
- [ ] Verifier Eval measures critical issue recall, semantic issue recall, false positives, and independent evidence reading.
- [ ] Renderer Eval measures grounding, defining-Claim inclusion, contradiction, duplication, and readability.
- [ ] Trajectory Eval detects repeated low-value search, excessive DTO attention, needless tools, retry loops, scope violations, and budget waste.
- [ ] Agent Eval reports model, prompt, tool schema, workflow versions, cost, latency, and review outcomes.
- [ ] Evaluation failures can block model, prompt, tool, classifier, workflow, profile, policy, or schema changes.
