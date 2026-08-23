---
id: security
type: Security Model
scope: repo
filename: security.md
cardinality: one
required: false
applies_when: Source evidence defines a trust boundary, protected asset, authentication, authorization, isolation, or security-sensitive data path.
purpose: Explain evidenced trust boundaries, protected assets, controls, enforcement points, and known gaps relevant to code changes.
---

## Trust boundaries

Identify actors, identities, processes, networks, tenants, stores, or repositories across which trust changes, including entry and exit points.

## Protected assets

Name credentials, data, operations, or capabilities being protected, their owner, and material exposure paths.

## Controls

Trace authentication, authorization, isolation, validation, encryption, audit, and failure behavior to their enforcement points. Include only controls present in evidence.

## Known gaps

Record evidenced unprotected surfaces, bypasses, fail-open behavior, or explicitly documented limitations; distinguish confirmed gaps from unanswered questions.
