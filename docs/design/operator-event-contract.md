# Operator Event contract

**Status:** accepted (refined for ADR 0031)  
**Date:** 2026-07-23  
**Authority:** [ADR 0031](../adr/0031-unidirectional-framework-first-operator-surface.md), [ADR 0030](../adr/0030-pi-agent-harness-for-semantic-workflow.md), [ADR 0029](../adr/0029-architecture-cleanup-no-compat.md)  
**Related:** ADR 0026 (Session-centric), ADR 0028 (thin shell + supervisor)

## Purpose

Define **who may produce** which operator-visible signals so that:

1. The **Operator Session** stays the sole conversation truth surface (Pi JSONL + its events).  
2. Dependencies stay **unidirectional**; **Pi framework capabilities** own stream/tool/history shapes.  
3. Product code only injects what the framework does not own (gates, run link, thin phase, file-backed produce summaries).

Live transport remains **Pi `AgentSession` events + thin product SSE injects** (not AI SDK UIMessage / Mastra).

## Dependency direction

```
Web → Server → Agent → Pi
                 ↘ Core (Run Boundary; no Pi)
```

Web is a **projector**. Server fans out. Agent embeds Pi and may call Core. Core never imports Pi/agent/web.

## Authority table

| Data | Authority | Not authority |
|------|-----------|----------------|
| Operator chat / tools / thinking | Operator Session Pi events + JSONL | Ring buffer alone; client `workStreams`; empty product shells |
| Plan / publish HITL | Product `gate` + `resume_gate` | Free-text approve |
| Run id / job status | `run_link` + Core Run Record | UI-only run state |
| Spec page queue | Produce `plan_progress` (file-backed) | Invented page lists |
| Review summary | Produce `defects` | Session-synthesized defects |
| Staging / publish | Core | Agent “publish” without boundary |

## Live channels

| Channel | Content | Who |
|---------|---------|-----|
| Pi events (`source: "pi"`) | `message_*`, `tool_execution_*`, agent/turn lifecycle; payload shaped as Pi `AgentEvent` | Operator Session (and **only** re-homed child visibility that still appears as parent-visible units) |
| Product injects (`source: "product"`) | **Whitelist only** (below) | WikiRunShell / registry / Produce sink |
| Server heartbeat | keep-alive | server only |

### Product inject whitelist

| `kind` | Allowed to carry | Forbidden |
|--------|------------------|-----------|
| `run_link` | `runId`, job `status` | Assistant prose, tools |
| `run_phase` | Thin phase enum + short `message` | Full thinking/text/tool trails |
| `gate` | plan/publication, plan payload, pages, question | Fake streaming bodies |
| `plan_progress` | Spec page path/status list | LLM free text as progress |
| `defects` | round, clean, counts, short summary | Full reviewer transcripts |
| `progress` | Short produce label | Duplicate of tool/message stream |
| Supervisor index (e.g. `agent_span`) | Topology id/role/status/task **index** | Opening UI “streaming” without Pi message body; racing a second body channel |

Any new product `kind` requires an ADR or explicit contract revision.

## Business progress ownership

| Signal | Who may produce | Who must not |
|--------|-----------------|--------------|
| Tool cards / assistant text / thinking | **Pi session events** (parent-visible units) | Web inventing rows; product injects as body |
| Plan/publish gates | **Product shell** | Free-text `"approve"` inference |
| Run phase / run link | **Shell / registry** | Dual lifecycle maps as truth |
| Spec queue / defects | **Produce** → product inject | Session shell synthesis |
| Child planner/leaf trail | Produce **re-homed** onto parent-visible units (tool-shaped preferred) | Parallel client true-source maps; empty span shells |

## Streaming projection (framework-aligned)

1. Prefer **latest `event.message` snapshot** for assistant streaming (Pi interactive-mode pattern).  
2. Deltas (`assistantMessageEvent`) are optional transport; must not be the only path if `message` is present.  
3. Tools: id-keyed lifecycle; dedicated chrome.  
4. Empty streaming UI must not be labeled as model thinking unless thinking content exists.

## Session / Web MUST NOT

1. Invent tool or progress rows because Produce was quiet.  
2. Maintain a second message database (UIMessage, parallel durable transcript, authoritative `workStreams`).  
3. Treat SSE ring buffer or product injects as durable conversation history.  
4. Open operator-visible “streaming” state without framework message/tool content.  
5. Depend upward (web types inside core/agent runtime).

## Produce child sessions

In-process child `AgentSession`s remain allowed as **implementation**.  
Operator contract: expandable **parent-visible** unit (see ADR 0031 §5); not a second peer chat timeline as truth.

## Wipe

Old `.okf-wiki/sessions/*.json` (UIMessage) and Mastra stores remain non-migrated. Pi sessions only.

## Non-goals

- Every JSON field of Pi content blocks.  
- Full React layout specification.  
- Mandating a single global produce session vs many children—if ADR 0031 invariants hold.
