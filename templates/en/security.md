---
type: Security Model
scope: repo
optional: true
instructions: >-
  Generate only when authentication, authorization, or data-level permissions
  have source evidence (e.g. Spring Security configuration, gateway filters,
  annotation-based checks, tenant isolation logic). Cover: the
  authentication chain (where tokens originate, where they are validated,
  failure behavior), the role and permission model (role definitions,
  permission points, check sites), and data permissions (row-level or tenant
  filtering implementation). Claims about unprotected paths require source
  evidence of the permit rule. This documents the protection structure, not
  a penetration guide; do not invent a threat model. Implicit single-repo
  writes at the Wiki root; explicit multi-repo writes under <scopeId>/.
---

# {{title}}

{{description}}

## Authentication chain

## Roles and permissions

## Data permissions

## Unprotected surface
