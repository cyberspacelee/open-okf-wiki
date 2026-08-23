---
id: domain
type: Domain
scope: domain
identity: domain
filename: domain.md
cardinality: one
required: true
purpose: Own the cross-Concept responsibilities, collaboration rules, invariants, and change impact for one Domain.
---

## Responsibilities and boundaries

State what the Domain owns, what it excludes, its public entry points, and where responsibility transfers to another Domain or external system.

## Concept collaboration

Explain source-backed calls, data movement, ordering, and ownership transfer between Concepts. Link to Concept pages instead of enumerating or restating them.

## Invariants and constraints

Record only enforced rules, not aspirations or caller advice. Use `Invariant | Enforced at | Violation signal | Verify` when multiple rules exist.

## Change impact and verification

Identify the affected Concepts, contracts, consumers, failure paths, and the smallest source-backed checks that establish a safe change.
