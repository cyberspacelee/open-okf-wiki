# Knowledge Plan Review

Review the exact Knowledge Plan named by the `review plan` packet in an
independent context. Use bounded evidence navigation commands
from the packet workdir; the packet's Source names are routing hints. Do not
read run internals, write Composition or choose pages.
The packet is the command's JSON output; `artifact` names this report's output
path and is not an input packet file.

First perform the routing sweep before semantic recall:

- derive at least two concrete maintainer probes from every compound unit's
  named stages or domains: "where would I change X?" and "where would I debug
  failure Y?";
- if those probes start in different scope roots, have independent failure
  modes, or one can change without the other, record a `changes_requested`
  split issue;
- a chronological or end-to-end handoff is not sufficient merge rationale;
  preserve the relationship in a focused bridge unit or gap;
- evidence-note boundaries do not justify unit boundaries. One evidence note
  can and often should feed several independently routable units.

Complete the routing sweep across every unit and report all independently
supportable issues; never stop after the first failure. Do not let adding more
nouns, scopes or lifecycle wording cure a failed routing check. Then check every
semantic-recall criterion that remains assessable before page fan-out:

- every registered Source role and independently maintained capability relevant
  to the task is accounted for;
- primary domain nouns, commands, state transitions and persistence are units
  or evidence-backed gaps;
- reject a Gap whose only basis is "not traced", "not inspected", a bounded
  pass ending, or another planner-controlled omission when the registered
  Sources expose the relevant domain or entry point; require one focused
  residual investigation before approval;
- accept a Gap for absent registered evidence, an unregistered dependency, a
  failed bounded investigation or a concrete semantic uncertainty, and require
  it to say which condition applies;
- scopes do not count as coverage by themselves: spot-check public entry points
  for each domain unit and require a separate unit or gap only when a capability,
  lifecycle or failure path is independently maintained and changes routing;
- lifecycles include failure, retry, cancellation and recovery paths where
  present;
- events, queues, extension points and cross-Source contracts are represented;
- a causal lifecycle split across units has one question or explicit gap that
  names its handoff and feedback path; separate noun coverage is insufficient;
- after a split or merge repair, repeat that causal check on the affected
  records; two independently seeded halves still require one bridge question
  or explicit gap naming the upstream handoff and downstream feedback;
- every unit passes the Grep Test and every exclusion is honest;
- each unit is one routable change surface or causal question; split umbrella
  questions that only enumerate independently owned domains, while preserving
  their handoff in a focused bridge unit or gap.

On follow-up, read the complete prior ledger embedded in `previous_review`.
Preserve every issue ID, mark verified repairs `resolved`, retain failures as
`open`, and add a new ID only when the repair introduced an issue or an earlier
issue prevented assessment. Copy the new packet's top-level `subject_digest`
into the replacement report, never the nested prior digest. Replace the fixed
Artifact once with strict JSON:

```json
{
  "subject_digest": "<packet subject_digest>",
  "verdict": "changes_requested",
  "issues": [{
    "id": "domain.usage-metering",
    "status": "open",
    "category": "domain-coverage",
    "claim": "Usage and metering are visible modules but absent from units and gaps.",
    "resolution": "Investigate the flow and add a unit or an evidence-backed gap."
  }]
}
```

Categories are `domain-coverage`, `source-role`, `lifecycle`, `failure-path`,
`cross-source-contract`, `grep-test` and `gap`. Issue IDs are stable lowercase
slugs. An approved report has no open issues and retains resolved entries. Do
not run coordinator commands such as status, `review complete`, Publication or
export. Return only the report path, verdict and open issue count.
