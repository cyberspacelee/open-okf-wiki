# Unidirectional dependencies; framework-first operator surface

**Status:** accepted  
**Date:** 2026-07-23  
**Refined by:** [ADR 0032](0032-pi-tool-owned-wiki-runs.md) (removes all product SSE injects, session metadata, and replay state)
**Related:** [0030](0030-pi-agent-harness-for-semantic-workflow.md) (Pi stack), [0026](0026-session-centric-agent-workspace.md) (Session-centric intent), [0028](0028-supervisor-tree-and-thin-workflow-shell.md) (thin shell + produce), [0029](0029-architecture-cleanup-no-compat.md) (no dual paths), [0019](0019-prefer-run-boundary-over-host.md) (Run Boundary)  
**Refines:** 0030 (session/events ownership), 0026 (visibility), operator-event-contract  
**Does not supersede:** Run Boundary (`@okf-wiki/core`), Producer Skill method layer, WikiRunShell gates  
**Index:** [docs/adr/README.md](README.md)  
**Research:** [pi-ui-design-vs-okf-workspace-2026-07](../research/pi-ui-design-vs-okf-workspace-2026-07.md)

## Context

ADR 0030 selected Pi as the agent harness. Implementation then grew **parallel operator-visible state**: product `agent_span` shells, client `workStreams`, ring-buffer catch-up, and `operator-work.json` summaries—while child `AgentSession`s streamed on a side path tagged into the same SSE bus. The operator UI could show “running / thinking” without a truthful Pi message body (empty streaming shells).

That is an **ownership** failure, not a missing drawer widget. Judging by architecture (not patch size):

- Dependencies must stay **unidirectional**.
- **Framework capabilities first** (Pi session, events, tools, JSONL); product only owns what Pi deliberately does not (Run Boundary, plan/publish gates, wiki Spec/receipts).

## Decision

### 1. Layer dependency (strict)

```
Web  →  Server  →  Agent  →  Pi framework
                      ↘
                       Core (Run Boundary)  ← parallel to Pi; no Pi↔Core edge
```

| Layer | May depend on | Must not |
|-------|----------------|----------|
| `@okf-wiki/web` | HTTP/SSE **contracts**, view projection | Own agent lifecycle; invent business progress; treat ring buffer as history truth |
| `@okf-wiki/server` | agent, core, contract | Embed LLM loops; synthesize produce tools/text |
| `@okf-wiki/agent` | Pi SDK, core, contract | Reverse-depend on web; maintain a second UI message DB |
| `@okf-wiki/core` | contract, FS/git only | Import Pi / agent / web |
| Pi packages | (upstream) | Product domain types |

Lower layers never import upper layers. Web never becomes a second runtime.

### 2. Single operator truth surface = one Pi Operator Session

For one operator thread:

| Concern | Authority |
|---------|-----------|
| Durable conversation | **That** session’s Pi JSONL (`SessionManager`) |
| Live trajectory (chat + tools + thinking) | **That** session’s `AgentSession` events |
| Cold load | Project JSONL (+ linked Run Record / analysis artifacts as **read-only** job data) |
| Not authority | SSE ring buffer alone; client-only maps; product injects that invent assistant bodies |

Product Run Records, staging wiki, analysis receipts remain **job** truth under Core/produce. They **attach** to the Session; they do not replace the Session timeline.

### 3. Framework-first usage of Pi

Prefer Pi’s native shapes over product reinvention:

| Need | Use |
|------|-----|
| Stream assistant text / thinking | `message_start` / `message_update` / `message_end` with **full `message` snapshot** as UI authority (Pi TUI pattern); deltas are transport detail |
| Tools | `tool_execution_*` + content `toolCall` blocks; dedicated tool chrome |
| History / resume | `SessionManager` load; tree navigation APIs as needed |
| Embed / automation | SDK `createAgentSession`, or `json` / `rpc` modes—not a third protocol |
| Sub-work isolation | Child `AgentSession` or subprocess **as implementation**; **operator-visible unit** must land on the parent Session as an expandable framework-shaped unit (tool result / structured parent-visible card), not a second peer chat timeline |

### 4. What product may emit (inject whitelist)

Beside the Operator Session’s Pi stream, product may inject **only**:

| Inject | Owner | Purpose |
|--------|-------|---------|
| `run_link` | shell / registry | Bind Run Record id + job status |
| `run_phase` | shell / registry | Thin phase strip (planning / writing / gates / terminal)—**not** assistant prose |
| `gate` | shell | Plan / publication HITL |
| `plan_progress` | Produce | Spec page queue (file-backed) |
| `defects` | Produce | Review summary |

