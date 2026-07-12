# 13 — Replay Concept formation and incremental impact

**What to build:** A reviewer can replay recorded Concept formation and see how an incremental source change propagates through Evidence References, Claims, Concepts, and Bundle pages without mistaking animation for inferred model reasoning.

**Blocked by:** 05 — Pull safely and resolve Source Revision Policies; 12 — Record and show Concept provenance.

**Status:** ready-for-agent

- [ ] Provenance replay follows persisted event sequence and timestamps rather than animation-generated ordering.
- [ ] Users can play, pause, scrub, step, and jump directly to an event or entity.
- [ ] Replay clearly separates proposed, verified, accepted, rejected, stale, and published stages.
- [ ] Incremental Runs show changed, moved, added, and removed Source Units and their downstream Knowledge Impact Graph effects.
- [ ] Unaffected Claims, Concepts, and pages remain visibly stable rather than appearing regenerated.
- [ ] Fallback-to-full-analysis events and reasons are represented when impact cannot be explained safely.
- [ ] Reduced-motion mode replaces animated transitions with an equivalent ordered static presentation.
- [ ] Keyboard controls, focus, labels, and status announcements make replay fully operable without a pointer.
- [ ] Rendering remains bounded for large event histories and does not block ordinary Run or Knowledge navigation.
- [ ] Tests assert observable sequence, controls, impact relationships, reduced-motion equivalence, accessibility, and performance bounds without asserting individual animation frames.

