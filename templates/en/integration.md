---
type: Integration
scope: domain
optional: true
diagram: flowchart
instructions: >-
  Generate only when this Domain has source evidence of asynchronous or
  cross-system integration: message production/consumption (topics, consumer
  groups, retry and dead-letter), scheduled jobs (scheduler, cron,
  idempotency), external system calls (clients, timeouts, fallbacks), and
  event contracts (payload shape and versioning). This is inventory
  knowledge: flows.md narrates one scenario; this page lists every
  integration point the Domain produces or consumes. Cite the declaration
  site for each; the diagram shows integration topology (this Domain's
  connections to topics/jobs/external systems) with source identifiers as
  nodes.
---

# {{title}}

{{description}}

## Message production and consumption

## Scheduled jobs

## External calls

## Event contracts

## Diagram

```mermaid
flowchart TD
  {{diagram}}
```
