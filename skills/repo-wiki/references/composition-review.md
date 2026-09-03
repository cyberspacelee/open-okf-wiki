# Composition Review

Review the exact Plan and Composition named by the `review composition` packet
in the same independent context that approved the Plan. Read the approved Plan
review and read-only Reference Map named by the packet, but do not reopen Source
evidence or write pages. The packet's
`artifact` is this report's output path.

Apply the Task Routing Test before page fan-out:

- every OpenGauss Source has exactly one collision-free Reference Root and no
  Git/files Source has one;
- generated Schema and Table references are absent from authored `pages`;
- each Domain owner unit maps to a Domain page that covers no other Domain,
  each Concept owner unit maps to one Domain or Concept page, and each
  persistent Concept model unit maps to a DataModel page;
- OpenGauss-backed Concepts leave physical ER generation to the kernel;
  every DataModel containing code-backed Concepts plans a separate logical ER
  diagram;
- one concrete change or failure question routes to one page;
- split units with independent owners, failure modes or change surfaces;
- merge when splitting would make readers reconstruct one causal chain, or
  when related units share one reader entry point, evidence neighborhood and
  maintenance session and are not independently useful;
- reject mechanical one-unit-per-page mapping when those merge conditions hold;
- every multi-unit page has a specific `merge_rationale` in Composition;
- compare every page with its nearest neighbor and record `merge` or
  `keep-separate`; when more than one page exists, every page ID must occur in
  at least one merge probe;
- titles, descriptions, tags and capability-oriented paths route maintainers;
- multi-page Wikis nest ordinary pages below capability directories, never
  page-type directories; specialized families use a second-level cluster when
  otherwise mixed with shared infrastructure;
- Domain pages own capability boundaries and invariants, Procedure pages own
  internal algorithms/orchestration, and Flow pages own end-to-end handoffs;
- an architecture map routes common task clusters and links to details instead
  of duplicating their ownership; it need not enumerate every leaf when routed
  capability pages expose those links;
- every Plan unit is assigned once and cross-page handoffs remain visible;
- authored pages remove copied inventories and duplication, while generated
  reference coverage remains complete and Table paths preserve Domain or
  unowned-role grouping; neither targets a page count.

Sweep every page and report all independently supportable issues in one report;
do not stop after the first routing or cohesion failure. Skip only a check whose
required Plan or Composition data is invalid.

If a page cannot be split because its single Plan unit already combines the
independent probes, report the routing issue against that page with operation
`split` and require a Plan repair. Do not approve the page and do not propose
empty pages or duplicate unit assignments. The coordinator will repeat Plan
review and rebuild Composition.

On follow-up, read the complete ledger in `previous_review`. Preserve issue IDs,
mark verified repairs `resolved`, retain failures as `open`, and add a new ID
only for a direct regression or a check previously blocked by an open issue.
Use the new packet's top-level `subject_digest` and replace the fixed Artifact
once with strict JSON:

```json
{
  "subject_digest": "<packet subject_digest>",
  "verdict": "changes_requested",
  "merge_probes": [{
    "page_ids": ["request-retry", "request-compensation"],
    "decision": "merge",
    "rationale": "Both pages are opened for the same recovery session and reconstruct one causal chain."
  }],
  "issues": [{
    "id": "routing.request-recovery",
    "status": "open",
    "category": "routing",
    "claim": "Retry and compensation are mechanically mapped to separate pages.",
    "resolution": "Merge them into one request recovery page.",
    "area": "composition",
    "page_ids": ["request-retry", "request-compensation"],
    "operation": "merge"
  }]
}
```

Categories are `domain-coverage`, `concept-boundary`, `model-basis`,
`table-disposition`, `relationship-confidence`, `reference-coverage`,
`grep-test`, `unsupported-claim`, `invented-rationale`, `padded-gap`, `routing`,
`coverage`, `language` and `representation`. Operations are `repair`, `split`, `merge` and
`move`; every issue uses `area: "composition"`. Issue IDs are stable lowercase
slugs. A one-page Composition uses `merge_probes: []`. A `merge`
probe requires the exact matching open merge issue; an approved report has no
open issues and retains resolved entries. Do
not run status, bundle review, Publication or export. Return only the report
path, verdict and open issue count.
