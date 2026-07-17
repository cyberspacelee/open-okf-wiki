# 12 — Record and show Concept provenance

**What to build:** An architect can inspect a durable provenance graph showing how fixed source evidence, accepted Claims, Verification Findings, and deterministic decisions formed or changed each Concept and rendered page.

**Blocked by:** 08 — Run semantic work through the selected Gateway Profile.

**Status:** ready-for-agent

- [ ] Claim, Concept, and verification acceptance append immutable entity events in the same transaction as authoritative state changes.
- [ ] Events retain stable entity IDs, originating candidate IDs, previous/current state, timestamp, and the minimum details needed for replay.
- [ ] Provenance can be reconstructed after process restart without reading discarded model messages or chain-of-thought.
- [ ] The Concepts page shows Source Unit, Evidence Reference, Claim, Verification, Concept, and Bundle page nodes with only persisted relationships.
- [ ] Defining and Supporting Claims are visibly distinct.
- [ ] Supported, disputed, stale, conflicting, superseded, rejected, and blocked states are visibly and accessibly distinct.
- [ ] Selecting a node opens its stable identity, revision, path/span where applicable, digest, decision, and related events.
- [ ] The graph never invents an edge, causal order, or rationale that is absent from authoritative state and events.
- [ ] Large Concepts remain navigable through filtering, progressive disclosure, and bounded rendering.
- [ ] Tests prove transactional event recording, candidate attribution, restart reconstruction, graph correctness, state distinctions, bounded rendering, and absence of model-message dependence.
