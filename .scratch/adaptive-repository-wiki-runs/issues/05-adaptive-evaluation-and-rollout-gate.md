# 05 — Evaluate and Gate Adaptive Rollout

**What to build:** The project can compare the current and adaptive Wiki Run paths on representative repositories and make an evidence-backed decision about default activation, DynamicWorkflow use, and small-run safeguards.

**Blocked by:** 02 — Ship Bounded Adaptive Wiki Orchestration; 03 — Make Provider Failures and Manual Retry Recoverable; 04 — Add the Python TUI Operator Surface

**Status:** ready-for-agent

- [ ] Evaluation runs CodeMode-only, CodeMode + Planning/compaction, and bounded SubAgents/receipt variants with identical model, snapshots, Skill digest, validator, and whole-tree envelope.
- [ ] A DynamicWorkflow variant is evaluated only where homogeneous Domain → Leaf coordination exists; its absence does not invalidate the SubAgents baseline.
- [ ] Cases include representative small, medium, large, and multi-repository snapshots, including the existing OpenWiki, IWE, and Open Knowledge fixtures.
- [ ] Reports measure grounding, useful coverage, unsupported claims, navigation, duplication, cross-domain synthesis, Root peak context, whole-tree cost, latency, depth, fan-out, concurrency, receipt compression, retries, cleanup, and permission violations.
- [ ] Acceptance requires large/multi-repository quality improvement, no grounding regression, bounded cost/latency, zero privilege violations, and no material small-case slowdown.
- [ ] The rollout decision and any adjusted limits/triggers are recorded in the project documentation before adaptive behavior becomes the default.
- [ ] Full Python tests, lint, formatting, type, lockfile, package-release, and documentation checks pass for the selected rollout state.
