# Review

Review runs in a session distinct from the producer. Start review to receive
a packet bound to the exact candidate digest. Read contract.md, candidate
pages and frozen evidence; do not use writer conversation history.

Judge Grep Test violations, unsupported claims, invented rationale, padded
gaps, ownership bleed, missing connection links, routing overlap, coverage
and output language. Reopen evidence behind every decision-changing claim.

Submit JSON:

    {
      "candidate_digest": "<packet digest>",
      "verdict": "changes_requested",
      "issues": [{
        "category": "unsupported-claim",
        "target": "api/requests.md",
        "claim": "exact claim or section",
        "resolution": "evidence or deletion needed",
        "reopen": "page"
      }]
    }

Use reopen plan when ownership, routing or page boundaries must change.
Approved reports have an empty issues list. Approval adds a
machine-confirmed verification stamp; it is not human review.
