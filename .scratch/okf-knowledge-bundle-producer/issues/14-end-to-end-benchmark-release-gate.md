# 14 — Gate the MVP with an end-to-end Benchmark Corpus

**What to build:** The complete MVP is demonstrated and release-gated against representative repositories, semantic gold data, Mutation Cases, repeated runs, security checks, and operational cost measurements.

**Blocked by:** 10 — Refresh knowledge through the Knowledge Impact Graph; 11 — Recover, cancel, and audit Production Runs; 12 — Enforce the read-only security boundary; 13 — Evaluate Agent Roles and tool trajectories.

**Status:** ready-for-agent

- [ ] The Benchmark Corpus includes Java/Spring, DTO-heavy Java, Markdown requirements, conflicting sources, multi-module structure, and a multi-repository Producer Project.
- [ ] Human-reviewed gold data covers Major Obligations, core Claims, canonical Concepts, aliases, evidence, conflicts, exclusions, and expected Data Contracts.
- [ ] Mutation Cases cover permission changes, new requirements, removed defining evidence, file moves, Concept renames, injected conflicts, and large DTO additions.
- [ ] Hard gates achieve complete Major disposition and Evidence resolution, exact source revision matching, valid OKF output, zero broken internal links, zero unexplained deletions, and zero unresolved critical conflicts.
- [ ] Initial semantic targets reach at least 95% supported-Claim precision and major-knowledge recall, at least 90% Concept precision and recall, under 5% wrong merge/split rate, and zero critical unsupported Claims.
- [ ] Identical configurations run at least three times with 100% Major closure, zero critical Finding variance, and at least 0.90 Major Claim and canonical Concept set similarity.
- [ ] Incremental results are equivalent to full rebuild results for the same final Source Set apart from non-semantic metadata.
- [ ] The release report records the locked Python, PydanticAI, model, prompt, tool-schema, and gateway capability-test versions used by the benchmark.
- [ ] A change to the locked PydanticAI version reruns gateway contract tests and the release gate before adoption.
- [ ] The release report includes token, tool-call, latency, retry, human-review, and failure costs and either passes the MVP gate or identifies the blocking metric.
