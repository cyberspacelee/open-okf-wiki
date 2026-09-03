# Domain-first compact Catalog planning

Status: accepted

Refines ADR 0022 without changing OKF v0.2. Existing Run state and Plan
artifacts have no compatibility or migration path.

## Context

ADR 0022 made every captured table part of planning closure, but represented
that closure as one full Plan object per table. A 195-table schema produced a
114 KB Plan whose YAML frontmatter occupied almost the entire file. Review and
repair agents repeatedly consumed this machine ledger instead of spending
context on Domain boundaries, behavior and page quality. Run state also copied
the Catalog table index even though its content-addressed `catalog.json` was
already authoritative.

The Plan must retain semantic table classification and exact coverage without
becoming a database query interface or prescribing a page count.

## Decision

The Plan is developed Domain first. Each Domain has its own owner unit, while
additional units express independently routable Concept, model, lifecycle,
flow and operational questions. The Plan sets no unit or page quota.
Composition maps every unit exactly once, gives each Domain an independent
Domain page, and may split a large Domain into further task-oriented pages.

Captured tables are authored as compact `table_groups` sharing a Source, role
and optional Domain. Concept links are derived from Concept Model Bases, and
Catalog locators are derived from the captured index. Proven replica
relationships remain sparse `table_replicas`. The kernel expands these records
in memory to enforce exactly-once table coverage and feed deterministic Schema,
Table and DataModel rendering; it does not persist another expanded ledger.

Run state and publication manifests store only each Catalog's name, content
hash and storage key. The content-addressed `catalog.json` remains the sole
table index, and table shards remain the sole full structural records. Page
manifests still bind the Catalog or table hashes actually cited by that page.

Agents inspect live OpenGauss through `okf db tables` and `okf db describe`,
then inspect a frozen capture through `okf catalog tables` and `okf catalog
describe`. Table-list commands return only a stable count and table names;
details are loaded for one table on demand. Agents do not read Run state or
Catalog storage as a discovery interface.

Generated Schema indexes group tables by Domain and then role. Domain-owned
Table pages live under the Domain within the Catalog reference root; unowned
tables live under a role directory. Stable logical page IDs do not depend on
those physical paths.

## Consequences

Plan size grows mainly with Domains, Concepts and questions rather than with a
repeated per-table object schema. Exact table names remain auditable, but empty
fields and derived relationships disappear from agent context. Catalog data is
stored once and queried through a small deterministic interface. Wiki breadth
follows discovered Domain and maintenance boundaries, while Composition retains
the freedom to split large Domains without a fixed page target.
