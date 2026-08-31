# Run policy and bounded host fan-out

Status: accepted

Extends ADR 0019. There is no compatibility or migration path for prior
Workspace, Run or Publication state.

## Context

Evidence search/read limits were private Python constants. A Run therefore did
not disclose its effective evidence surface, configuration changes could not be
audited, byte counts approximated snippets rather than serialized output, and a
truncated search had no continuation cursor.

Subagent concurrency was only prose in the skill. The live grader searched for
host error strings, so a successful burst of many children could pass. The same
risk applied to evidence research, page writing and repair fan-out.

Copied skills and multiple same-named Codex scopes also allowed current
instructions to be paired with an older kernel command surface.

## Decision

Workspace, Run and Publication manifest remain fixed at schema v1. Their strict
required fields define the current greenfield contract: Run snapshots the
Workspace policy at start, rejects later bundle changes through an operational
skill digest, and Publication records both. Incomplete state and removed
scheduler identity parameters remain errors; there is no migration schema.

The evidence policy configures search result count, read default/maximum lines,
and UTF-8 compact-JSON stdout byte limits. The kernel enforces those limits on
complete response items. Search and read expose stable continuation locators,
and distinguish a policy limit from remaining captured content.

The agent policy defaults to four concurrently active children, spawn depth
one, and 128 unique children per Run. It applies globally to evidence, planning
review, page writing, repairs and bundle review. The coordinator maintains a
rolling window; children do not spawn. Host adapters map the requested active
limit to a native session cap. The kernel discloses policy but remains free of
worker leases and scheduler identity.

Live evaluation records requested and host-effective caps. Its grader rebuilds
successful spawn, terminal completion, active high-water, depth, total fan-out
and rolling refill from structured trace events.

## Consequences

Evidence behavior is reproducible within a Run and smaller budgets remain
navigable. Native host caps protect the API even when a prompt is ignored, while
trace grading proves observed behavior instead of inferring it from absent
errors. The coordinator must count unique children and reuse handles for
follow-up work.

Local development should use one linked skill source. Copied installations must
be reinstalled as an atomic bundle and tracked by their installer lock; a Run
fails if its operational bundle changes midway.
