---
id: data-model
type: Data Model
scope: concept
filename: data.md
cardinality: one
required: false
applies_when: The Concept owns persistent data, a durable schema, or consistency rules that affect maintenance and debugging.
purpose: Explain data ownership, schema, lifecycle, enforced consistency, and safe evolution from the strongest available evidence.
diagram:
  section: Diagram
  kinds: [erDiagram, flowchart]
---

## Ownership and schema

Identify the authoritative owner, stores, entities, identifiers, relationships, and sensitive fields. Prefer Catalog or schema definitions over inferred mappings.

## Read and write lifecycle

Trace creation, reads, updates, deletion or retention, transaction boundaries, and the code paths that perform them.

## Constraints and consistency

Record enforced keys, checks, concurrency controls, idempotency, consistency model, and observable violation behavior without assuming a particular database or ORM.

## Evolution

Explain source-backed migration, compatibility, backfill, rollout, and verification paths for schema or representation changes.

## Diagram

Show only evidenced entities, relationships, stores, or data movement using source identifiers.
