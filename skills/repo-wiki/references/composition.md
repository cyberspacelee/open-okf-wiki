# Composition Map

Read the complete Plan Narrative and Plan Ledger, then design the Wiki as a whole. A fresh composer also
reads each relevant evidence note once; the planner that already synthesized
those notes into the approved Plan does not reread them. This is the first
stage allowed to choose pages and physical paths.

Start from the approved Domains and their task-routing needs. Choose as many
authored pages as those maintenance surfaces require; the Plan supplies
coverage obligations, not a page target.

Write `work/composition.md` with one entry per authored page plus Reference
Roots for generated pages:

```yaml
---
kind: composition-map
reference_roots:
  - source: database
    path: reference/database
pages:
  - id: request-recovery
    path: operations/request-recovery.md
    type: Flow
    title: Request recovery
    description: Open before changing retry or compensation behavior.
    tags: [requests, recovery]
    units: [request-retry, request-compensation]
    merge_rationale: Retry and compensation are one recovery session and neither is useful alone.
    diagrams:
      - id: retry-sequence
        kind: sequence
        question: How does a failed request recover?
        sources: [API, Worker]
gaps: []
---
```

After the frontmatter, add a short analysis paragraph explaining the routing
and unit grouping. Write page titles, descriptions, tags and Diagram questions
in `status.language`; preserve exact domain identifiers where needed.

Assign every Plan unit to exactly one authored page. A page inherits the union of its
units' scopes and evidence seeds, so do not repeat those fields. Page IDs and
paths are unique. The physical path is both the final hierarchy and navigation
binding; do not maintain a separate parent graph or writer dependency graph.
Every page includes `diagrams`; use `diagrams: []` when no diagram is planned.
Each Diagram Spec lists the inherited Sources whose behavior it depicts. A
cross-Source diagram lists every participant, not only the initiating Source.
Every page assigning multiple units includes `merge_rationale`; a one-unit page
must omit it.

Declare exactly one `reference_roots` entry for each OpenGauss Source and none
for Git or files Sources. Its `path` is a unique bundle directory that does not
overlap an authored page path. The kernel generates the Source's Schema page,
every captured Table page and their links under that root. Domain-owned tables
are placed under `<root>/<domain-id>/tables/`; tables without Domain ownership
are grouped under `<root>/roles/<role>/tables/`. Do not add those generated
pages to `pages` or assign their identifiers by hand. After
Composition validation, read their stable IDs and paths only from the derived
Reference Map named by status and the review packet.

Composition makes the Plan's ownership visible through exact unit mapping:

- each Domain's `owner_unit_id` maps to a Domain page that covers no other
  Domain;
- a Concept `owner_unit_id` maps to a Domain or Concept page that defines it;
- every persistent Concept's derived `model.<concept-id>` unit maps to a
  DataModel page;
- a non-persistent Concept has no model page obligation.

Several tightly coupled Concepts may share one owner page when they have the
same Domain, reader task and change surface. Large Domains may use several
Concept or question-focused pages without a page-count cap. Separate owner
fields are unnecessary; Plan unit assignment is the authority.

Apply the Task Routing Test: a maintainer arriving with one concrete change or
failure question lands on one page. Split units when they have independent
owners, failure modes or change surfaces. Merge only when separate pages would
force the reader to reconstruct one causal chain. Also merge related units when
they share the same reader entry point, evidence neighborhood and maintenance
session and neither remains independently useful after the split. Do not map
units to pages mechanically: units are coverage obligations, not a requested
page count. Record the overall routing analysis in the body.
A page may own several tightly coupled units, but unrelated knowledge compressed
into a few umbrella pages fails routing and ownership closure.

Authored pages omit signature catalogs and duplicated background. Deterministic
Schema and Table pages carry captured inventories. Neither rule minimizes page
count. Use capability-oriented paths that
match maintainer tasks; page-type folders such as `flow/` or `lifecycle/` are
not an information architecture by themselves. In a multi-page Wiki, every
ordinary concept page is nested under a capability directory; only Overview and
Architecture may remain at the root. When one capability directory would mix a
specialized family with shared infrastructure, use a second-level cluster such
as `accounting/equity-method/`. Paths are reader architecture, not Source or
package mirrors. Add an Overview or Architecture
page only when it provides a real cross-page map, and keep detailed ownership
in the linked pages. An Overview routes common task clusters; it need not list
every leaf when a routed capability page links its related details. Select page
types and diagrams from the writing contract. Use Domain for capability
ownership and real invariants. Its writer packet projects that Domain's
Concepts, DataModel, Lifecycle and Flow routes so it can summarize model, state
and key flows without claiming their units. Use Concept for domain-specific noun semantics,
Procedure for an internal orchestration, calculation or algorithm, Flow for a
trigger-to-outcome handoff across participants, and Lifecycle for state
reachability. A DataModel containing code-backed Concepts plans a logical ER
diagram. Its OpenGauss-backed Concepts always leave physical ER to the generated
model block; a mixed page may therefore contain both separate views.
Writers may run concurrently after Composition review because each reopens
Source evidence.

Drafts remain at `work/drafts/<page-id>.md`: this identity store is deliberately
flat so a Composition move does not rename writer work. The Candidate and
Navigation Index materialize the approved path hierarchy before bundle review.

Mandatory Plan ownership prevents an empty Composition. Do not manufacture
pages outside the approved units or generated OpenGauss references.

## Path contract

Authored paths must match `^[a-z0-9][a-z0-9/_.-]*\.md$`. They are relative
POSIX paths: no absolute path, backslash, `..`, empty component, doubled slash,
or component ending in a dot or space. `index.md` and `log.md` are generated
reserved names. Windows device-name components such as `con`, `prn`, `aux`,
`nul`, `com1` through `com9` and `lpt1` through `lpt9` are invalid, with or
without an extension. Page IDs obey the same lowercase stable-ID discipline.

For a multi-page Wiki, ordinary pages live below a capability directory;
Overview and Architecture are the only root-page exceptions. A Domain landing
page uses a descriptive lowercase filename such as
`measurement/measurement.md`; `README.md` is invalid because of uppercase and
`measurement/index.md` is reserved for generated navigation.
