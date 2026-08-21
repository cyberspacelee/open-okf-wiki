---
type: API Contract
scope: repo
optional: true
instructions: >-
  Generate only when this repository exposes callable interfaces
  (REST/RPC/GraphQL/OpenAPI). List endpoints from the consumer's view: path
  or method name, request/response essentials, authentication requirements,
  idempotency, and error semantics. Every endpoint needs source evidence from
  a controller/handler/proto/OpenAPI file; never infer from call sites. Group
  by resource or capability when there are many, and enumerate them — do not
  defer to "see the code". Compatibility and evolution covers versioning
  policy, deprecation markers, and evidenced breaking changes; state when
  there are none. Implicit single-repo writes at the Wiki root; explicit
  multi-repo writes under <scopeId>/.
---

# {{title}}

{{description}}

## Authentication and conventions

## Endpoint inventory

## Error semantics

## Compatibility and evolution
