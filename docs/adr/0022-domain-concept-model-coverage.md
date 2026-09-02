# Domain, Concept and model coverage

Status: accepted

Supersedes the admission and empty-Publication decisions in ADR 0002 and ADR
0019, and the corresponding planning boundary in ADR 0021. It retains OKF v0.2
and has no compatibility or migration path.

## Context

The Grep Test kept authored pages focused, but it also allowed a large Source to
collapse into a few umbrella pages and excluded the data model readers needed to
understand the system. Database Catalogs were valid evidence without being a
required structural input. A configured schema could therefore contribute only
table-name footnotes while writers reconstructed a smaller and sometimes
incorrect model from ORM code.

Database configuration is optional. When present, the supported product is
OpenGauss. Its captured schema should own physical facts for the Concepts it
covers; repositories without it still need a useful logical model recovered
from code.

## Decision

The Knowledge Plan gains one coverage ledger containing Source Areas, Domains,
Concepts, table dispositions, relationships, Knowledge Units and structured
Gaps. This remains the existing Plan phase: adding another phase would duplicate
its cross-Source recall and review loop. Every Source Area, Domain, Concept and
captured table must close before Plan approval. Domain and Concept records point
to their unique owner units; persistent Concepts also point to one data-model
unit. Composition maps those units to pages and adds one Reference Root per
OpenGauss Source.

Model Basis is selected per Concept:

- `opengauss` makes the captured Catalog primary for physical structure while
  code supplies behavior, state meaning and service ownership;
- `code` recovers a logical model from DDL/migrations, ORM annotations or XML,
  SQL/mappers and persistence code in that order;
- `none` represents a non-persistent Concept.

A configured OpenGauss capture either succeeds or blocks the Run. Code may
describe a partial model for a relevant table omitted from the configured
selection only with an explicit `catalog-selection` Gap. Public database Source
configuration accepts OpenGauss only.

The kernel deterministically generates Schema and Table reference pages from
Catalog facts, Plan dispositions and Composition Reference Roots. It also
publishes their stable IDs and paths in a read-only derived Reference Map before
writing, and inserts the OpenGauss physical model into the DataModel generated
marker.
Writers define Domain and Concept semantics, code behavior and logical
relationships; they do not copy field inventories. Physical constraint ER and
code-derived logical ER remain distinct. Mermaid line styles retain their
identifying-relationship meaning and never encode confidence.

The Grep Test remains the admission rule for optional depth pages such as
Procedure, Flow and Lifecycle. It cannot remove mandatory Domain, Concept,
persistence-model or captured-table coverage. An empty Plan, Composition or
Candidate is invalid.

The Run contract is `domain-concept-model-coverage`. Existing Run state is
rejected rather than migrated, and the OKF version remains v0.2.

## Consequences

Wiki size follows discovered business and model boundaries instead of Source
count or a page quota. OpenGauss-backed pages become structurally complete and
traceable to captured tables; code-only projects retain logical-model coverage.
Planning and review carry more structured records, while schema inventories and
physical diagrams require no LLM writing.
