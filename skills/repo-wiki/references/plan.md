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

Continuously overwrite `work/plan.md` and `work/plan-ledger.json` as one
digest-bound Plan. For long work, keep
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

`work/plan.md` is the readable synthesis. Its frontmatter is identity-only and
its five analysis sections are mandatory and non-empty. The evidence-backed
conclusions section uses ordinary locator footnotes; every ledger Gap ID appears
in the unresolved-gaps section. For a Chinese workspace, use the exact headings
`全局模型`, `生命周期与跨源关系`, `证据支持的结论`, `被拒绝的假设` and `未解决的缺口`.

```yaml
---
kind: knowledge-plan-narrative
ledger: plan-ledger.json
---

# Knowledge Plan

## Global model
...

## Lifecycles and cross-source relationships
...

## Evidence-backed conclusions
... [^request]

## Rejected hypotheses
...

## Unresolved gaps
No unresolved gaps.

[^request]: `API/api-core/src/main/java/example/request/Request.java#L20-L48`
```

`work/plan-ledger.json` is the canonical machine Artifact. Write strict JSON,
not YAML-in-Markdown:

```json
{
  "kind": "knowledge-plan",
  "source_areas": [{
    "id": "api-request-domain",
    "source": "API",
    "paths": ["api-core/src/main/java/example/request"],
    "disposition": "domain",
    "domain_ids": ["requests"],
    "evidence_seeds": ["API/api-core/src/main/java/example/request/Request.java#L20-L48"]
  }],
  "domains": [{
    "id": "requests",
    "name": "Requests",
    "definition": "Owns request admission, state and recovery.",
    "owner_unit_id": "request-capability"
  }],
  "concepts": [{
    "id": "request",
    "domain_id": "requests",
    "kind": "entity",
    "name": "Request",
    "definition": "A durable unit of accepted work.",
    "owner_unit_id": "request-capability",
    "model_basis": {
      "basis": "opengauss",
      "catalog_tables": [{"source": "database", "table": "requests"}]
    }
  }],
  "table_groups": [{
    "source": "database",
    "domain_id": "requests",
    "role": "entity",
    "tables": ["requests"]
  }],
  "units": [{
    "id": "request-capability",
    "kind": "capability",
    "question": "What does the request capability own and enforce?",
    "domain_ids": ["requests"],
    "concept_ids": ["request"],
    "scopes": [{
      "source": "API",
      "role": "owner",
      "paths": ["api-core/src/main/java/example/request"]
    }],
    "evidence_seeds": ["API/api-core/src/main/java/example/request/Request.java#L20-L48"]
  }]
}
```

Omit optional empty arrays. `coverage` defaults to `full`; write it only for
`partial` Model Basis records. Do not author `data-model` units. The kernel
derives `model.<concept-id>` from every persistent Concept, its Model Basis and
its relationships. Do not repeat owner evidence on Domain or Concept records;
their owner unit seeds are authoritative.

## Exact field contract

All objects reject unknown fields. IDs are lowercase stable slugs, unique in
their collection and at most 64 characters. Required and optional collections
are:

| Record | Required fields | Optional fields and defaults |
| --- | --- | --- |
| Plan Ledger | `kind`, non-empty `source_areas`, `domains`, `concepts`, `units` | `table_groups`, `table_replicas`, `relationships`, `gaps`: `[]` |
| Source Area | `id`, `source`, non-empty `paths`, `disposition`, `domain_ids`, non-empty `evidence_seeds` | none |
| Domain | `id`, `name`, `definition`, `owner_unit_id` | none |
| Concept | `id`, `domain_id`, `kind`, `name`, `definition`, `owner_unit_id`, `model_basis` | none |
| Model Basis | `basis` | `coverage`: `full`; `catalog_tables`, `structure_evidence`, `gap_ids`: `[]` |
| Table Group | `source`, `role`, non-empty `tables` | `domain_id`: absent; `evidence`, `gap_ids`: `[]` |
| Relationship | `id`, `from_concept_id`, `to_concept_id`, `level`, `cardinality`, non-empty `evidence`, `include_in_er` | none |
| Authored Unit | `id`, `kind`, `question`, non-empty `domain_ids`, `concept_ids`, non-empty `scopes`, non-empty `evidence_seeds` | none |
| Gap | `id`, `category`, `claim`, `evidence` | none |

Exact enums:

| Field | Values |
| --- | --- |
| Source Area `disposition` | `domain`, `shared`, `test`, `generated`, `excluded` |
| Concept `kind` | `entity`, `value-object`, `event`, `service`, `policy`, `process`, `read-model` |
| Authored Unit `kind` | `capability`, `lifecycle`, `flow`, `integration`, `operations` |
| Scope `role` | `owner`, `model`, `producer`, `contract`, `consumer`, `feedback` |
| Table Group `role` | `entity`, `association`, `history`, `reference`, `read-model`, `working`, `infrastructure`, `replica`, `excluded`, `unresolved` |
| Relationship `level` | `declared`, `mapped`, `observed`, `heuristic` |
| Relationship `cardinality` | `one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`, `unknown` |
| Gap `category` | `catalog-selection`, `source-coverage`, `model-coverage`, `relationship-confidence`, `other` |

`evidence` on a Gap may be empty; its claim must then state that registered
evidence is absent or outside the registered Sources for review approval. Every other seed/evidence
collection marked non-empty above must contain at least one locator. A
`partial` Model Basis requires `gap_ids`; `full` forbids them. An `excluded`
Table Group requires evidence, and an `unresolved` group requires `gap_ids`;
all other group roles forbid `gap_ids`.

Kinds are `capability`, `lifecycle`, `flow`, `data-model`, `integration` and
`operations`. IDs are stable lowercase semantic keys. Each scoped Source has at
least one seed actually opened inside its paths. The body explains the global
model, lifecycle and cross-Source relationships, evidence-backed conclusions,
rejected hypotheses and unresolved gaps.

## Coverage ledger

Close each ledger before Plan review:

- `source_areas` partitions every eligible deterministic Source region once.
  `disposition` is `domain`, `shared`, `test`, `generated` or `excluded`;
  domain areas name their `domain_ids` and every area has opened seeds.
- `domains` records a stable definition and one `owner_unit_id`.
  Each Domain has its own owner unit; one owner unit cannot own several Domains.
- `concepts` assigns every Concept to one Domain and one `owner_unit_id`.
  The kernel derives a model unit for persistent Concepts; `none` Concepts have
  no model unit.
- `table_groups` classifies every captured table once, grouped by Source,
  Domain and role. Roles are `entity`,
  `association`, `history`, `reference`, `read-model`, `working`,
  `infrastructure`, `replica`, `excluded` or `unresolved`. `domain_id` is
  omitted when no Domain owns the group. Optional `evidence` explains the
  role or Domain judgment; it never repeats the table-existence locator that
  the kernel derives from `source` and `tables`. `gap_ids` appears only on an
  `unresolved` group. A name suffix is a search hint, not evidence for the role.
  Concept links are derived from each Concept's `model_basis.catalog_tables`
  and are not repeated in a table group.
- `table_replicas` is omitted unless a real replica exists. Each entry maps one
  `{source, table}` to its `replica_of` `{source, table}` and supplies evidence;
  every table in a `replica` group has exactly one entry and other roles have
  none. Same-name tables are only candidates until proven.
- `relationships` records Concept relationships as `declared`, `mapped`,
  `observed` or `heuristic`. Only evidence-backed `declared`, `mapped` or
  `observed` relationships may set `include_in_er: true`; physical ER remains
  limited to captured constraints.

Every unit names the `domain_ids` and `concept_ids` it covers. The owner IDs in
the Domain and Concept records must resolve to those units, which makes
definition and model ownership exact without duplicating it in Composition.

Each Concept has a structured `model_basis`:

- `opengauss` lists its selected `catalog_tables`; Catalog facts are primary
  for structure and code seeds explain behavior;
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

Put all paths for one Source in one scope record. Roles are `owner`, `model`,
`producer`, `contract`, `consumer` and `feedback`. Use `model` for structural
evidence without assigning business ownership. A cross-Source handoff is an
`integration` unit with producer and consumer scopes from at least two Sources;
include both implementation neighborhoods, not only the message or request
declaration. Add a contract or feedback scope when that evidence lives in a
separate Source. The State Gate rejects ambiguous duplicate Source scopes,
missing producer/consumer roles and any scoped Source without a seed.
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
