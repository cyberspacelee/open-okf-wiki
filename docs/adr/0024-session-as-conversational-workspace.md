# Session as Conversational Workspace

**Status:** accepted (product center refined by [ADR 0026](0026-session-centric-agent-workspace.md))  
**Date:** 2026-07-20  
**Related:** ADR 0018 (HITL), ADR 0020 (Mastra + Web), ADR 0023 (stream parts), ADR 0026 (Session-centric agent)

## Context

Treating Session as a single Wiki Run request cannot support multi-turn negotiation: plan approval with free-text edits, reject-and-replan, candidate selection, interrupt/resume, or correct AI SDK message/tool streaming UI.

## Decision

1. **Session** is a first-class **Conversational Workspace** (own page), not a Run console alias.
2. A Session holds:
   - **Conversation**: ordered UIMessages (`parts`: text, tool-*, data-* interactions)
   - **Workflow state**: plan, pending interaction, linked run ids
   - **Runtime**: agent stream interrupt/resume within the session thread
3. **Frontend** uses AI SDK `useChat` + `DefaultChatTransport` + message `parts` rendering (no hand-rolled markdown/tool stream protocol).
4. **Backend** streams via AI SDK UI message stream (`createUIMessageStream` / `pipeUIMessageStreamToResponse`).
5. **Approvals and choices** are **interaction messages** (data parts / client tool results), not only dedicated approve/reject endpoints. Legacy run HITL APIs remain for headless paths.
6. **Wiki Run** remains a bounded production job that may be *started from* a Session; Session history is not the Semantic Workflow **graph** checkpoint for Manual Retry (frozen run inputs still apply). Per [ADR 0026](0026-session-centric-agent-workspace.md), the Session **operator timeline must still be durable and complete** (including background runs).

## Consequences

- Route: `/workspaces/:id/session` (chat UI); `/run` is job index / logs (read-mostly for humans; [ADR 0026](0026-session-centric-agent-workspace.md)).
- Persistence under `{workspace}/.okf-wiki/sessions/`.
- Fixture mode must stream valid UIMessage chunks so e2e can assert text + tool parts without a live model.
