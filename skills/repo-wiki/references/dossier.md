# Knowledge Dossier Target

Research exactly the assigned knowledge unit. Keep findings and evidence in the
Markdown body. Frontmatter is the bounded control manifest:

```yaml
---
kind: knowledge-dossier
unit_id: request-lifecycle
disposition: ready
children: []
---
```

Use `disposition: split` only when the unit cannot be investigated as one
coherent boundary. Then provide two to eight complete child Knowledge Units:

```yaml
---
kind: knowledge-dossier
unit_id: request-lifecycle
disposition: split
children:
  - id: request-retry
    kind: flow
    owner: API
    question: How is a failed request retried?
    scopes:
      - source: API
        paths: [src/main/java/example/request]
    evidence_seeds:
      - API/src/main/java/example/request/Request.java#L20-L48
  - id: request-compensation
    kind: lifecycle
    owner: API
    question: How is an exhausted request compensated?
    scopes:
      - source: API
        paths: [src/main/java/example/request]
    evidence_seeds:
      - API/src/main/java/example/request/Request.java#L49-L72
---
```

Child kinds are `capability`, `lifecycle`, `flow`, `data-model`, `integration`
and `operations`. Each child has a stable ID, one registered Source owner or
`workspace`, a question, scopes and one to three opened evidence seeds. A
Source-owned child may use only that Source's scopes. Every child scope must
remain inside the parent scope. Do not propose Wiki page paths here. A later
composition target owns split, merge, hierarchy and path decisions.

The body must record the capability or lifecycle, concrete relationships,
verified evidence locators, contradictions and remaining gaps. Do not paste
source files.
