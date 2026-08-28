# Review

Review runs in a session distinct from the producer. The review packet binds
the exact candidate digest. Read contract.md, the candidate pages and the
revision-bound evidence; never use writer conversation history. Reopen the
Pin evidence behind every decision-changing claim — do not trust the
producer's derived Evidence Cache.

Judge: Grep Test violations, unsupported claims, invented rationale, padded
gaps, ownership bleed, missing connection links, routing overlap, coverage
honesty, output language. Page prose must be written in the packet's
`language`; flag drift with the `language` category.

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
when ownership, routing or page boundaries must change — the gate rejects a
target that names no plan shard. A report may mix plan and page issues:
reopened shards take their owned pages with them, and the remaining page
issues reopen individually. An approved report has verdict `approved` and
an empty issues list; approval stamps machine-confirmed verification — it
is not human review.

Then run the packet's `complete_command` from its `workdir`.

Handoff: report path, verdict, issue count.
