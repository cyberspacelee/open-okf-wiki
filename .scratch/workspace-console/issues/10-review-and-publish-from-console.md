# 10 — Review and publish from the Workspace Console

**What to build:** A reviewer can understand authoritative knowledge changes, inspect their evidence, and safely approve or reject a Review Required Run without editing derived Markdown or approving stale state.

**Blocked by:** 08 — Run semantic work through the selected Gateway Profile.

**Status:** ready-for-agent

- [ ] Review shows Major and Supporting coverage by source, role, priority, and disposition.
- [ ] Exclusions and deferrals display their required reasons and relevant Coverage Obligations.
- [ ] Added, changed, removed, stale, disputed, merged, split, and excluded Claims and Concepts are grouped and navigable.
- [ ] Verification Findings are grouped by perspective, severity, verdict, and blocking status.
- [ ] A reviewer can open each Evidence Reference as a bounded excerpt at its fixed Source Snapshot revision and span.
- [ ] The staged-versus-published Bundle diff identifies added, changed, and removed pages and supports detailed inspection.
- [ ] The Review Snapshot includes the authoritative digest shown to the reviewer.
- [ ] Approve and reject require the expected digest; stale decisions are rejected and return a refreshed snapshot without changing state.
- [ ] Approval reruns deterministic validation and atomically publishes only a complete valid Bundle.
- [ ] Rejection leaves the published Bundle unchanged, records the decision, and returns the Run to its defined actionable state.
- [ ] The Console offers no direct edit path for derived Markdown, Claims, Concepts, or Findings.
- [ ] End-to-end tests cover complete review, evidence navigation, stale digest, final-check failure, approval, rejection, rollback, and CLI/HTTP parity.

