# End-to-end Run

This example shows Artifact ownership and command order. It does not replace
the detailed phase references.

## 1. Configure and freeze inputs

```text
okf workspace init --lang zh
okf source add link ../api --name API
okf source add opengauss --name accounting --url-env ACCOUNTING_DATABASE_URL --schema public --table orders
okf run start --json
```

Record the returned absolute Artifact paths. Inspect frozen inputs through
`evidence outline/search/read` and `catalog tables/describe`; never open Run
state or Catalog storage as a discovery interface.

## 2. Build and approve the Plan

The planner continuously replaces:

```text
work/plan.md
work/plan-intent.json
work/progress.md
```

The first file contains the required narrative sections and evidence
footnotes. The second is authored semantic JSON. `plan compile` alone creates
or replaces the generated `work/plan-ledger.json`; never edit that ledger.
Inspect and compile before status can advance:

```text
okf plan inspect --json
okf plan compile --json
```

Run status until the next
action is `review plan`, then dispatch the exact packet:

```text
okf run status --json
okf review plan --json
```

The independent reviewer replaces `work/plan-review.json`. Repair both Plan
Artifacts together when needed and request a fresh digest-bound review.

## 3. Compose and approve routes

Generate the complete contract, then write `work/composition.md`, assigning
every authored and derived unit exactly once. Use the documented lowercase path
contract and one Reference Root per OpenGauss Source.

```text
okf composition prepare --json
okf review composition --json
```

The retained Plan reviewer replaces `work/composition-review.json`. Repair and
repeat until status enters `write`.

## 4. Prepare and write one page at a time

For each `pages[].id` in Composition:

```text
okf page prepare measurement --json
```

Dispatch one writer with only the returned `artifact` packet path, its
`reference`, relevant evidence-note paths and the packet's `output`. The writer
reads only packet cache paths, cites prepared `ev-*` IDs, replaces every
template `{{replace: ...}}` marker and writes exactly that draft. It never
writes source metadata or footnote definitions. Domain packets contain non-owning unit, model,
state/lifecycle and flow projections for their overview sections.

## 5. Review, publish and verify

```text
okf run status --json
okf review prepare --json
okf review complete --json
okf publication publish --json
okf validate --published --json
okf publication export --to wiki --json
```

The fresh bundle reviewer replaces `work/review.json`. On changes requested,
repair the named Plan, Composition or draft Artifacts, prepare a new Candidate
and send the new packet to the same reviewer. Publish only after approval.

`run status` is the normal phase guide. `validate` is the complete audit: its
JSON separates current `blocking_errors` from future `pending_errors` and every
issue carries `phase`, `applicability` and `next_action`.

PowerShell 7 uses the same commands through native JSON parsing:

```powershell
$status = okf run status --json | ConvertFrom-Json
foreach ($action in $status.next_actions) { $action }
$packet = okf page prepare measurement --json | ConvertFrom-Json
```
