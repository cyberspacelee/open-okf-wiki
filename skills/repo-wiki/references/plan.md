# Knowledge Plan

Own the complete cross-Source investigation and coverage ledger. One planner
maintains the shared model; focused evidence workers answer bounded questions
and return the note path plus findings and gaps counts.

Call `okf evidence outline . --source <name> --json` once for every Git/files
Source. For every OpenGauss Source, call `okf catalog tables --source <name>
--json`, then `okf catalog describe <table> --source <name> --json` as needed.
These commands are the Catalog interface; do not open Run state or Catalog JSON
files. The outline command is the Source Index interface; do not open internal Index files. Navigate from build
modules and source sets into relevant package clusters. Account for Source roles,
domain nouns, state transitions, commands, persistence, events, failure paths,
extension points and cross-Source contracts. When all three are present,
distinguish public API, internal API/events and plugin SPI together in one unit
question or explicit gap. Name all three layers explicitly; a generic event,
facade or extension label does not establish the internal boundary. Package
and class counts are not Concepts. A Domain is a stable business responsibility,
not a Source, module or table-name prefix. A Concept is a domain noun with
specific meaning, ownership and behavior, not every class or table.
When a causal lifecycle crosses units, require one unit question or explicit
gap to name the handoff and feedback path; separate presence-only units do not
establish the relationship.

Plan by Domain, not by a desired page inventory. Establish each Domain's
responsibility and boundaries, then close its Concepts, model basis, table
groups, behaviors, failure paths and handoffs. Create only the knowledge units
needed to own those findings; Composition decides later whether units become
separate pages.

Continuously overwrite the sole authored Plan input `work/plan-intent.json`.
Before authoring, read `okf plan schema --json` and `okf plan template --json`.
The schema exposes required fields, defaults, enums and collection limits; the
template is illustrative and its Sources, paths and claims must be replaced
with the current Run's evidence. This reference supplies cross-record semantics.
Run `okf plan inspect --json` after each meaningful merge; it reports all
independently diagnosable schema, structural, evidence, coverage and
cross-artifact errors with JSON pointers and repair suggestions. Once clean,
run `okf plan compile --json`. The kernel alone writes
both `work/plan-ledger.json` and `work/plan.md`; repair their originating Intent
instead of editing generated files. For long work, keep
`work/progress.md` sufficient to resume without conversation history: completed
investigations, current findings, rejected hypotheses, gaps and next actions.
Evidence notes belong under `work/evidence/`; copy conclusions into the Plan
instead of making the notes mandatory dependencies.
Partition a note by Source by default: one bounded question inside one Source.
Only a handoff question may span Sources; name every participant in its opening
paragraph and use one Source-labeled section per participant. Before merging a
note, map every load-bearing locator neighborhood into the receiving unit's
scopes. A note's visibility never expands a unit's scope implicitly.

Replace the initial Progress marker before requesting Plan review. Update this
single file after each evidence batch and each review repair; do not create
checkpoint or attempt files.
Do not copy unit, page or draft counts into Progress. `run status` derives those
under `artifact_counts`; Progress records findings, gaps and next actions only.

After the top-level outlines, identify independent evidence questions. When
there are two or more, dispatch focused workers before the planner performs
deeper search/read calls. Each worker writes one fixed note and returns that
path; the planner owns only cross-Source synthesis and residual questions.
Worker questions and note files are evidence partitions, not future unit
boundaries: one note may feed several units and several notes may support one
bridge unit.

Merge the first batch, then inspect every proposed Gap. "Not traced in this
pass", "not inspected" and equivalent planner-controlled omissions are pending
questions when the registered Sources expose the domain or entry point. Send a
focused residual investigation before review. Keep a Gap only when the frozen
revisions lack the evidence, it belongs to an unregistered Source, bounded
navigation failed to establish the claim, or the remaining uncertainty is a
real semantic boundary.

`work/plan.md` is the generated readable synthesis, with identity-only
frontmatter and five localized analysis sections. Author the explanation under
Intent `analysis`: `global_model`, `lifecycles`, evidence-backed `conclusions`,
and optional `rejected_hypotheses`. The compiler renders Domain and Concept
definitions, relationships, Gap IDs, Gap claims and locator footnotes from their
authoritative records. Write analysis in the Workspace language. Citation IDs,
footnote definitions and a second Gap list are generated, not authored.

`work/plan-intent.json` is the authored semantic Artifact. Write strict JSON,
not YAML-in-Markdown:

