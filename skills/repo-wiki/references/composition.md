# Composition Map

Read the complete Plan and relevant evidence notes, then design the Wiki as a
whole. This is the first stage allowed to choose pages and physical paths.

Write `work/composition.md` with one entry per final page:

```yaml
---
kind: composition-map
pages:
  - id: request-recovery
    path: operations/request-recovery.md
    type: Flow
    title: Request recovery
    description: Open before changing retry or compensation behavior.
    tags: [requests, recovery]
    units: [request-retry, request-compensation]
    diagrams:
      - id: retry-sequence
        kind: sequence
        question: How does a failed request recover?
gaps: []
---
```

Assign every Plan unit to exactly one page. A page inherits the union of its
units' scopes and evidence seeds, so do not repeat those fields. Page IDs and
paths are unique. The physical path is both the final hierarchy and navigation
binding; do not maintain a separate parent graph or writer dependency graph.

Choose the smallest set of independently routable pages that passes the Grep
Test. A one-unit repository may produce one page. Do not manufacture fixed
Overview or Architecture pages. Select page types and diagrams from the writing
contract. Writers may run concurrently because each reopens Source evidence;
final review checks cross-page consistency and may request `split`, `merge` or
`move`.

An empty Plan has `pages: []`. It proceeds directly to bundle review with no
drafts; do not create a placeholder page.
