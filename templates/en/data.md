---
type: Data Model
scope: concept
diagram:
  - erDiagram
  - flowchart
optional: true
instructions: >-
  Generate this page when the Concept owns persistent data. Evidence priority
  for schema and the ER diagram: prefer Catalog tools (db_tables /
  db_describe) for live table definitions; without a Catalog use migration
  scripts (Flyway/Liquibase db/migration, schema.sql); reverse-engineer from
  ORM annotations or mapper XML only as a last resort. Entities, columns, and
  foreign keys in the diagram must match the chosen evidence; never invent
  them. Transactions and locking covers transaction boundaries (e.g.
  @Transactional propagation and rollback), optimistic/pessimistic locking,
  distributed transactions or outbox; when the source shows none, state that
  explicitly and cite the write entry points. Ground ownership, read/write
  paths, consistency, migrations, and sensitive-data handling in evidence.
---

# {{title}}

{{description}}

## Ownership and schema

## Read and write paths

## Transactions and locking

## Constraints and consistency

## Migration and sensitive data

## Diagram

```mermaid
erDiagram
  {{diagram}}
```
