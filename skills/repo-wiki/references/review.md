# Review

Review exactly the packet's `subject` in a session distinct from the producer.
The packet binds its `subject_digest`; do not use writer conversation history.
Read contract.md, the typed `subject` input and any `previous_review` before
navigating revision-bound evidence.

## Plan subject

For `plan:workspace`, independently test whether the Plan:

- accounts for every Source role and the important domain nouns, lifecycles,
  invariants, failure paths and cross-Source contracts;
- distinguishes business concepts from packages, Maven modules and framework
  structure;
- distinguishes public API, internal API and plugin SPI where applicable;
- uses coherent concept boundaries, owners, scopes, evidence seeds and child
  dependencies without overloaded pages;
- records evidence gaps honestly and writes titles and descriptions in the
  packet language.

Read every `source_brief` input. Route a Source-specific role, concept or local
contract omission to that Brief's `plan:<source>` Target. Route cross-Source
reconciliation, page admission, metadata or DAG defects to `plan:workspace`.
The State Gate rejects unknown scout targets.

Use bounded navigation to challenge omissions, not to repeat the entire Plan
worker. Approve only when missing domain work would not materially change the
page set or routing DAG.

## Page subject

For `page:<path>`, reopen evidence behind every decision-changing claim. Treat
citations as assertions, not trusted excerpts. Judge the Grep Test, unsupported
claims, invented rationale, padded gaps, scope bleed, missing cross-Source
evidence, broken routing, coverage honesty and language. For a parent page,
inspect its `dependency_page` inputs for overlap and missing links.

Ownership determines repair routing:

| Owner | Fields |
|---|---|
| `plan:workspace` | page set, Plan gaps, path, type, owner, title, description, tags, scopes, evidence_seeds, depends_on |
| `page:<path>` | body, headings, links, sources, citations, coverage, Page Gaps |

Never reopen a page for a Plan-owned defect: the State Gate will restore Plan
metadata. A Plan review may reopen `plan:workspace` or an exact dispatched
`plan:<source>`; a Page review may reopen its own subject or `plan:workspace`.

## Follow-up

When `review_mode` is `follow_up`, verify every issue in `previous_review`
first. Add a new issue only when the repair introduced it or it blocks truthful
approval; state in the claim why the initial review could not report it. Two
consecutive change rounds pause the Run for a human resume decision.

Write one JSON Attempt Artifact at the packet's `artifact` path:

    {
      "subject": "page:data/api/request-lifecycle.md",
      "subject_digest": "<packet subject_digest>",
      "verdict": "changes_requested",
      "issues": [{
        "category": "unsupported-claim",
        "claim": "exact claim or Plan decision",
        "resolution": "evidence, deletion or Plan change needed",
        "reopen_target": "page:data/api/request-lifecycle.md"
      }]
    }

Categories are `domain-coverage`, `concept-boundary`, `dependency`,
`grep-test`, `unsupported-claim`, `invented-rationale`, `padded-gap`,
`ownership`, `routing`, `coverage` and `language`. An approved report has
`verdict: "approved"` and no issues. Approval remains valid only while the
subject digest matches. Page approval stamps Machine-confirmed metadata; Plan
approval unlocks leaf pages. Neither is human review.

Run `complete_command` from `workdir`. Repair schema or evidence-check errors
until the gate accepts the report.

Handoff: Attempt Artifact path, subject, verdict, issue count.
