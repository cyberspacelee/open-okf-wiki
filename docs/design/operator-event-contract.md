# Operator Event contract

**Status:** accepted (rewritten for ADR 0030)  
**Date:** 2026-07-22  
**Authority:** [ADR 0030](../adr/0030-pi-agent-harness-for-semantic-workflow.md), [ADR 0029](../adr/0029-architecture-cleanup-no-compat.md)  
**Related:** ADR 0026 (Session-centric intent), ADR 0028 (thin shell + supervisor intent)

## Purpose

Define **who may produce** which operator-visible timeline signals so the Session stays truthful and there is a **single emit path** for business progress: **Produce** (and product shell for gates only).

Live transport is **Pi `AgentSession` events + thin product SSE injects** (not AI SDK UIMessage / Mastra `toAISdkStream`).

## Live channels

| Channel | Content | Who |
|---------|---------|-----|
| Pi events (`source: "pi"`) | text deltas, thinking, tool_execution_*, agent lifecycle | Pi AgentSession |
| Product injects (`source: "product"`) | `run_phase`, `gate`, `run_link`, `progress`, `agent_span`, `defects` | WikiRunShell / registry / Produce sink |
| Server heartbeat | keep-alive | server only |

Durable conversation = **Pi JSONL** under `.okf-wiki/pi-sessions/` (cold-load via `GET …/agent/sessions/:id`).  
Durable job = **Run Record** under core.  
**No** UIMessage `OperatorSession.messages` trajectory synthesis.

## Business progress ownership

| Signal | Who may produce | Who must not |
|--------|-----------------|--------------|
| Tool cards / assistant text | **Pi session** during produce/chat | Session UI inventing tools without SSE |
| Plan/publish gates | **Product shell** (`resume_gate` / product SSE) | Free-text `"approve"` inference |
| Run phase / run link | **Shell / registry** | Dual lifecycle maps |
| Spec progress / defects / agent spans | **Produce** (`produceWiki` event sink → product SSE) | Session shell synthesis / job UIMessage append |

## Session MUST NOT

1. Invent tool or progress rows because Produce was quiet.  
2. Maintain a second Mastra/AI SDK converter.  
3. Use UIMessage `data-*` as the persistence model (historical; wiped).

## Wipe

Old `.okf-wiki/sessions/*.json` (UIMessage) and Mastra LibSQL stores are not migrated. Use Pi sessions only.

## Non-goals

- Specifying every JSON field of Pi assistant message content.  
- Requiring Mastra workflow snapshots for audit.
