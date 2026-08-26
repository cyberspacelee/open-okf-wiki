---
type: Architecture
title: "{title}"
description: "{routing: structural map — modules, boundaries, failure paths}"
coverage: full
sources: []
---

## Modules and responsibilities

Source-level modules and external systems, each with its responsibility and
the surface it exposes to others.

## Boundaries and dependencies

Ownership, allowed dependency directions, trust or process boundaries, and
the contracts that cross them.

## Failure and change propagation

How key failures propagate; which modules, contracts, and validation paths a
structural change touches.

## Diagram

Mermaid flowchart; node IDs are source identifiers.

## Decisions

Link existing ADRs. Without one, state the observed decision with a locator —
never invent its rationale (see contract: coverage honesty).
