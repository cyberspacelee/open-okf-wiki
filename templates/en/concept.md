---
id: concept
type: Concept
scope: concept
identity: concept
filename: concept.md
cardinality: one
required: true
purpose: Give a developer the observable contract and exact edit-and-verify path for one source-identified Concept.
table:
  section: Invariants and constraints
  columns: [Invariant, Enforced at, Violation signal, Verify]
---

## Purpose and public surface

Explain the Concept's responsibility, callers or consumers, inputs, outputs, and source identifiers that form its observable interface.

## Lifecycle and failure semantics

Describe creation, use, state-changing behavior, termination, errors, retries, and cleanup when evidenced. Link a dedicated state or flow page for detailed paths.

## Invariants and constraints

Record rules enforced by code, schema, or state guards. Use `Invariant | Enforced at | Violation signal | Verify`; distinguish invariants from preconditions and design wishes.

## Change surface and verification

Name the implementation, contracts, callers, persistence, and tests affected by a change, followed by the smallest focused verification commands or test paths.
