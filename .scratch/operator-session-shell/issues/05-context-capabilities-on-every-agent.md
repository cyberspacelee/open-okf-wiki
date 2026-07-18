# 05 — Context capabilities on every agent

**What to build:** Root, child, Reviewer, and conversation agents share a harness-based context stack (tiered compaction, limit warnings, overflowing tool output) so approaching max context triggers automatic compaction with observable Session/Host events—no custom summarizer framework.

**Blocked by:** None — can start immediately.

**Status:** completed

- [ ] A single capability factory attaches pydantic-ai-harness compaction family + overflow policy consistently across agent roles that issue model requests.
- [ ] Adaptive domain/leaf/reviewer and root all receive the stack (not root-only).
- [ ] Approaching the configured context target emits operator-visible compaction warning/completed style events (thin observe wrapper only).
- [ ] No second in-house compression algorithm; summarizing/clear/clamp behavior comes from harness.
- [ ] Tests assert capability presence per role and that compaction observation fires on a synthetic over-budget path where practical.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (harness TieredCompaction / LimitWarner / OverflowingToolOutput).