```json
{
  "kind": "knowledge-plan-intent",
  "analysis": {
    "global_model": "Requests owns admission, state and recovery across the API and database.",
    "lifecycles": "The API admits a request, persists it and coordinates completion or recovery.",
    "conclusions": [{
      "claim": "Request admission is implemented in the API entry.",
      "evidence": ["API/api-core/src/main/java/example/request/Request.java#L20-L48"]
    }]
  },
  "source_areas": [
    {
      "id": "api-request-domain",
      "source": "API",
      "paths": ["api-core/src/main/java/example/request"],
      "disposition": "domain",
      "domain_ids": ["requests"]
    },
    {
      "id": "database-request-domain",
      "source": "database",
      "paths": ["."],
      "disposition": "domain",
      "domain_ids": ["requests"]
    }
  ],
  "domains": [{
    "id": "requests",
    "name": "Requests",
    "definition": "Owns request admission, state and recovery.",
    "owner_capability": "request-capability"
  }],
  "concepts": [{
    "id": "request",
    "domain_id": "requests",
    "kind": "entity",
    "name": "Request",
    "definition": "A durable unit of accepted work.",
    "owner_unit_id": "request-capability",
    "model_basis": {
      "basis": "opengauss"
    }
  }],
  "catalog_groups": [{
    "source": "database",
    "role": "entity",
    "tables": ["requests"],
    "concept_ids": ["request"]
  }],
  "units": [{
    "id": "request-capability",
    "kind": "capability",
    "question": "What does the request capability own and enforce?",
    "participants": [{
      "source": "API",
      "roles": ["owner"],
      "paths": ["api-core/src/main/java/example/request"],
      "evidence": ["API/api-core/src/main/java/example/request/Request.java#L20-L48"]
    }]
  }]
}
```

Omit optional empty arrays. `coverage` defaults to `full`; write it only for
`partial` Model Basis records. The compiler merges repeated participants for
one Source, unions their roles, paths and evidence, converts them to ledger
scopes and seeds, derives Concept catalog tables from Catalog Group
`concept_ids`, groups classifications by `(source, domain_id, role)`, and
derives model units (normally `model.<concept-id>`, with deterministic shortening
for long IDs). Inspection returns their exact IDs. Semantic definitions, relationships,
ownership, classification and Gaps remain authored decisions.
Source Areas partition every registered Source, including each OpenGauss
Source; use `.` when the whole captured Catalog belongs to one area.

## Exact field contract

All objects reject unknown fields. IDs are lowercase stable slugs, unique in
their collection and at most 64 characters. Required and optional collections
are:

| Record | Required fields | Optional fields and defaults |
| --- | --- | --- |
| Plan Intent | `kind`, `analysis`, non-empty `source_areas`, `domains`, `concepts`, `units` | `catalog_groups`, `table_replicas`, `relationships`, `gaps`: `[]` |
| Analysis | non-empty `global_model`, `lifecycles`, `conclusions` | `rejected_hypotheses`: `[]` |
| Conclusion | `claim`, non-empty `evidence` | none |
| Rejected Hypothesis | `claim`, `reason` | `evidence`: `[]` |
| Source Area | `id`, `source`, non-empty `paths`, `disposition`, `domain_ids` | none |
| Domain | `id`, `name`, `definition`, `owner_capability` | none |
| Concept | `id`, `domain_id`, `kind`, `name`, `definition`, `owner_unit_id`, `model_basis` | none |
| Model Basis | `basis` | `coverage`: `full`; `structure_evidence`, `gap_ids`: `[]` |
| Catalog Group | `source`, `role`, non-empty `tables` | `domain_id`: absent/null, inferred from Concepts when unambiguous; `concept_ids`, `evidence`, `gap_ids`: `[]` |
| Table Replica | `table`, `replica_of`: canonical Catalog locator strings; non-empty `evidence` | none |
| Relationship | `id`, `from_concept_id`, `to_concept_id`, `level`, `cardinality`, non-empty `evidence`, `include_in_er` | none |
| Authored Unit | `id`, `kind`, `question`, 1-16 `participants` | `domain_ids`, `concept_ids`: additional coverage, `[]`; owned definitions and Concept Domains are derived |
| Participant | `source`, 1-6 `roles`, 1-32 `paths` | `evidence`: 0-16 locators, empty only for Catalog participants |
| Gap | `id`, `category`, `claim`, `evidence` | `unit_ids`: `[]` (global) |

Exact enums:

