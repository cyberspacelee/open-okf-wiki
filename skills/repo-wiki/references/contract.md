# Writing Contract

## Admission and representation

Admit knowledge only when grep plus two or three files cannot reconstruct it in
about a minute: cross-module architecture, lifecycle and failure propagation,
enforced invariants, written decisions and task routing. Exclude inventories,
signatures, directory trees, configuration lists and restated comments.

Use prose for definitions and rationale, tables for repeated comparisons, and
diagrams when topology, ordering, state reachability or cardinality would
otherwise be reconstructed across sentences. Split only for an independently
routable, independently evidenced question.

## Scope and locators

A scope pairs a registered Source with normalized relative POSIX paths. `.`
selects the eligible Source root. Cross-Source claims evidence each participant.
Locators are plain paths with an optional line range:

    service/src/main/java/example/Request.java#L42-L68

The first segment is the Source. No URI scheme or revision appears in locator
text; Run state binds it to the frozen Pin or Catalog. Plans and evidence notes
are routing inputs, never provenance.

## Artifact boundaries

Plan and Composition are Markdown with small schema-validated YAML frontmatter.
Their bodies hold analysis. Pages are Markdown. Review is strict JSON because it
controls approval. Long-running planning progress is one living Markdown file
that is overwritten in place.

Plan owns stable knowledge units, evidence scopes, seeds and gaps. Composition
assigns those units to stable page IDs, page metadata, diagrams and final paths.
Writers own page body, citations and coverage. Final bundle review owns the
machine trust stamp. If no knowledge passes admission, the Plan records why in
`gaps`, Composition and Candidate are empty, and review may approve a
Publication with no concept pages.

## Page types and diagrams

Types are `Overview`, `Architecture`, `Domain`, `Flow`, `Lifecycle`,
`DataModel` and `Table`.

- Overview routes tasks and has no diagram.
- Architecture explains static boundaries and requires a flowchart.
- Domain explains capability ownership and invariants; diagrams are optional.
- Flow requires a flowchart or sequence.
- Lifecycle requires a state diagram.
- DataModel requires an ER diagram.
- Table explains one captured table and has no diagram.

Each Diagram Spec has a page-local ASCII ID, supported kind and short question.
A page plans at most four. Each appears exactly once with matching `%% okf-id`,
`accTitle` and `accDescr`. Keep citations outside the fence and follow it with
a cited conclusion.

## Citations and links

Every load-bearing claim uses a footnote ID that appears exactly once in
frontmatter `sources`, body references and a footnote definition. Partial
coverage requires a non-empty Gaps section naming missing evidence and searched
scope. Causal rationale must be cited.

Before binding, logical page links use `[label][page-id]` without definitions.
After binding, links are ordinary bundle-root-relative or page-relative links.
Unknown IDs and broken links fail validation.

## Deterministic boundary

The kernel proves revisions, captured paths, locator syntax and ranges, Plan and
Composition schemas, exact unit coverage, page metadata, citation joins, diagram
structure, logical-link binding, review digest, Candidate validity and atomic
Publication. The host owns subagent isolation, parallelism and the persistent
coordinator loop.
