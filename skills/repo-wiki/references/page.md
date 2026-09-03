# Page Writer

Write exactly one composed page to the `output` in the JSON packet returned by
`okf page prepare <page-id> --json`. Read that packet, its `reference`, its
exact `template`, and only the relevant evidence notes named in the assignment.
Do not load the full Plan Ledger, Composition or Reference Map. Select the
language from `packet.language` with no fallback. The packet supplies the
page's inherited scopes and evidence seeds.
Reopen frozen Source evidence for every load-bearing claim; Plan and evidence
notes are synthesis inputs, not provenance.

Writers handle authored pages only. The kernel renders Schema and Table pages
from captured OpenGauss facts, and inserts the OpenGauss physical model at the
DataModel template's single `<!-- okf-generated:model -->` marker. Preserve that
marker byte-for-byte and do not place an authored ER diagram in the generated
block. A DataModel containing code-backed Concepts implements its planned
logical ER diagram in the authored relationship section; a mixed-basis page
keeps that view separate from its generated OpenGauss facts.
Use `packet.reference_pages` for logical links to generated pages and
`packet.related_pages` for authored routes; never derive an ID or path from a
Source or table name.

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
metadata for file or Catalog locators. Catalog structure comes from the
generated reference, so authored prose cites it without copying the field
inventory. Do not delete and add the same path in
one patch. Return only the draft path and gap count.
Each diagram's adjacent conclusion cites every Source listed by its Diagram
Spec; a page-level citation elsewhere does not support the diagram.

Retain every heading supplied by the selected localized template and replace
every `{{replace: ...}}` marker with evidence-backed content. An untouched
marker fails validation. Preserve required generated
markers. A template section that asks for a compact table must contain a
Markdown table, not a bullet list. Domain pages contain business capability
invariants and compact data-model, state/lifecycle and key-flow overviews. Use
`packet.projections`, `packet.concepts`, `packet.relationships` and
`packet.related_pages` to reopen evidence and link to
detailed owners; do not copy their full facts or add their units to the Domain
page. Engineering parameters such as lock duration, batch size and
idempotency mechanics belong to their Procedure or operations owner. Concept
pages define domain-specific nouns and semantic relationships. Procedure pages
carry ordered stages, grouping and formulas; Flow trigger/outcome sections
contain business conditions and effects, never entity field inventories.
Lifecycle pages reference authoritative persisted fields through generated
Table pages instead of reproducing their columns. Define shared locks,
idempotency or after-commit behavior once on its owning page and link it from
dependent pages.
