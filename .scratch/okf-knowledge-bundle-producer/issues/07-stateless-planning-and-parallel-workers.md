# 07 — Schedule stateless planning and parallel Workers

**What to build:** The Producer can dynamically plan and execute multiple bounded semantic investigations without a persistent Orchestrator Agent or unbounded model context.

**Blocked by:** 03 — Derive Coverage Obligations from Markdown; 04 — Extract typed knowledge with a PydanticAI Worker Agent; 05 — Persist the Accepted Knowledge Model.

**Status:** ready-for-agent

- [ ] The deterministic Scheduler selects prioritized uncovered Obligations from persisted state.
- [ ] Each Planner Agent receives a bounded Source Set summary, coverage summary, active-task summary, remaining budgets, and compact receipts.
- [ ] A Planner Agent returns a typed Task Plan and terminates without retaining global conversation state.
- [ ] Analysis Tasks declare Obligation IDs, source and path scope, Agent Role, allowed tools, and budgets.
- [ ] Independent Worker Agents can execute eligible tasks concurrently while authoritative writes remain serialized.
- [ ] Worker Agents cannot recursively create additional Agents.
- [ ] Full Worker results go to deterministic acceptance; Planner Agents receive only accepted IDs, unresolved IDs, and warnings.
- [ ] Context-size and task-budget limits produce controlled replanning rather than lost state or infinite retry.
