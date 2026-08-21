---
type: Architecture
altitudes: [wiki, repo]
diagram: flowchart
optional: false
instructions: >-
  At wiki root, describe how Git Sources and external systems compose:
  container boundaries, dependencies, and failure domains. On an implicit
  single-source Workspace, continue with this repo's internal containers on
  the same page. Under repos/<scopeId>/, describe only that Source's internals,
  link to /architecture.md, and do not repeat the cross-Source system map.
  In Components, every node is a source identifier, one-sentence
  responsibility, and its inbound and outbound edges.
---

# {{title}}

{{description}}

## Components

## Boundaries and dependencies

## Extension and failure modes

## Diagram

```mermaid
flowchart TD
  {{diagram}}
```
