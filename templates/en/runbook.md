---
id: runbook
type: Runbook
scope: repo
filename: runbook-{slug}.md
cardinality: many
required: false
applies_when: Operational evidence defines a distinct incident signal, diagnosis path, safe recovery, and post-recovery verification.
purpose: Provide one executable operational diagnosis and recovery procedure with explicit safety and stop conditions.
---

## Signals and impact

Define triggering alerts, logs, metrics, symptoms, affected users or systems, and evidence that distinguishes this incident from similar failures.

## Diagnosis

Give ordered checks, commands, decision points, expected observations, and the source or operational artifact supporting each step.

## Recovery

Give the safest reversible actions first, including prerequisites, side effects, abort conditions, and escalation points.

## Verification and escalation

Define recovery success, regression monitoring, cleanup, and the exact conditions requiring escalation.