**Not on the whitelist (deleted body channels):** `agent_span`, `work_unit` (PVU), `progress` (duplicate of thin `run_phase`).

**`agent_span` (or successor)** may name supervisor topology for trees/chips **only if** it does **not**:

- create operator-visible “streaming” state without a Pi message body, or  
- become a second body channel that races child Pi events.

Supervisor visibility must ultimately reduce to **parent Session–visible** units (message/tool/card) or a pure status index that cannot fake streaming content.

### 5. Produce / child sessions: implementation vs operator contract

**Allowed:** in-process child `AgentSession`s for planner / domain / leaf / reviewer (ADR 0030).

**Required contract toward the Operator Session:**

1. Child work appears on the **operator timeline** as **expandable units** (preferred: tool-shaped or equivalent parent-visible card), aligned with Pi’s subagent-extension UX: collapsed status + recent activity; expand for full trail.  
2. Live updates to those units come from **framework events** (parent tool partials and/or parent-visible projections of child `message_*` / `tool_execution_*`), reduced with **one streaming pointer per unit**—not a free-floating client `workStreams` true source.  
3. Product injects must not open an empty “streaming” shell that the UI treats as thinking/content.  
4. Web projects events; it does not own child lifecycle.

Fan-in of raw child events onto the operator SSE bus is an **adapter detail**. If used, the adapter must re-home events into the parent Session model (or parent-visible tool details), not invent a parallel transcript store.

### 6. Web projection rules

1. `view = project(operatorSessionEvents [, cold JSONL])`.  
2. Prefer **latest `event.message` snapshot** for assistant streaming (match Pi interactive-mode).  
3. Tools: id-keyed map / components; not only preformatted strings in a bubble.  
4. Empty streaming UI must say **waiting for events**, never mislabel as model “thinking” without thinking content.  
5. No second durable message database in the browser.

### 7. Core remains framework-free

`@okf-wiki/core` stays free of Pi. Freeze, validate, publish, analysis scratch, and Run Records stay Core-owned.

## Consequences

### Positive

- Clear ownership: Pi owns conversation stream; Core owns run boundary; shell owns gates; Web owns pixels.  
- Aligns with ADR 0026/0027/0030 intent without dual UIMessage/Mastra ghosts.  
- Stops empty product shells from masquerading as live agent output.  
- Makes “prefer framework” reviewable in PRs (new client maps / inject body channels are red flags).

### Negative / work

- **PVU deleted → parent tool:** the `work_unit` product inject (parent-visible unit / PVU) is removed from the contract. Produce child visibility must re-home onto the **parent Session as framework-shaped tools** (or equivalent parent-visible cards), not a second product body channel.  
- Child isolation remains; wiring cost lives in the produce adapter that projects into parent tools, not in a dual SSE body path.  
- **UI cut (2026-07):** web finished an earlier surface cut (timeline Work block + units fold). That fold is superseded by parent-tool projection; no Focus drawer / dual body host; Agents tree is nav-only when present.

### Invariants

| Id | Invariant |
|----|-----------|
| U1 | Dependency arrows only downward (Web→Server→Agent→Pi; Agent→Core; never reverse) |
| U2 | One Operator Session Pi JSONL + its events = operator conversation authority |
| U3 | Product injects never invent assistant text/thinking/tool bodies |
| U4 | Subagent operator UX is expandable parent-visible unit, not peer chat timeline as truth |
| U5 | Web is pure projection; no second message DB |
| U6 | Core has no Pi dependency |
| U7 | Ring buffer / client maps are caches, not durability authority |

## Non-goals

- Choosing A vs B produce topology (single session vs many children) in full detail—both OK if U2–U4 hold.  
- Specifying every React component.  
- Migrating old UIMessage history (already wiped under 0030).

## Implementation guidance (non-normative order)

1. Codify inject whitelist in contract tests / server emit allowlist (no `work_unit` / `progress` / `agent_span`).  
2. Re-home produce visibility to parent Session units (tool-shaped preferred).  
3. Align web projector with Pi snapshot + tool map semantics.  
4. Demote or delete parallel body true-sources (`workStreams` as authority, empty span shells, PVU fold).  
5. Keep analysis/Run Record as job artifacts only.

## References

- Pi interactive event→UI: `refs/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`  
- Pi subagent extension UX: `refs/pi/packages/coding-agent/examples/extensions/subagent/`  
- Pi JSON/RPC/SDK docs under `refs/pi/packages/coding-agent/docs/`  
- [operator-event-contract](../design/operator-event-contract.md) (updated with this ADR)