| Field | Values |
| --- | --- |
| Source Area `disposition` | `domain`, `shared`, `test`, `generated`, `excluded` |
| Concept `kind` | `entity`, `value-object`, `event`, `service`, `policy`, `process`, `read-model` |
| Authored Unit `kind` | `capability`, `lifecycle`, `flow`, `integration`, `operations` |
| Participant `roles` | `owner`, `model`, `producer`, `contract`, `consumer`, `feedback` |
| Table Group `role` | `entity`, `association`, `history`, `reference`, `read-model`, `working`, `infrastructure`, `replica`, `excluded`, `unresolved` |
| Relationship `level` | `declared`, `mapped`, `observed`, `heuristic` |
| Relationship `cardinality` | `one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`, `unknown` |
| Gap `category` | `catalog-selection`, `source-coverage`, `model-coverage`, `relationship-confidence`, `other` |

`evidence` on a Gap may be empty; its claim must then state that registered
evidence is absent or outside the registered Sources for review approval.
A Gap names affected authored or derived `unit_ids`; omit them only for a global
uncertainty that every authored page must disclose. Model and table gap links
also route their Gap to the owning pages. Writers receive those Gaps, use partial
coverage and retain each Gap ID in their localized Gaps section.
Every other evidence collection marked non-empty above contains a locator. A
`partial` Model Basis requires `gap_ids`; `full` forbids them. An `excluded`
Table Group requires evidence, and an `unresolved` group requires `gap_ids`;
all other group roles forbid `gap_ids`.
Each evidence element is exactly one existing locator. Copy it from evidence
or Catalog output; put explanations, column names and relationship expressions
in claim text. [Scope and locators](contract.md#scope-and-locators) defines the
syntax and evidence responsibilities.

Derived units and merged participants keep their complete deduplicated scopes
and Evidence Seeds. There is no 16-seed or 32-path limit on a normalized unit.
The structured input and generated Ledger each have a 256 KiB Artifact budget.
Inspection checks generated size before writing and reports expansion counts
under `derived_from`; valid evidence is never silently removed to meet a budget.
Page preparation applies its own input/read budgets without clipping evidence.

Authored kinds are `capability`, `lifecycle`, `flow`, `integration` and
`operations`; `data-model` is compiled. IDs are stable lowercase semantic
keys. Each code/file participant has evidence opened inside its paths. The body explains the global
model, lifecycle and cross-Source relationships, evidence-backed conclusions,
rejected hypotheses and unresolved gaps.

## Coverage ledger

Close each ledger before Plan review:

- `source_areas` partitions every eligible deterministic Source region once.
  `disposition` is `domain`, `shared`, `test`, `generated` or `excluded`;
  domain areas name their `domain_ids`; participants own evidence routing.
  The kernel checks the complete frozen file/table inventory for uncovered
  paths as well as overlaps; registering a Source name alone does not close it.
- `domains` records a stable definition and one `owner_capability`, referencing
  an existing authored unit with `kind=capability`. Each Domain has a dedicated
  owner; one owner cannot own several Domains. The compiler adds Domain coverage.
- `concepts` assigns every Concept to one Domain and one `owner_unit_id`.
  The kernel derives a model unit for persistent Concepts; `none` Concepts have
  no model unit.
- `catalog_groups` classifies every captured table once. The compiler groups
  the ledger representation by Source, Domain and role. Roles are `entity`,
  `association`, `history`, `reference`, `read-model`, `working`,
  `infrastructure`, `replica`, `excluded` or `unresolved`. `domain_id` is
  inferred when `concept_ids` identify one Domain; absent and null have the same
  meaning. An explicit Domain must agree with every linked Concept. Split groups
  that span Domains. Optional `evidence` explains the
  role or Domain judgment; it never repeats the table-existence locator that
  the kernel derives from `source` and `tables`. `gap_ids` appears only on an
  `unresolved` group. A name suffix is a search hint, not evidence for the role.
  `concept_ids` assign tables to Concepts; the compiler derives each Concept's
  `model_basis.catalog_tables`, so table identity is authored once.
- `table_replicas` is omitted unless a real replica exists. Each entry maps one
  canonical table locator to a distinct captured original and supplies evidence;
  every table in a `replica` group has exactly one entry and other roles have
  none. Same-name tables are only candidates until proven.
- `relationships` records Concept relationships as `declared`, `mapped`,
  `observed` or `heuristic`. Only evidence-backed `declared`, `mapped` or
  `observed` relationships may set `include_in_er: true`; physical ER remains
  limited to captured constraints.

Units may name additional `domain_ids` and `concept_ids`. Owned Concepts,
owned Domains and the Domains of all covered Concepts are added by the compiler.
Every effective unit must cover at least one Domain. Definition owner references
must resolve to authored units; model ownership is derived.

A complete replica entry is:

```json
{
  "table": "analytics/requests",
  "replica_of": "database/requests",
  "evidence": ["API/src/ReplicationJob.java#L12-L35"]
}
```

The evidence must establish replication; identical table names or columns alone
do not establish it. Use the exact percent-encoded locator returned for a table
whose name contains special characters.

## Inspection and repair

`inspect` is read-only and works before either generated Plan file exists.
Diagnostics identify `code`, Artifact `path`, JSON `pointer`, `expected`,
`actual`, repair `suggestion`, and an `example` when relevant. Derived failures
also identify `derived_from`. `checks_ran`, `skipped_checks` and `skip_reasons`
describe actual execution. A skipped check may expose more issues after its
prerequisites are repaired. Analysis checks run independently of semantic
compilation, and semantic checks run independently of Analysis schema errors.

Repair every reported Intent issue, inspect again, then compile. Compilation
generates both outputs only after successful validation. Review detects missing,
stale or edited generated files and requires recompilation. Changes to Intent
invalidate the previous Plan review; repeat affected downstream approvals.

## Model and unit coverage

Each Concept has a structured `model_basis`:

- `opengauss` receives selected `catalog_tables` from Catalog Groups; Catalog
  facts are primary for structure and code evidence explains behavior;
- `code` uses `structure_evidence` in precedence order: DDL/migrations, ORM
  annotations or XML overrides, SQL/mappers, persistence code;
- `none` has no tables, structure evidence, model unit or model coverage Gap.

When an OpenGauss Source is configured but a relevant table is absent from the
selection, record `coverage: partial` and reference a `catalog-selection` Gap.
A capture failure is an external blocker before planning, never a code fallback.
Gap categories are `catalog-selection`, `source-coverage`, `model-coverage`,
`relationship-confidence` and `other`; each Gap has a stable ID, claim and
available evidence. `unresolved` groups must reference a Gap and must be
resolved before approval.

Put routing in participants. Repeated participants for one Source are allowed
and compile into one scope with unioned paths, roles and evidence. Roles are
`owner`, `model`, `producer`, `contract`, `consumer` and `feedback`. Use `model` for structural
evidence without assigning business ownership. A cross-Source handoff is an
`integration` unit with producer and consumer scopes from at least two Sources;
include both implementation neighborhoods, not only the message or request
declaration. Add a contract or feedback scope when that evidence lives in a
separate Source. The compiler rejects missing producer/consumer roles and
code/file participants without evidence.
For an OpenGauss Source, use `.` only for the whole captured Catalog or use a
selected table name/page slug. A seed or citation from another table remains
outside scope even when it belongs to the same OpenGauss Source.

A unit owns one independently routable change surface or causal question. Split
an umbrella question that merely enumerates domains with independent owners or
failure modes; preserve the end-to-end relationship in a focused bridge unit or
explicit gap instead of absorbing every domain into one lifecycle unit.

Before review, run two concrete maintainer probes against every compound unit.
Turn its named stages or domains into questions such as "where would I change
X?" and "where would I debug failure Y?" If the answers start in different
scope roots, have independent failure modes, or one can change without the
other, split the unit. A chronological handoff does not by itself make input
admission, state mutation, background delivery and recovery one change surface;
keep their relationship in a focused bridge unit or gap.

Also run the reverse probe across nearby units: which pair starts from the same
reader question, evidence neighborhood and maintenance session, and would not
remain useful independently? Merge duplicate change surfaces in the Plan. Keep
separate coverage obligations when they may still compose into one reader page;
Composition owns that later page merge.

The Grep Test may remove optional depth units, but every Domain and Concept must
retain an owner unit; every persistent Concept receives its derived model unit.

Before Plan review, account for every significant domain or subsystem exposed
by top-level build modules and entry points in `source_areas`, `domains` and
`concepts`. Each belongs in a unit or a structured evidence-backed Gap. A unit
may cover
several related modules; this is a recall check, not permission to mirror the
directory tree. A module name in `scopes` is not enough: sample its public
types or entry points and name its central domain nouns and behaviors in the
unit question or a gap. When those types form a public hierarchy, name its
major levels or types instead of only the umbrella domain. When a pipeline has
separately maintained capture, transformation and downstream-consumption
stages, distinguish the stages in the unit question or a gap.
