# Composition Map

Read the complete Plan, then design the Wiki as a whole. A fresh composer also
reads each relevant evidence note once; the planner that already synthesized
those notes into the approved Plan does not reread them. This is the first
stage allowed to choose pages and physical paths.

Write `work/composition.md` with one entry per final page:

```yaml
---
kind: composition-map
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

Assign every Plan unit to exactly one page. A page inherits the union of its
units' scopes and evidence seeds, so do not repeat those fields. Page IDs and
paths are unique. The physical path is both the final hierarchy and navigation
binding; do not maintain a separate parent graph or writer dependency graph.
Every page includes `diagrams`; use `diagrams: []` when no diagram is planned.
Each Diagram Spec lists the inherited Sources whose behavior it depicts. A
cross-Source diagram lists every participant, not only the initiating Source.
Every page assigning multiple units includes `merge_rationale`; a one-unit page
must omit it.

Apply the Task Routing Test: a maintainer arriving with one concrete change or
failure question lands on one page. Split units when they have independent
owners, failure modes or change surfaces. Merge only when separate pages would
force the reader to reconstruct one causal chain. Also merge related units when
they share the same reader entry point, evidence neighborhood and maintenance
session and neither remains independently useful after the split. Do not map
units to pages mechanically: units are coverage obligations, not a requested
page count. Record the overall routing analysis in the body.
A one-unit repository may produce one page; a large repository is not thin
merely because unrelated knowledge was compressed into a few pages.

Thin means omitting inventories, signature catalogs and duplicated background.
It does not mean minimizing page count. Use capability-oriented paths that
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
ownership and real invariants, Procedure for an internal orchestration,
calculation or algorithm, Flow for a trigger-to-outcome handoff across
participants, and Lifecycle for state reachability. Writers may run concurrently
after Composition review because each reopens Source evidence.

Drafts remain at `work/drafts/<page-id>.md`: this identity store is deliberately
flat so a Composition move does not rename writer work. The Candidate and
Navigation Index materialize the approved path hierarchy before bundle review.

An empty Plan has `pages: []`. It still receives Composition review, then
proceeds to bundle review with no drafts; do not create a placeholder page.
