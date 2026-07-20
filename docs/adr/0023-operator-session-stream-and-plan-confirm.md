# Operator Session stream parts and plan-confirm gate

**Status:** accepted  
**Date:** 2026-07-19  
**Related:** ADR 0018 (HITL publication), ADR 0020 (Mastra + Web), ADR 0022 (source clone)

## Context

Interactive operators need Claude Code–like visibility of model text, tool use, and subagents during a Wiki Run, without treating the Semantic Workflow as a resumable chat transcript. They also need an optional plan confirmation gate before wiki pages are written.

## Decision

1. **Session UI** evolves the Run console: multi-part timeline (Markdown, tool cards, subagent cards) driven by product SSE events projected from Mastra `fullStream` (and fixture synthetic parts).
2. **Wiki Run** remains a bounded job with frozen skill digest; Manual Retry is a new run.
3. **Stream protocol** uses operator-safe parts (`text`, `tool`, `tool_result`, `part`) with redaction/truncation; no CoT by default.
4. **Plan-confirm** is an optional Workspace flag: when enabled (and not autoApprove), the run enters `awaiting_plan` until the operator approves or declines; approve resumes a write phase with the confirmed plan.
5. **Publication HITL** remains server-owned after write (`awaiting_publication`).
6. **Adaptive/Reviewer** use Mastra child agents with research-only tools; Root alone writes `/wiki`.

## Consequences

- Web depends on `ai` / `@ai-sdk/react` for future chat transport; current long runs use SSE + parts rendering.
- Headless and autoApprove paths skip plan-confirm and may auto-publish.
- e2e covers fixture timeline, plan-confirm, skill fork, and publish HITL.
