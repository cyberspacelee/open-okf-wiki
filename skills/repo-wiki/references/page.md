# Page Writer

Write exactly one composed page to `work/drafts/<page-id>.md`. Read the Plan,
Composition, assigned knowledge units, relevant evidence notes and the template
matching the page type. The page inherits the union of its units' scopes.
Reopen frozen Source evidence for every load-bearing claim; Plan and evidence
notes are synthesis inputs, not provenance.

Start frontmatter with writer-owned fields only:

```yaml
---
coverage: full
sources:
  - id: request-entry
    resource: API/src/main/java/example/Request.java#L20-L48
---
```

The kernel supplies ID, type, title, description, tags, diagrams, language and
generated metadata from Composition when it builds the Candidate. Review later
supplies trust metadata.

Use logical links for other composed pages:

    See [request recovery][request-recovery].

Do not add a reference definition or guess the final relative path. Implement
each Diagram Spec exactly once with matching `%% okf-id`, Mermaid kind,
`accTitle` and `accDescr`. Follow the diagram with an evidence-backed
conclusion. Keep locators outside diagrams.

Every locator must fall inside an inherited scope. A page spanning Sources
cites each participant. Use `coverage: partial` and a non-empty `## Gaps`
section when evidence is incomplete. Return only the draft path and gap count.
