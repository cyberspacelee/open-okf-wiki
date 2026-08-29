# Wiki Bundle Review

Review the exact bundle returned by `review prepare` in a fresh context. Read
the Candidate, Plan, Composition, writing contract and relevant evidence notes.
Reopen frozen Source evidence for decision-changing claims. Do not use the
producer's conversation history.

When the packet includes `previous_review`, read its Artifact before
overwriting it and verify every prior issue against the complete new bundle.

Judge the Wiki globally:

- domain recall, Source roles, lifecycles, failures and cross-Source contracts;
- knowledge-unit coverage and honest gaps;
- Grep Test, page boundaries, duplicate concepts and routing quality;
- page type, representation, hierarchy implied by paths and cross-links;
- citation support, invented rationale, scope bleed and terminology;
- diagram semantics, accessibility and renderability.

Write strict JSON to the packet's fixed `artifact` path:

```json
{
  "subject_digest": "<packet subject_digest>",
  "verdict": "changes_requested",
  "issues": [{
    "category": "concept-boundary",
    "claim": "Two unrelated capabilities share one page.",
    "resolution": "Split them into independently routable pages.",
    "area": "composition",
    "page_ids": ["request-recovery"],
    "operation": "split"
  }]
}
```

Areas are `plan`, `composition` and `page`. Page issues name at least one
`page_id`. Operations are `repair`, `split`, `merge` and `move`; structural
operations always use the composition area. Categories are
`domain-coverage`, `concept-boundary`, `grep-test`, `unsupported-claim`,
`invented-rationale`, `padded-gap`, `routing`, `coverage`, `language` and
`representation`.

An approved report has no issues. An empty Candidate is approvable only when
the empty Plan explains why no knowledge passes the Grep Test. On every
follow-up, review the complete new bundle. Return only the report path, verdict
and issue count.
