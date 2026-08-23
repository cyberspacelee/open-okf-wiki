---
id: configuration
type: Configuration
scope: repo
filename: config.md
cardinality: one
required: false
applies_when: Configuration sources or runtime settings materially change behavior, dependencies, safety, or diagnosis.
purpose: Explain behavior-changing configuration, precedence, constraints, and diagnosis without cataloging incidental settings.
---

## Sources and precedence

Identify configuration sources, load and override order, environment selection, reload behavior, and secret injection boundaries.

## Behavior-changing settings

Document only settings whose values change control flow, integrations, limits, safety, or common debugging outcomes, including defaults when evidenced.

## Constraints and diagnosis

Explain validation, incompatible combinations, failure signals, and the smallest checks that reveal the effective value and its source.
