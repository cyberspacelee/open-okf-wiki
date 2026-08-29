# Writing Contract

Read this before planning, writing or reviewing a page.

## Admission: the Grep Test

If grep plus reading two or three files can rebuild a fact in about a minute,
write a source pointer instead of prose. Admit cross-module architecture,
enforced invariants, lifecycle and failure propagation, decisions with written
rationale and task routing. Exclude inventories, signatures, directory trees,
configuration lists and restated comments.

## Representation Test

Use the representation that makes the admitted knowledge cheapest to recover.
Use prose for definitions, rationale and a single rule; tables for repeated
field comparisons; diagrams when readers would otherwise reconstruct topology,
ordering, state reachability or cardinality across sentences. A diagram must
make a relationship explicit, not replace words with unlabeled boxes.

Split a page only when the child answers an independently routable maintenance
or debugging question, has distinct owner/scope/evidence or lifecycle, passes
the Grep Test by itself, and lets the parent shrink to links plus synthesis.
Length, package boundaries and diagram count are not split criteria.

## Page Scope

A Page Scope entry pairs one registered Source with relative paths; a page
stores one or more entries in `scopes`. Git/files paths are normalized POSIX
paths inside the captured Pin; `.` selects the eligible Source root. Catalog
paths name selected table page slugs. Planning may group sibling packages or
split a build module by concept, but no file or package receives a page merely
to prove structural coverage.

Page workers navigate and cite only inside their Page Scope. A source-owned
page's `scopes` all name its owner. A workspace-owned page may span Sources;
it names every participant in `scopes` and evidences each side of a boundary.
Parent pages may also read their exact Machine-confirmed child inputs.

## Locators

A Locator names evidence as a plain Source-relative path with an optional line
range:

    src/service/UserService.java
    src/service/UserService.java#L42-L68

In a multi-source Workspace, prefix the registered Source name:
`API/src/service/UserService.java#L42-L68`. No URI scheme or commit hash is
embedded: the Run binds the Locator to its Revision and Pin. Line ranges must
exist at that Revision.

`search` returns Locators. Pass one directly to the packet's `read_command`;
expand its `#Lx-Ly` range when surrounding evidence is needed. Do not split a
Locator into source, path and line arguments. The attempt-wide navigation
budget is cumulative across `outline`, `search` and `read`; when exhausted,
finish from gathered evidence, record an honest gap or fail the Target.

Cite only files actually opened. Plans and Candidate pages are routing inputs,
not provenance. Unmaterialized LFS pointers and binary files are not evidence.
Database concepts use credential-free resources from the captured Catalog.

## Source Briefs

When a Workspace has multiple Git/files Sources, one Source planning Target
owns each Source Brief. A Brief accounts for that Source's roles, bounded
lifecycle or invariant candidates, local evidence, cross-Source counterpart
queries and gaps. It never owns Wiki pages. The Workspace planning Target is
the single writer of the Page Plan and must reopen evidence before adopting a
Brief decision.

## Citations and metadata

Every load-bearing claim carries a footnote id. The same id appears exactly
once in frontmatter `sources:` and once as a footnote definition. The kernel
fills Git author and last_modified metadata.

The Page Plan owns page type, owner, title, routing description, tags, scopes,
evidence seeds, dependencies and Diagram Specs. Page writers own body,
coverage, gaps, sources and the content of planned diagrams. The State Gate
copies Plan-owned metadata into the Candidate; review owns verified, status and
stale_after. Workers never set trust fields.

Partial coverage requires a non-empty Gaps section naming missing evidence and
the searched scope. Causal language requires cited written rationale.

Links are bundle-root-relative or page-relative; broken links block
Publication. Links route between pages; inline diagrams express relationships
inside one page. Do not create a separate connection graph or diagram sidecar.

## Page types and diagrams

Types are closed: `Overview`, `Architecture`, `Domain`, `Flow`, `Lifecycle`,
`DataModel` and `Table`.

- `Overview` routes tasks and contains no diagram.
- `Architecture` explains static boundaries and propagation and plans at least
  one `flowchart`.
- `Domain` explains capability ownership, public surface and invariants;
  diagrams are optional.
- `Flow` explains an end-to-end interaction or branch and plans at least one
  `flowchart` or `sequence`.
- `Lifecycle` explains one object's state transitions and plans at least one
  `state` diagram.
- `DataModel` explains relationships among selected entities and plans at
  least one `er` diagram. Use `Table` or `Domain` when no relationship view is
  admitted.
- `Table` explains one captured schema table and contains no diagram.

Every Page Plan entry has a `diagrams` list. Each Diagram Spec contains a
page-local unique ASCII `id`, `kind` (`flowchart`, `sequence`, `state` or `er`)
and a short localized `question`. One diagram answers one question, and one
page plans at most four; the bound protects dispatch size and is not a split
criterion by itself.

Each planned diagram appears exactly once in a `mermaid` fence:

    ```mermaid
    %% okf-id: request-retry
    sequenceDiagram
        accTitle: Request retry interaction
        accDescr: Queue dispatches a retry and the service schedules failure recovery.
    ```

The `%% okf-id` and Mermaid kind must match the Plan. Every diagram has
non-empty `accTitle` and `accDescr`, uses text labels rather than color alone,
and is immediately followed by a short conclusion or caption with at least one
ordinary page footnote. Keep citations outside the fence. The State Gate uses
the pinned Mermaid parser for syntax; parse success never substitutes for
semantic review.

## Page DAG

The Page Plan is the single writer of page paths, owners, metadata, `scopes`,
Diagram Specs and `depends_on` edges. Its `evidence_seeds` are one to three
Locators the planner actually opened to justify each source-owned Git/files
concept; they bootstrap page research but are not page provenance. Workspace
synthesis pages may use an empty list. A dependency points from a parent
synthesis page to a child. Paths are unique, every dependency names a planned
page and dependencies are acyclic.

A Plan review bound to the exact Plan digest must approve domain recall,
concept boundaries, routing metadata and the DAG before any page becomes
ready. A leaf then researches and writes from Source evidence. A parent waits for all
children to become Machine-confirmed, then synthesizes them with Source
evidence. Review is per page and binds its exact digest. Changing a page
invalidates its review and dependent parents.

Workspace root pages use owner `workspace`. Source-owned pages use their
Source name as owner, live under `data/<source-slug>/` and cite only that
owner. Every plan includes `overview.md` and `architecture.md`. Multi-source
plans add source-owned concepts only where they improve routing. Catalog pages
may group related selected tables and use one or more table scopes; table
selection alone never requires a page. Reserved `index.md` and `log.md` are
generated by Publication.

## Attempts and gates

Workers write only the packet's Attempt Artifact inside its attempt-specific
temporary directory. A successful State Gate promotes it to the canonical
plan, Candidate page or review artifact. A rejected attempt cannot mutate
completed artifacts or unlock downstream Targets. Target dependencies,
ready-set calculation, retries and invalidation belong to the CLI, not the
coordinator.

The packet is persisted at `packet_path` and replayed only through `task
packet`. Its `inputs` are typed: `source_index`, `source_brief`,
`catalog_index`, `subject`, `dependency_page`, `previous_output` or
`previous_review`. Read only roles required by the Target; never inspect run
internals to discover more inputs.

## Language

The packet's `language` controls page prose, titles, routing descriptions,
gaps and review text. Machine-facing frontmatter fields, tags, paths and
Locators remain ASCII. Review flags language drift.
