---
id: state-machine
type: State Machine
scope: concept
filename: states.md
cardinality: one
required: false
applies_when: The Concept has an explicit or distributed source-backed lifecycle with meaningful states, transitions, or guards.
purpose: Make a Concept lifecycle and its allowed, rejected, terminal, and retry transitions directly retrievable.
diagram:
  section: Diagram
  kinds: [stateDiagram-v2]
---

## States

Define each persisted or behaviorally distinct state, its meaning, and whether it is initial, intermediate, terminal, or recoverable.

## Transitions and guards

For every transition, identify the event or call, source guard, state mutation, side effects, and behavior when the guard rejects it.

## Terminal, failure, and retry semantics

Explain terminal behavior, invalid transitions, retry eligibility, idempotency, recovery, and any timeout or expiry semantics.

## Diagram

Show states and labeled transitions using source identifiers and guard names.
