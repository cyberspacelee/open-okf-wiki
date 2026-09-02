# Wiki Bundle Review

Review the exact bundle returned by `review prepare` in a fresh context. Read
the Candidate, Plan, Composition, writing contract and relevant evidence notes.
Reopen frozen Source evidence for decision-changing claims. Do not use the
producer's conversation history.

The approved Plan review owns repository-wide domain recall, and the approved
Composition review owns initial task routing and page cohesion. Verify that the
bundle carries both through honestly and that writing introduced no routing
regression; do not repeat either pre-write review from scratch.

Sweep the complete bundle and report every independently supportable issue in
one pass; do not stop after the first failure. When the packet includes
`previous_review`, read its complete ledger before replacement. Preserve every
issue ID, mark verified repairs `resolved`, retain failures as `open`, and add a
new ID only when the repair introduced an issue or an earlier issue prevented
assessment. Replace the fixed Artifact in one update.

Judge the Wiki globally:

- Source Area, Domain, Concept, table and knowledge-unit coverage with honest
  structured Gaps;
- exact Domain definition ownership, Concept definition ownership and
  persistent Concept model ownership carried from Plan into pages;
- per-Concept Model Basis: Catalog-owned OpenGauss structure, ordered code
  fallback evidence, and `none` only for non-persistent Concepts;
- complete generated Schema/Table reference coverage and links from authored
  Concept, DataModel and Lifecycle pages without copied field inventories;
- physical ER edges match captured constraints; logical relationships remain
  separately labeled and heuristic relationships stay out of ER diagrams;
- Grep Test for optional depth pages, page boundaries, duplicate concepts and
  routing quality;
- page type, representation, hierarchy implied by paths and cross-links;
- root and directory Navigation Indexes route every composed page through the
  intended capability hierarchy with no orphan or page-type directory;
- citation support, invented rationale, scope bleed and terminology;
- diagram semantics, accessibility and renderability.

Treat repeated shared behavior as a routing defect: identify its canonical
owner page and require dependent pages to link it. Do not accept repeated lock,
idempotency, status-priority or after-commit prose merely because each copy has
a valid citation.

Write strict JSON to the packet's fixed `artifact` path:

```json
{
  "subject_digest": "<packet subject_digest>",
  "verdict": "changes_requested",
  "issues": [{
    "id": "boundary.request-recovery",
    "status": "open",
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
operations always use the composition area. Split and move issues name at
least one affected Page ID; merge issues name at least two. Categories are
`domain-coverage`, `concept-boundary`, `model-basis`, `table-disposition`,
`relationship-confidence`, `reference-coverage`, `grep-test`,
`unsupported-claim`, `invented-rationale`, `padded-gap`, `routing`, `coverage`,
`language` and `representation`.

Issue IDs are stable lowercase slugs. An approved report has no open issues and
retains resolved entries. Mandatory coverage prevents an empty Candidate. Do
not run coordinator
commands such as status, `review complete`, Publication or export. Return only
the report path, verdict and open issue count.
