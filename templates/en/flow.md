---
id: flow
type: Flow
scope: domain
filename: flow-{slug}.md
cardinality: many
required: false
applies_when: A distinct cross-Concept runtime scenario has a source-backed trigger, outcome, and ordered path worth retrieving independently.
purpose: Explain one end-to-end runtime scenario, including its branches, failures, side effects, and observable outcome.
diagram:
  section: Diagram
  kinds: [sequenceDiagram, flowchart]
---

## Trigger and outcome

Identify the initiating event or call, required preconditions, intended outcome, and externally observable completion signal.

## Participants and main path

Name source identifiers for each participant and trace the ordered calls, state changes, data movement, and ownership transfers on the successful path.

## Branches, failures, and side effects

Cover meaningful branches, partial failures, retries or compensation, persistent or external side effects, and where each behavior is enforced.

## Verification

Give focused tests, commands, logs, metrics, or state observations that distinguish success from each material failure.

## Diagram

Visualize the ordered scenario with source identifiers and explicit branch or failure edges.
