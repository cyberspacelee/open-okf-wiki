---
id: architecture
type: Architecture
altitudes: [wiki, repo]
identity: repo
filename: architecture.md
cardinality: one
required: true
purpose: Explain structural composition, ownership seams, dependencies, and failure propagation at the current altitude.
diagram:
  section: Diagram
  kinds: [flowchart]
---

## Components

Name each source-level module or external system, its responsibility, and the public surface through which other modules use it. At Wiki altitude cover cross-Source composition; at repository altitude cover only that Source's internals.

## Boundaries and dependencies

Explain ownership, allowed dependency directions, trust or process boundaries, and the contracts crossing them. Link to the other altitude instead of duplicating it.

## Failure and change impact

Trace material failure propagation and identify which modules, contracts, or verification paths are affected by structural changes.

## Diagram

Show the components and directional dependencies with source identifiers as Mermaid nodes.
