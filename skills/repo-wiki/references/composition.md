# Composition Target

Read all active Knowledge Dossiers and design the Wiki as a whole. This is the
first stage allowed to choose pages, hierarchy and physical paths. Persist a
checkpoint during the investigation.

The Markdown frontmatter is a `composition-map` with one entry per final page:

```yaml
---
kind: composition-map
pages:
  - id: request-recovery
    path: operations/request-recovery.md
    type: Flow
    owner: workspace
    title: Request recovery
    description: Open before changing retry or compensation behavior.
    tags: [requests, recovery]
    units: [request-retry, request-compensation]
    scopes:
      - source: API
        paths: [src/main/java/example/request]
    evidence_seeds:
      - API/src/main/java/example/request/Request.java#L20-L48
    parent: null
    depends_on: []
    diagrams:
      - id: retry-sequence
        kind: sequence
        question: How does a failed request recover?
gaps: []
---
```

Each page has a stable `id`, proposed `path`, page metadata, assigned knowledge
`units`, optional `parent`, and `depends_on` page IDs. Assign every active unit
to exactly one page. IDs, paths and relations must be unique and acyclic.

`owner` is either one registered Source name or `workspace`. A Source-owned
page may contain scopes only from that Source; a `workspace` page may synthesize
multiple registered Sources. A page's scopes must cover the scopes of every
unit assigned to it.

`parent` is information architecture only: it places the page beneath another
page in the logical tree and does not affect readiness. `depends_on` is the
scheduling relation: each named page must be independently reviewed before
this writer becomes ready. A synthesis page should list the lower-level pages
whose reviewed content it consumes. The hierarchy and scheduling graphs are
validated separately.

Use stable page IDs in dependencies and body references. Paths are publication
bindings, not target identities. The composition review may request
`split`, `merge` or `move`; writers must not compensate for structural problems
inside page prose.
