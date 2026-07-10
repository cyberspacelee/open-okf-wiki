# 05 — Persist the Accepted Knowledge Model

**What to build:** Validated semantic proposals become stable Claims, Concepts, Evidence References, relations, and page plans that can be queried and rendered without replaying Agent conversations.

**Blocked by:** 04 — Extract typed knowledge with a PydanticAI Worker Agent.

**Status:** ready-for-agent

- [ ] Accepted Claims are atomic, have stable IDs, and reference at least one resolvable Evidence Reference.
- [ ] Accepted Concepts have stable identities, canonical names, aliases, defining Claims, and supporting Claims.
- [ ] Source symbols, files, and pages are not automatically treated as Concepts.
- [ ] Conflicts, epistemic status, and supersession relationships are representable without silent resolution.
- [ ] Re-running unchanged extraction preserves accepted Claim and Concept identities.
- [ ] The Accepted Knowledge Model is stored independently of PydanticAI message history.
- [ ] A minimal Concept page can be deterministically derived from accepted knowledge.
- [ ] Rejected proposals cannot appear in the derived page or coverage state.
