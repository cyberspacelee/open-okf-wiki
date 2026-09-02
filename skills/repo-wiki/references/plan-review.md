# Knowledge Plan Review

Review the exact Knowledge Plan named by the `review plan` packet in an
independent context. Use bounded evidence navigation commands
from the packet workdir; the packet's Source names are routing hints. Do not
read run internals, write Composition or choose pages.
The packet is the command's JSON output; `artifact` names this report's output
path and is not an input packet file.

First verify mandatory coverage closure:

- every eligible Source region has one non-overlapping Source Area disposition;
- every Domain has a definition, evidence and an owner unit that names it;
- every Concept belongs to one Domain and has a definition owner that names it;
- each persistent Concept has exactly one model unit and a valid `opengauss` or
  `code` Model Basis; a `none` Concept has neither;
- every captured OpenGauss table has one disposition, with every `replica` and
  `excluded` claim evidenced and every `unresolved` item rejected;
- every Catalog table named by an `opengauss` Concept exists in its captured
  Source, and every selected Concept table maps back through a disposition;
- OpenGauss facts own physical structure; code evidence adds behavior rather
  than replacing columns, keys, constraints, indexes or partitions;
- a configured but unselected relevant table produces a partial code model and
  a `catalog-selection` Gap; capture failure is not represented as fallback;
- code-derived structure follows DDL/migrations, ORM/XML, SQL/mappers and
  persistence code in descending precedence;
- physical constraints and logical relationships remain separate, and only
  evidenced non-heuristic logical relationships enter a logical ER view.

Then perform the routing sweep:

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
- for every unit, choose the nearest neighboring unit by overlapping scope,
  causal handoff, evidence neighborhood or reader task; record a merge probe;
- decide `merge` when both records are the same change surface and neither is
  independently useful, otherwise record `keep-separate` with a concrete reason;
- when more than one unit exists, every unit ID must occur in at least one merge
  probe. Do not invent a merge quota and do not approve a `merge` decision
  without a matching open merge issue.

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
- every scoped Source has one seed inside its paths; integration units name
  producer and consumer roles from at least two Sources, plus a separate
  contract or feedback participant when the frozen evidence requires it;
- a causal lifecycle split across units has one question or explicit gap that
  names its handoff and feedback path; separate noun coverage is insufficient;
- after a split or merge repair, repeat that causal check on the affected
  records; two independently seeded halves still require one bridge question
  or explicit gap naming the upstream handoff and downstream feedback;
- every optional depth unit passes the Grep Test and every exclusion is honest;
  never apply it to Domain, Concept, persistence-model or captured-table
  coverage;
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
  "merge_probes": [{
    "unit_ids": ["usage-rating", "usage-metering"],
    "decision": "merge",
    "rationale": "Both units start from the same usage change and share one evidence neighborhood."
  }],
  "issues": [{
    "id": "routing.usage-duplication",
    "status": "open",
    "category": "routing",
    "claim": "Usage rating and metering duplicate one maintenance surface.",
    "resolution": "Merge them into one Knowledge Unit.",
    "unit_ids": ["usage-rating", "usage-metering"],
    "operation": "merge"
  }]
}
```

Categories are `domain-coverage`, `concept-coverage`, `model-basis`,
`table-disposition`, `relationship-confidence`, `source-role`, `lifecycle`,
`failure-path`, `cross-source-contract`, `grep-test`, `gap` and `routing`. Operations are
`repair`, `split` and `merge`; structural issues name their affected `unit_ids`.
A one-unit Plan uses `merge_probes: []`. Issue IDs are stable lowercase
slugs. An approved report has no open issues and retains resolved entries. Do
not run coordinator commands such as status, `review complete`, Publication or
export. Return only the report path, verdict and open issue count.
