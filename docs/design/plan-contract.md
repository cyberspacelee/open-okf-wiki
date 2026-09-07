# Plan contract design

## Scope and outcome

Implement the complete Plan workflow across its agent-facing interface
(Skill, references, JSON Schema, template and CLI diagnostics) and deterministic
kernel (normalization, validation, rendering, state, review and downstream
consumers). This repository's interface is the host agent and CLI; a separate
Web application is not part of this design.

The acceptance boundary is a complete generation through Publication. Plan
review, Composition, Page Packets, evidence preparation, candidate validation
and grading must consume the new contract consistently.

## Domain responsibilities

| Term | Authority | Meaning |
| --- | --- | --- |
| Plan Intent | Planner | Sole authored Plan input, containing decisions and analysis |
| Plan Analysis | Planner | Global explanation, causal relationships, conclusions and rejected hypotheses |
| Plan Narrative | Kernel | Readable rendering of analysis and semantic facts |
| Plan Ledger | Kernel | Normalized semantic records and evidence routing |
| Domain Owner | Planner | Dedicated capability owning one Domain's definition |
| Definition Owner | Planner | Authored unit owning a Concept's definition |
| Participant | Planner | Source, roles and investigation paths for an authored unit |
| Evidence Anchor | Planner or captured Catalog | One exact locator supporting a claim or routing decision |
| Evidence Seeds | Kernel | Complete deduplicated evidence anchors required by a unit |
| Inspection | Kernel | Diagnostics plus the actual executed and skipped checks |

Catalog Groups retain compact exactly-once classification. Table identity is
authored there once; linking groups to Concepts derives Concept catalog tables.
Replica judgments and logical relationships retain explicit evidence. Table
existence does not establish replication or business relationships. Name
suffixes do not establish exclusion; working tables may be business evidence.

## Sole authored input

`work/plan-intent.json` contains `kind`, `analysis`, `source_areas`, `domains`,
`concepts`, `units`, and optional `catalog_groups`, `table_replicas`,
`relationships`, `gaps`.

`analysis` contains:

- `global_model`: non-empty Markdown explaining responsibilities and boundaries.
- `lifecycles`: non-empty Markdown explaining transitions and cross-Source causality.
- `conclusions`: non-empty records with `claim` and non-empty `evidence`.
- `rejected_hypotheses`: optional records with `claim`, `reason`, and optional evidence.

Gap claims, categories, routes and evidence are authored only in `gaps`. The
renderer writes their exact IDs in the localized Gaps section. It generates
footnote IDs and definitions from locators, deduplicates shared citations and
renders Domain definitions, Concept definitions and relationships from their
authoritative records. Analysis retains human/agent reasoning; the renderer
does not infer conclusions. Authored analysis does not manage footnote syntax.

Domains use `owner_capability`; Concepts retain `owner_unit_id`, since a Concept
may be owned by different authored unit kinds. Owners must exist; a Domain
owner must have `kind=capability` and cannot own another Domain. The compiler
adds owned Domains and Concepts to owner units, and derives covered Domains
from all covered Concepts. Optional unit `domain_ids` and `concept_ids` express
additional coverage; they never need to repeat ownership.

Catalog Group `domain_id` can be omitted when its Concepts identify exactly
one Domain; explicit ownership must agree. Omitted and null both mean no
explicit Domain. Groups without Concepts may retain explicit Domain ownership.
Mixed-Domain groups must be split.

Replica `table` and `replica_of` are canonical Catalog locator strings, such as
`anal/orders` and `primary/orders`. They resolve against captured table
resources, including canonical percent encoding, and normalize to internal
CatalogTableRef objects. Each replica retains non-empty judgment evidence.

## Evidence and limits

Locators name exactly one existing resource: `<source>/<relative-path>` with
optional `#Lstart` or `#Lstart-Lend` for text. Catalog locators are copied from
Catalog output. Descriptions, column access and multi-resource expressions are
claim text, not locators. Reject URI schemes, backslashes, traversal,
non-normalized paths and malformed or reversed ranges. Legal filename
characters are not forbidden merely because they can also appear in prose.

Catalog participants may omit evidence; selected table paths derive exact
Catalog anchors. Code/files participants supply evidence inside their paths.
Model units collect all structural anchors plus evidence of incident
relationships. Every collection is deduplicated without truncation.

Internal scope-path, scope-count and seed-count limits must not reject valid
unions of authored inputs. Retain the existing total structured Artifact size
limit and page-input/read budgets; report budget exhaustion where consumed.
Never discard evidence, exclude tables or split semantic ownership merely to
satisfy an internal list-length limit.

## Compilation and inspection

The pipeline is input loading, independently validated input sections, semantic
compilation, environment/evidence validation, analysis validation and rendering.
Schema errors in one top-level section must not hide independently checkable
errors in other sections. Cross-record checks require structurally valid
semantic sections; analysis checks can run without semantic compilation.

Compilation forces all derived unit construction and scope validation before
success. A successful compiler result is safe for effective-unit access,
serialization, Composition and Page preparation. Unexpected derived validation
failures are compiler diagnostics, never uncaught Pydantic exceptions.

Each diagnostic reports `code`, Artifact `path`, JSON `pointer`, `expected`,
structured `actual`, `example`, and `suggestion` where applicable. Derived
failures also report `derived_from`. Evidence checking retains every authored
pointer even when the same locator appears in several records.

Inspection reports `checks_ran` and `skipped_checks` from actual execution,
with prerequisites/reasons for skipped stages. Independent failures are
aggregated. A schema error does not imply that every other check was skipped.
`inspect` is read-only and requires neither generated Plan file.

`compile` writes both generated files only after all checks pass. Each file is
atomically replaced; interrupted replacement leaves a detectable stale pair,
never an approvable mixed generation. Inspection does not treat stale generated
files as authored-input errors. Review and downstream validation compare both
generated files against their deterministic expected content and require
recompilation if missing or modified. Digests continue to bind all artifacts.
The compiler checks the generated Ledger's 256 KiB structured Artifact budget
before writing. Overflow reports output bytes and the association/unit counts
that produced them; it neither truncates evidence nor asks the planner to
misclassify real tables. The bounded serializer is shared with output writing.

## Public interface

- `okf plan schema --json` exposes actual input-model JSON Schema without a Workspace.
- `okf plan template --json` returns a schema-valid illustrative input without a Workspace.
- `okf plan inspect --json` reports input diagnostics, executed/skipped checks and derived counts.
- `okf plan compile --json` generates the Narrative and Ledger after successful inspection.

The template is illustrative; Source names, paths, evidence and semantics must
be replaced with facts from the current Run. Public references explain semantic
rules beyond JSON Schema. The Skill directs repairs exclusively to Intent and
uses the generated Narrative for review. Private-source discovery is unnecessary.

## Verification and completion

Verify schema/template consistency; flat replicas including quoted table names;
Domain owner typing and reverse ownership; group Domain inference; code and
Catalog participants; evidence pointers and malformed locators; analysis and
semantic errors together; more than 16 derived seeds and more than 32 merged
paths; deterministic localized narrative/citations/gaps; unchanged inputs
producing identical outputs; stale/missing/tampered output rejection; review
invalidation; and successful Composition, Page preparation and Publication.

Replace old authored fixtures rather than adding migration adapters. Update
Skill/references, CLI e2e and independent grading together. Run the entire
kernel pytest suite and deterministic CLI e2e before completion. The grader
must check the sole authored input and both compiled outputs, not accept an
old narrative merely because it contains matching IDs.
