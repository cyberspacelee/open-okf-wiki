# Review

Review exactly one Candidate page in a session distinct from the producer.
The packet binds its path and exact `page_digest`. Read contract.md, the page,
its owner, `scopes` and revision-bound evidence. Do not use writer conversation
history. Reopen Pin or Catalog evidence behind every decision-changing claim;
the page's citations are assertions to verify, not trusted excerpts.

Judge the Grep Test, unsupported claims, invented rationale, padded gaps,
scope or owner bleed, missing cross-source evidence, broken routing, coverage
honesty and output language. For a parent page, inspect its Machine-confirmed child
inputs for routing overlap and missing links.

Write one JSON Attempt Artifact at the packet's `artifact` path:

    {
      "page": "data/api/request-lifecycle.md",
      "page_digest": "<packet page_digest>",
      "verdict": "changes_requested",
      "issues": [{
        "category": "unsupported-claim",
        "target": "data/api/request-lifecycle.md",
        "claim": "exact claim or section",
        "resolution": "evidence or deletion needed",
        "reopen": "page"
      }]
    }

Issue categories are `grep-test`, `unsupported-claim`, `invented-rationale`,
`padded-gap`, `ownership`, `routing`, `coverage` and `language`. Use
`"reopen": "page"` for content repair and set `target` to the reviewed page.
Use `"reopen": "plan"` only when the owner, `scopes`, page boundary or
dependency structure must change; its `target` is `plan:workspace`.

An approved report has `verdict: "approved"` and no issues. Approval is
valid only while the page digest matches. The State Gate promotes the report,
stamps that page Machine-confirmed and unlocks ready parents. It is not human
review.

Run `complete_command` from `workdir`. Repair schema or evidence-check errors
until the gate accepts the report.

Handoff: Attempt Artifact path, verdict, issue count.
