---
id: integration
type: Integration
scope: domain
filename: integration.md
cardinality: one
required: false
applies_when: The Domain produces or consumes asynchronous work or crosses a process, repository, vendor, or deployment boundary.
purpose: Inventory the Domain's integration points and the contracts, delivery behavior, and recovery semantics that govern them.
diagram:
  section: Diagram
  kinds: [flowchart]
---

## Integration points

Inventory each produced or consumed call, event, job, file, generated artifact, or shared schema with its direction, owner, and declaration site.

## Contracts and delivery

Describe payload or call contracts, versioning, ordering, delivery guarantees, idempotency, scheduling, timeouts, and compatibility only where applicable.

## Failures and recovery

Explain observable failures, retries, dead letters, fallbacks, compensation, replay, and operator or developer verification for each material integration.

## Diagram

Show the Domain and its integration endpoints with directional edges and source identifiers.
