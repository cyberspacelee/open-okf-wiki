# 04 — Refresh a Published Wiki

**What to build:** A repository owner can refresh an existing Published Wiki against a newer Repository Snapshot, receive a mechanical change summary, and publish the complete updated Wiki without a custom impact graph.

**Blocked by:** 02 — Validate and atomically publish a Wiki; 03 — Version and fork the Producer Skill.

**Status:** ready-for-agent

- [ ] Refresh uses the same Wiki Run application seam and typed terminal contract as Generate.
- [ ] A Refresh starts by copying the current Published Wiki into a fresh Staging Wiki.
- [ ] The Agent follows the selected Producer Skill's refresh guidance and performs a full semantic re-evaluation against the new Repository Snapshot.
- [ ] The first implementation does not use a Knowledge Impact Graph, Claim invalidation, partial semantic scheduling, or patch-only Renderer.
- [ ] The harness compares staged and published hashes to report added, changed, removed, and unchanged pages.
- [ ] A content-identical Refresh reports a no-op and does not replace the Published Wiki unnecessarily.
- [ ] A changed Repository Snapshot or Producer Skill digest is recorded in the new publication metadata.
- [ ] Successful Refresh validates and atomically publishes the complete Wiki tree.
- [ ] Needs Input, model failure, validation failure, or publication failure leaves the previous Published Wiki and metadata unchanged.
- [ ] End-to-end tests cover page addition, modification, removal, cross-link repair, changed citations, Skill changes, and no-op Refresh.
