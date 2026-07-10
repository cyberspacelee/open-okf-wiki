# 10 — Refresh knowledge through the Knowledge Impact Graph

**What to build:** A new Source Set revision updates only explainably affected knowledge while preserving stable identities and preventing silent deletion.

**Blocked by:** 02 — Build a multi-repository Source Set; 05 — Persist the Accepted Knowledge Model; 09 — Render the full OKF Producer Profile and review it.

**Status:** ready-for-agent

- [ ] The Knowledge Impact Graph links Source Units, Evidence References, Claims, Concepts, and rendered pages.
- [ ] Source Snapshot revision differences identify added, changed, moved, and removed Source Units per source.
- [ ] Unchanged evidence can be relocated by content digest without semantic re-extraction.
- [ ] Changed or removed evidence marks downstream Claims and Concepts for reverification.
- [ ] New Source Units generate new Coverage Obligations.
- [ ] Unaffected Claims, Concepts, and paths retain stable identities.
- [ ] Claim or Concept deletion requires lost defining evidence, no replacement evidence, renewed coverage closure, and verification.
- [ ] Unexplained impact falls back to full analysis, and incremental output passes the same publication gates as a full build.
