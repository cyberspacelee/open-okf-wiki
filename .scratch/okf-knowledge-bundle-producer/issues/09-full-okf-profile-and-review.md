# 09 — Render the full OKF Producer Profile and review it

**What to build:** Users can inspect and approve a complete, consistently organized OKF Knowledge Bundle derived from accepted knowledge, with deterministic structure and grounded prose.

**Blocked by:** 05 — Persist the Accepted Knowledge Model; 08 — Verify semantic proposals from multiple perspectives.

**Status:** ready-for-agent

- [ ] The Bundle uses the fixed overview, architecture, modules, flows, Concepts, requirements, decisions, guides, references, and reports taxonomy.
- [ ] Reserved files, frontmatter, IDs, paths, indexes, links, logs, and coverage reports are deterministic and conformant.
- [ ] Renderer Agent prose uses only accepted Claims and records Claim grounding for factual paragraphs.
- [ ] Disputed, stale, rejected, or review-required knowledge is not rendered as accepted fact.
- [ ] A human-readable Markdown review report summarizes coverage, exclusions, changed Claims, Concept changes, Verification Findings, and the Bundle diff.
- [ ] `status` and `check` expose the same review state and blocking findings in machine-readable form for CLI and CI consumers.
- [ ] Reviewers approve or reject authoritative knowledge changes rather than editing derived Markdown.
- [ ] Approval repeats final checks and atomically publishes the full Bundle.
- [ ] Rejection leaves the published Bundle unchanged and returns the run to an actionable state.
