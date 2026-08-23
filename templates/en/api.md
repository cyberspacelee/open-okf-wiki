---
id: api
type: API Contract
scope: repo
filename: api-{slug}.md
cardinality: many
required: false
applies_when: The repository exposes a distinct callable public interface whose consumers need a source-backed contract.
purpose: Document one coherent network or programmatic public interface from the consumer's point of view.
---

## Consumers and conventions

Identify intended consumers, entry mechanism, authentication or authorization when present, naming, encoding, versioning, idempotency, and other shared conventions.

## Surface

Enumerate the callable operations, paths, messages, or exported symbols with essential inputs, outputs, and declaration evidence. Group only within this coherent interface.

## Failure semantics

Document validation failures, error values or responses, retryability, partial success, timeouts, and observable failure behavior.

## Compatibility

Explain compatibility guarantees, deprecation or migration paths, and source-backed breaking-change constraints.
