# Review Target

Review the exact packet subject in a session distinct from the producer. Bind
the report to `subject_digest`; do not use writer conversation history. Read
the contract, typed subject, prior review and relevant bounded evidence.

For `plan:workspace`, test domain recall, knowledge boundaries, Source roles,
cross-Source contracts, evidence seeds and honest gaps. The Plan must not
contain page structure. Reopen `plan:workspace` for material omissions.

For `page:compose`, verify every active knowledge unit is assigned exactly once,
page boundaries pass the Grep Test, type and representation fit the reader
question, and hierarchy plus dependencies are coherent. Request structural
`split`, `merge` or `move` against `page:compose`. Reopen an exact research
Target for a dossier evidence gap, or `plan:workspace` for missing knowledge.

For `page:write/<page-id>`, reopen evidence behind decision-changing claims.
Judge unsupported claims, invented rationale, padded gaps, scope bleed,
coverage, language, links, diagram semantics, readability and renderability.
Use `repair` against the same write Target for content defects. Route page
boundary, metadata, relation or path defects to `page:compose` with the matching
structural operation.

Write one strict JSON Attempt Artifact:

```json
{
  "subject": "page:compose",
  "subject_digest": "<packet subject_digest>",
  "verdict": "changes_requested",
  "issues": [{
    "category": "concept-boundary",
    "claim": "Two unrelated capabilities share one page.",
    "resolution": "Split them into independently routable pages.",
    "reopen_target": "page:compose",
    "operation": "split"
  }]
}
```

Operations are `repair`, `split`, `merge` and `move`. Structural operations
must reopen `page:compose`. Categories are `domain-coverage`,
`concept-boundary`, `dependency`, `grep-test`, `unsupported-claim`,
`invented-rationale`, `padded-gap`, `ownership`, `routing`, `coverage`,
`language` and `representation`.

An approved report has no issues. On follow-up, verify prior issues first. Run
`complete_command`. Handoff: artifact path, subject, verdict and issue count.
