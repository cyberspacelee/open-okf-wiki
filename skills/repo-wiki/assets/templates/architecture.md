---
type: Architecture
title: "{title}"
description: "{routing: structural map — modules, boundaries, failure paths}"
coverage: full
resource: "{optional asset URI}"
tags: [architecture]
sources: []
---

## Modules and responsibilities

Source-level modules and external systems, each with its responsibility and
the surface it exposes to others.

## Boundaries and dependencies

Ownership, allowed dependency directions, trust or process boundaries, and
the contracts that cross them.

For every cross-source connection, link to both source-owned pages. Markdown
links are graph edges; do not duplicate either page's content here.

## Failure and change propagation

How key failures propagate; which modules, contracts, and validation paths a
structural change touches.

## Diagram

Mermaid flowchart; node IDs are source identifiers.

## Decisions

Link existing ADRs. Without one, state the observed decision with a locator —
never invent its rationale (see contract: coverage honesty).
