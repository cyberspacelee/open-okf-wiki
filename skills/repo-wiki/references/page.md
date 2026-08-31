# Page Writer

Write exactly one composed page to `work/drafts/<page-id>.md`. Read the Plan,
Composition, assigned knowledge units, relevant evidence notes and the template
at `assets/templates/<workspace-language>/<page-type>.md`. Select the language
from Run state with no fallback. The page inherits the union of its units'
scopes.
Reopen frozen Source evidence for every load-bearing claim; Plan and evidence
notes are synthesis inputs, not provenance.

Write all reader-visible prose, headings, table cells and diagram labels in the
Workspace language. Preserve exact code identifiers and established domain
terms when translation would make source lookup harder.

Start frontmatter with writer-owned fields only:

```yaml
---
coverage: full
sources:
  - id: request-entry
    resource: API/src/main/java/example/Request.java#L20-L48
---
```

This schema is strict. `coverage` is the literal `full` or `partial`, never a
coverage explanation. `sources` is an array of `{id, resource}` objects; source
IDs are unique lowercase slugs and join the same body footnote references and
definitions exactly. These examples are invalid:

```yaml
coverage: >
  Most of the workflow is covered.
sources: [API/src/main/java/example/Request.java]
```

```yaml
coverage: full
sources:
  - id: "Request Entry"
    resource: API/src/main/java/example/Request.java
```

The kernel supplies ID, type, title, description, tags, diagrams, language and
generated metadata from Composition when it builds the Candidate. Review later
supplies trust metadata.

Use logical links for other composed pages:

    See [request recovery][request-recovery].

Do not add a reference definition or guess the final relative path. Implement
each Diagram Spec exactly once. Its Mermaid fence contains exactly one marker
in the form `%% okf-id: <diagram-id>`, plus the matching Mermaid kind,
`accTitle` and `accDescr`. Follow the diagram with an evidence-backed
conclusion. In state diagrams, use ASCII state aliases with quoted localized
labels. Keep locators outside diagrams.

Every locator must fall inside an inherited scope. A page spanning Sources
cites each participant. When evidence is incomplete, use `coverage: partial`
and a non-empty `## Gaps` section for `en` or `## 缺口` for `zh`. Repair an
existing draft with one targeted update; `coverage: full` must not contain that
section. Git file metadata may be enriched automatically; do not invent missing
metadata for file or Catalog locators. Do not delete and add the same path in
one patch. Return only the draft path and gap count.
Each diagram's adjacent conclusion cites every Source listed by its Diagram
Spec; a page-level citation elsewhere does not support the diagram.

Retain every heading supplied by the selected localized template and replace
its instruction text with evidence-backed content. A template section that asks
for a compact table must contain a Markdown table, not a bullet list. Domain
pages contain actual capability invariants; Procedure pages carry ordered
stages, grouping and formulas; Flow trigger/outcome sections contain business
conditions and effects, never entity field inventories. Define shared locks,
idempotency or after-commit behavior once on its owning page and link it from
dependent pages.
