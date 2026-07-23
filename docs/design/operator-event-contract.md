# Operator Event contract

**Status:** accepted (ADR 0031 thorough cut; WP0 contract freeze)  
**Date:** 2026-07-23  
**Authority:** [ADR 0031](../adr/0031-unidirectional-framework-first-operator-surface.md), [ADR 0030](../adr/0030-pi-agent-harness-for-semantic-workflow.md), [ADR 0029](../adr/0029-architecture-cleanup-no-compat.md)  
**Related:** ADR 0026 (Session-centric), ADR 0028 (thin shell + supervisor)

## Purpose

Define **who may produce** which operator-visible signals so that:

1. The **Operator Session** stays the sole conversation truth surface (Pi JSONL + session trajectory).  
2. Dependencies stay **unidirectional**; **Pi framework capabilities** own stream/tool/history shapes.  
3. Product code only injects what the framework does not own (gates, run link, thin phase, produce summaries).

Live transport remains **Pi `AgentSession` events + whitelist product SSE injects** (not AI SDK UIMessage / Mastra).

## Dependency direction

```
Web → Server → Agent → Pi
                 ↘ Core (Run Boundary; no Pi)
```

Web is a **projector**. Server fans out. Agent embeds Pi and may call Core. Core never imports Pi/agent/web.

## Authority table

| Data | Authority | Not authority |
|------|-----------|----------------|
| Operator chat / tools / thinking | Operator Session Pi events + JSONL | Ring buffer alone; client maps; empty product shells |
| Produce child trail (planner/leaf/…) | **Parent Session tool / parent-visible card** (framework-shaped unit on the operator timeline) | `work_unit` PVU, `agent_span`, `child_pi`, `okfAgent`, `workStreams`, `operator-work.json` |
| Plan / publish HITL | Product `gate` + `resume_gate` | Free-text approve |
| Run id / job status | `run_link` + Core Run Record | UI-only run state |
| Spec page queue | Produce `plan_progress` (file-backed) | Invented page lists |
| Review summary | Produce `defects` | Session-synthesized defects |
| Staging / publish | Core | Agent “publish” without boundary |

## Live channels

| Channel | Content | Who |
|---------|---------|-----|
| Pi events (`source: "pi"`) | Opaque parent Operator Session envelope: `kind` + optional `payload` (Pi-owned internals: `message_*`, `tool_execution_*`, agent/turn lifecycle) | Parent `AgentSession` |
| Product injects (`source: "product"`) | **Whitelist only** (below) — thin strip, never a body channel | WikiRunShell / registry / Produce |
| Server heartbeat | keep-alive | server only |

### Product inject whitelist

Canonical list: `PRODUCT_INJECT_KINDS` in `@okf-wiki/contract` (`assertProductInject`).

| `kind` | Allowed to carry | Forbidden |
|--------|------------------|-----------|
| `run_link` | `runId`, job `status` | Assistant prose, tools |
| `run_phase` | Thin phase enum + short `message` | Full thinking/text/tool trails |
| `gate` | plan/publication, plan payload, pages, question | Fake streaming bodies |
| `plan_progress` | Spec page path/status list | LLM free text as progress |
| `defects` | round, clean, counts, short summary | Full reviewer transcripts |

**Deleted (must not parse as product injects):**

- `agent_span`
- `work_unit` (PVU body channel — produce visibility is parent tool, not a product inject)
- `progress` (duplicated thin `run_phase`; not a separate inject)
- `child_pi` / `okfAgent` side path on `source:"pi"`

Any new product `kind` requires an ADR or explicit contract revision.

## Session durability

| Store | Path | Content |
|-------|------|---------|
| Pi JSONL | `.okf-wiki/pi-sessions/<id>/` (framework) | Parent conversation (including parent-visible produce tool units) |
| Operator trajectory | same session dir / `operator-trajectory.jsonl` | Whitelist product rows only (thin strip) |
| Job artifacts | `.okf-wiki/runs/<runId>/analysis/` | Spec, receipts, defects — **not** a second chat body store |

Cold load: `project(Pi history) + project(trajectory thin injects)`. Ring buffer is catch-up only.

## Streaming projection (framework-aligned)

1. Prefer **latest `event.message` snapshot** for assistant streaming (Pi interactive-mode pattern).  
2. Deltas are optional transport; must not be the only path if `message` is present.  
3. Tools: id-keyed lifecycle; dedicated chrome.  
4. Empty streaming UI must not be labeled as model thinking unless thinking content exists.  
5. Produce child work appears as expandable **parent tool / parent-visible card** units — not a product `work_unit` inject fold.

## Session / Web MUST NOT

1. Invent tool or progress rows because Produce was quiet.  
2. Maintain a second message database (`workStreams` as authority, UIMessage history, …).  
3. Treat SSE ring buffer or product injects as durable conversation history alone.  
4. Open operator-visible “streaming” state without framework message/tool content.  
5. Depend upward (web types inside core/agent runtime).  
6. Fan child Pi events onto the bus as peer `source:"pi"` streams.  
7. Emit or project a product body channel (`work_unit`, `agent_span`, empty streaming shells).

## Produce child sessions

In-process child `AgentSession`s remain allowed as **implementation**.  
Operator contract: expandable **parent tool / parent-visible card** on the Operator Session timeline; not a second peer chat timeline and not a product `work_unit` inject.

## Web projection

- Parent Session Pi events (including produce tool units) are the **only** body authority for assistant/tool content.
- Product injects render as thin strips (phase, gate, plan queue, defects) — never as thinking/text/tool bodies.
- Agents tree is **navigation only** when present. No second drawer body host.
- Empty streaming UI shows **waiting for events**, never model “thinking” without thinking content.

## Wipe

Old `.okf-wiki/sessions/*.json` (UIMessage) and Mastra stores remain non-migrated.  
`operator-work.json` and trajectory `work_unit` folds are **removed**.  
Pi sessions + thin-inject `operator-trajectory.jsonl` only.

## Non-goals

- Every JSON field of Pi content blocks.  
- Full React layout specification.  
- Mandating a single global produce session vs many children—if ADR 0031 invariants hold.

## Sample

See `packages/contract/fixtures/operator-trajectory.sample.jsonl`.
