# Writing Contract

## Admission and representation

Admit knowledge only when grep plus two or three files cannot reconstruct it in
about a minute: cross-module architecture, lifecycle and failure propagation,
enforced invariants, written decisions and task routing. Exclude inventories,
signatures, directory trees, configuration lists and restated comments.

Use prose for definitions and rationale, tables for repeated comparisons, and
diagrams when topology, ordering, state reachability or cardinality would
otherwise be reconstructed across sentences. Split only for an independently
routable, independently evidenced question. Length, package boundaries and
diagram count are not split criteria.

## Scope and locators

A scope pairs a registered Source with normalized relative POSIX paths. `.`
selects the eligible Source root. Workers navigate and cite only within the
assigned scopes. Cross-Source claims evidence each participant.

Locators are plain paths with an optional line range:

    service/src/main/java/example/Request.java#L42-L68

The first segment is the registered Source. No URI scheme or revision appears
in locator text; Run state binds it to the frozen Pin or captured Catalog.
Plans, dossiers and pages are routing inputs, never provenance.

## Artifact boundaries

Knowledge Plan, Dossier and Composition Map are Markdown with a small,
schema-validated YAML frontmatter manifest. Their bodies hold analysis. Review
reports are strict JSON because the kernel consumes their verdict and reopen
operations. Final pages are Markdown. Do not embed source files or large prose
inside frontmatter.

The Knowledge Plan owns stable knowledge units and gaps, not pages. Dossiers
own evidence findings and bounded research splits. The Composition Map owns
stable page IDs, unit assignment, type, metadata, diagrams, ID relations and
proposed final paths. Writers own page body, citations, coverage and diagram
content. Review owns trust stamps.

Knowledge units and pages use either a registered Source name or `workspace`
as owner. Source-owned artifacts may scope only that Source. `parent` records
information architecture; `depends_on` alone controls page readiness. Both
graphs use stable page IDs and are independently acyclic.

## Page types and diagrams

Types are closed: `Overview`, `Architecture`, `Domain`, `Flow`, `Lifecycle`,
`DataModel` and `Table`.

- `Overview` routes tasks and has no diagram.
- `Architecture` explains static boundaries and requires a `flowchart`.
- `Domain` explains capability ownership and invariants; diagrams are optional.
- `Flow` requires a `flowchart` or `sequence`.
- `Lifecycle` requires a `state` diagram.
- `DataModel` requires an `er` diagram.
- `Table` explains one captured table and has no diagram.

Each Diagram Spec has a page-local ASCII `id`, a supported `kind` and a short
question. A page plans at most four. Each appears exactly once:

    ```mermaid
    %% okf-id: request-retry
    sequenceDiagram
        accTitle: Request retry interaction
        accDescr: Dispatch, failure and recovery ordering.
    ```

Keep citations outside the fence. Follow it with a cited conclusion. Review
owns semantic accuracy and renderability.

## Citations and links

Every load-bearing claim uses a footnote ID that appears exactly once in
frontmatter `sources`, in body references and in a footnote definition. Partial
coverage requires a non-empty `Gaps` section naming missing evidence and
searched scope. Causal rationale must be cited.

Before binding, logical page links use `[label][page-id]` without definitions.
After binding, links are ordinary bundle-root-relative or page-relative links.
Unknown logical IDs and broken bound links fail the gate.

## Attempts and checkpoints

Workers write only the packet's Attempt Artifact. A successful State Gate
promotes it; rejected work cannot unlock downstream Targets. The packet and
checkpoint persist under the attempt directory. A valid checkpoint is Markdown
with `## Completed`, `## Findings`, `## Hypotheses`, `## Gaps` and
`## Next actions`, is at most 64 KiB, and contains paths and conclusions rather
than copied evidence.

Typed inputs include `source_index`, `catalog_index`, `subject`,
`evidence_dossier`, `dependency_page`, `previous_output`, `previous_review`
and `previous_checkpoint`. Never inspect `state.json` or unrelated attempts.

The packet language controls prose, titles, descriptions, gaps and review text.
Machine fields, IDs, paths, tags and Locators remain ASCII.
