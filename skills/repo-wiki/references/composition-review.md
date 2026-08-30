# Composition Review

Review the exact Plan and Composition named by the `review composition` packet
in the same independent context that approved the Plan. Read the approved Plan
review, but do not reopen Source evidence or write pages. The packet's
`artifact` is this report's output path.

Apply the Task Routing Test before page fan-out:

- one concrete change or failure question routes to one page;
- split units with independent owners, failure modes or change surfaces;
- merge when splitting would make readers reconstruct one causal chain, or
  when related units share one reader entry point, evidence neighborhood and
  maintenance session and are not independently useful;
- reject mechanical one-unit-per-page mapping when those merge conditions hold;
- every multi-unit page has a specific merge rationale in the Composition body;
- titles, descriptions, tags and capability-oriented paths route maintainers;
- an architecture map routes common task clusters and links to details instead
  of duplicating their ownership; it need not enumerate every leaf when routed
  capability pages expose those links;
- every Plan unit is assigned once and cross-page handoffs remain visible;
- thinness comes from removing inventories and duplication, not targeting a
  minimum or maximum page count.

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
  "issues": [{
    "id": "routing.request-lifecycle",
    "status": "open",
    "category": "routing",
    "claim": "Request lifecycle combines independently maintained admission, persistence and recovery work.",
    "resolution": "Split those change surfaces and preserve their handoff with logical links.",
    "area": "composition",
    "page_ids": ["request-lifecycle"],
    "operation": "split"
  }]
}
```

Categories are `domain-coverage`, `concept-boundary`, `grep-test`,
`unsupported-claim`, `invented-rationale`, `padded-gap`, `routing`, `coverage`,
`language` and `representation`. Operations are `repair`, `split`, `merge` and
`move`; every issue uses `area: "composition"`. Issue IDs are stable lowercase
slugs. An approved report has no open issues and retains resolved entries. Do
not run status, bundle review, Publication or export. Return only the report
path, verdict and open issue count.
