# Knowledge Plan

Own the complete cross-Source investigation. One planner maintains the shared
mental model; focused evidence workers answer bounded questions and return note
paths, locators, gaps and unanswered questions.

Read every Source Index and selected Catalog Index. Navigate from build modules
and source sets into relevant package clusters. Account for Source roles,
domain nouns, state transitions, commands, persistence, events, failure paths,
extension points and cross-Source contracts. Distinguish public API, internal
API and plugin SPI. Package and class counts are not concepts.

Continuously overwrite `work/plan.md`. For long work, keep
`work/progress.md` sufficient to resume without conversation history: completed
investigations, current findings, rejected hypotheses, gaps and next actions.
Evidence notes belong under `work/evidence/`; copy conclusions into the Plan
instead of making the notes mandatory dependencies.

The Plan is Markdown with this frontmatter:

```yaml
---
kind: knowledge-plan
units:
  - id: request-lifecycle
    kind: lifecycle
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
`operations`. IDs are stable lowercase semantic keys. Each unit has one to
three seeds actually opened inside its scopes. The body explains the global
model, lifecycle and cross-Source relationships, evidence-backed conclusions,
rejected hypotheses and unresolved gaps.

Plan defines what knowledge requires coverage. Page IDs, types, titles, paths,
diagrams and hierarchy belong to Composition. Keep at most 64 coherent units;
edit the Plan directly when a unit is too broad.

If nothing passes the Grep Test, use `units: []` and record at least one gap
explaining why no durable knowledge warrants a page. This is a complete Plan,
not a blocker and not a reason to invent an Overview.
