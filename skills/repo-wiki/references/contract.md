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
Their bodies hold analysis. Pages are Markdown. Plan, Composition and bundle
reviews are strict JSON issue ledgers because they control phase transitions.
Each issue has a stable ID and remains `open` or `resolved`; approval means no
issue remains open. Long-running
planning progress is one living Markdown file that is overwritten in place.
The kernel creates its initial marker; Plan review remains closed until the
coordinator replaces that marker with findings, gaps and next actions.

Plan owns stable knowledge units, evidence scopes, seeds and gaps. Composition
assigns those units to stable page IDs, page metadata, diagrams and final paths.
Independent Plan review binds domain recall to the frozen Sources. Independent
Composition review binds task routing and page cohesion before page fan-out.
Writers own page body, citations and coverage. Final bundle review owns the
machine trust stamp and is digest-bound to both approved pre-write reviews. If
no knowledge passes admission, the Plan records why in `gaps`, Composition and
Candidate are empty, and all reviews may approve a Publication with no concept
pages.

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
A page plans at most four. Each appears exactly once with one
`%% okf-id: <diagram-id>` marker, matching `accTitle` and `accDescr`. Keep
citations outside the fence and follow it with a cited conclusion.

## Citations and links

Every load-bearing claim uses a footnote ID that appears exactly once in
frontmatter `sources`, body references and a footnote definition. Partial
coverage requires a non-empty `Gaps` section for English or `缺口` section for
Chinese, naming missing evidence and searched scope. Causal rationale must be
cited.

Before binding, logical page links use `[label][page-id]` without definitions.
After binding, links are ordinary bundle-root-relative or page-relative links.
Unknown IDs and broken links fail validation.

## Deterministic boundary

The kernel proves revisions, captured paths, locator syntax and ranges, Plan and
Composition schemas, Plan-review and bundle-review digests, exact unit coverage,
page metadata, locale-template separation, citation joins, diagram structure,
logical-link binding, Candidate validity and atomic Publication. Validation
collects every independently diagnosable issue in one pass and names checks
skipped because a prerequisite Artifact could not be parsed. The host owns
subagent isolation, parallelism and the persistent coordinator loop.
