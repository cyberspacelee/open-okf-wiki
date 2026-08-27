# Review

Review runs in a session distinct from the producer. The review packet binds
the exact candidate digest. Read contract.md, the candidate pages and the
revision-bound evidence; never use writer conversation history. Reopen the
evidence behind every decision-changing claim.

Judge: Grep Test violations, unsupported claims, invented rationale, padded
gaps, ownership bleed, missing connection links, routing overlap, coverage
honesty, output language.

This task covers one owner batch (`pages` in the packet). Write the report
yourself to the packet's `artifact` path — never return its content in your
reply:

    {
      "batch": "API",
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

Use `"reopen": "plan"` with `target` set to the source name or `workspace`
when ownership, routing or page boundaries must change. An approved report
has verdict `approved` and an empty issues list; approval stamps
machine-confirmed verification — it is not human review.

Then run the packet's `complete_command` from its `workdir`.

Handoff: report path, verdict, issue count.
