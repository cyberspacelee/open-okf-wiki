# Operator Session stream parts and plan-confirm gate

**Status:** accepted (partially superseded for Session transport)  
**Date:** 2026-07-19  
**Related:** ADR 0018 (HITL publication), ADR 0020 (Mastra + Web), ADR 0022 (source clone)  
**Superseded (partial) by:** [ADR 0024](0024-session-as-conversational-workspace.md) (Session as conversational workspace), [ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) (Session stream = AI SDK UIMessage + `toAISdkStream`; single write path)

## Context

Interactive operators need Claude Code–like visibility of model text, tool use, and subagents during a Wiki Run, without treating the Semantic Workflow as a resumable chat transcript. They also need an optional plan confirmation gate before wiki pages are written.

## Decision

1. **Session UI** provides multi-part operator visibility (Markdown, tool cards, subagent cards, decisions).  
   - **Current transport (Session):** AI SDK UIMessage stream via `@mastra/ai-sdk` `toAISdkStream` over the wiki-run workflow ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)). Do **not** reintroduce hand-rolled Mastra → product SSE for Session.  
   - **Run console:** product SSE job timeline may remain for headless/job UX; it must **not** host a second write pipeline ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)).
2. **Wiki Run** remains a bounded job with frozen skill digest; Manual Retry is a new run.
3. **Stream content** stays operator-safe (redaction/truncation; no CoT by default). Concrete part shapes follow AI SDK `parts` / product data parts on Session; coarse log/status/part events on Run SSE.
4. **Plan-confirm** is an optional Workspace flag: when enabled (and not autoApprove), the run enters `awaiting_plan` until the operator approves or declines; approve resumes a write phase with the confirmed plan. Session conversational entry may force plan confirm even when the Workspace flag is off ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)).
5. **Publication HITL** remains after write (`awaiting_publication`), via workflow suspend/resume (same run id for REST and Session).
6. **Adaptive/Reviewer** use Mastra child agents with research-only tools; Root alone writes wiki Staging.

## Historical wording (obsolete)

Earlier text said Session was driven by “product SSE projected from Mastra `fullStream`” and that Web “current long runs use SSE + parts.” That described a transitional UI before ADR 0024/0025. **Do not implement Session chat that way.**

## Consequences

- Session primary UI: `useChat` + message `parts` ([ADR 0024](0024-session-as-conversational-workspace.md)).
- Headless and autoApprove paths skip plan-confirm and may auto-publish.
- e2e covers fixture timeline, plan-confirm, skill fork, and publish HITL.
