# Split Plan ledger and bounded page packets

Status: accepted

Supersedes ADR 0023 and refines ADR 0022 without changing OKF v0.2. Existing
Run state and Plan artifacts have no compatibility or migration path.

## Context

Compact table groups reduced per-table repetition, but the complete coverage
ledger still occupied almost all of `plan.md` frontmatter. The readable body
became a summary instead of the required cross-Source analysis. Database
locators also repeated deployment endpoints, and page writers received the
complete Plan, Composition and Reference Map even when writing one page. Large
writer assignments exhausted their context and execution window before any
draft was produced.

Domain pages had the opposite problem: exact unit ownership kept them thin,
while model, lifecycle and flow context lived only on sibling pages. Giving all
of those units to the Domain page would duplicate ownership and violate
Composition's exact-once guarantee.

## Decision

The Plan is two digest-bound Artifacts. `plan.md` is a readable narrative with
small identity frontmatter and required sections for the global model,
lifecycles and cross-Source relationships, evidence-backed conclusions,
rejected hypotheses and unresolved gaps. `plan-ledger.json` is the strict
machine contract containing Source Areas, Domains, Concepts, compact table
groups, replica mappings, relationships, authored units and gaps.

Persistent Concept model units are derived by the kernel as
`model.<concept-id>` from Model Basis, Concept relationships and Catalog facts.
They are not authored records. Domain and Concept evidence is supplied through
owner-unit seeds and Model Basis, so those records do not repeat evidence
arrays. Empty optional collections use schema defaults.

Catalog resources use logical `<source>/.` and `<source>/<table>` locators.
Connection scheme, host, port, database and schema remain only in Source
configuration and frozen Catalog provenance. Run and page digests bind logical
locators to the captured Catalog content.

Composition continues to assign every effective unit exactly once. Before a
writer starts, `okf page prepare <page-id> --json` deterministically writes a
digest-bound `work/page-packets/<page-id>.json` containing only that page's
owned units, relevant semantic projections, scopes, seeds, generated
references, related pages, template and output. Domain packets project every
Concept, related page and non-owning unit in the owned Domain without assigning
those units to the Domain page. Their scopes and seeds become valid
Domain-summary evidence. Domain templates require compact model, state/lifecycle and
flow overviews that link to the owning detail pages.

Status reports only current-phase blocking issues and next actions. Full
validation retains all checks but labels each issue with its phase and whether
it is blocking or pending for the current phase. Templates use explicit
replacement markers so untouched instruction text fails draft validation.

The Run contract is `domain-plan-ledger-coverage`; older Run state is rejected.

## Consequences

Reviewers receive a readable synthesis and an independently parseable ledger,
while writers receive bounded page inputs. Database artifacts remain stable
across deployment environments. Domain pages become useful entry points without
creating a second owner for detailed facts. The kernel takes responsibility
for more deterministic projection and validation, while evidence synthesis,
page boundaries and prose remain agent judgments.
