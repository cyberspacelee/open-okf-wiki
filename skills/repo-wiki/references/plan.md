# Knowledge Plan Target

Own the complete cross-Source investigation for the life of this Target. Do
not split planning into competing small-budget planners. Focused evidence
workers may search a call path or database fact, but return only findings,
locators, gaps and unanswered questions to this planner.

Read every Source and Catalog Index. Navigate from build modules and source
sets into relevant package clusters. Account for Source roles, domain nouns,
state transitions, commands, persistence, events, failure paths, extension
points and cross-Source contracts. Distinguish public API, internal API and
plugin SPI. Package and class counts are not concepts.

Continuously update the packet checkpoint and submit it with
`checkpoint_command`. After compaction or retry, read `previous_checkpoint`
first and continue its `Next actions`; do not repeat completed exploration.

Write a Markdown Attempt Artifact. Frontmatter shape:

```yaml
---
kind: knowledge-plan
units:
  - id: request-lifecycle
    kind: lifecycle
    owner: API
    question: How does a request enter failure and recover?
    scopes:
      - source: API
        paths: [api-core/src/main/java/example/request]
    evidence_seeds:
      - API/api-core/src/main/java/example/request/Request.java#L20-L48
gaps: []
---
```

Kinds are `capability`, `lifecycle`, `flow`, `data-model`, `integration` and
`operations`. IDs are stable lowercase logical identities. Each unit has one
to three evidence seeds actually opened inside its scopes. The body explains
the overall model, relations, evidence-backed conclusions, rejected
hypotheses, unresolved gaps and suggested next investigations.

`owner` is either one registered Source name or `workspace`. A Source-owned
unit may contain scopes only from that Source. Use `workspace` when the unit
genuinely spans Sources; its scopes must still name registered Sources.

Do not choose Wiki page IDs, types, titles, paths, hierarchy, dependencies or
diagrams. The Plan says what knowledge requires deeper coverage, not how the
Wiki will store it. Keep at most 64 coherent units and record honest gaps.

Run `checkpoint_command`, then `complete_command`. Handoff: artifact path, gate
verdict, unit count and gap count.
