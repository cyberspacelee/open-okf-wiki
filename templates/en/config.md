---
type: Configuration
scope: repo
optional: true
instructions: >-
  Generate only when configuration files, config-center integration, or
  feature flags provide source evidence. Cover: configuration sources and
  precedence (application.yml profiles, environment variables, config-center
  keys such as Nacos/Apollo), the key settings that change behavior with
  their defaults, per-environment differences, and feature flags with their
  activation paths. Cite the declaration or read site for every item; do not
  enumerate all settings — only those whose misconfiguration causes incidents
  or that debugging always checks. For secrets, document source and injection
  only, never values. Implicit single-repo writes at the Wiki root; explicit
  multi-repo writes under <scopeId>/.
---

# {{title}}

{{description}}

## Sources and precedence

## Key settings

## Environment differences

## Feature flags
