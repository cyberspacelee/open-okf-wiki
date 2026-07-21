# Mastra Wiki Workflow and official AI SDK bridge

**Status:** accepted (observe/operate center refined by [ADR 0026](0026-session-centric-agent-workspace.md); Session stream entry refined by [ADR 0027](0027-framework-first-session-stream.md))  
**Date:** 2026-07-20  
**Related:** ADR 0020 (Mastra + Web), ADR 0023 (stream parts; Session transport superseded here), ADR 0024 (Session as conversational workspace), ADR 0026 (Session-centric agent), ADR 0027 (framework-first stream/HITL)  
**Index:** [docs/adr/README.md](README.md)

## Context

The TypeScript product briefly had two Staging production paths (Session template materialize vs Mastra `runWikiAgent`) and two stream protocols (hand-rolled `WikiStreamPart` → SSE vs AI SDK UIMessage). Session HITL used string prefixes (`__choice__:`) instead of framework resume.

## Decision

1. **Single production path:** Mastra **wiki-run workflow** (`wikiRunWorkflow`) owns plan → write → publish gates. Write always goes through `runWikiAgent` tools (fixture or live). Session and Run console are entrypoints, not alternate writers.
2. **HITL:** Plan and publication use workflow **suspend/resume**. Product REST approve/deny endpoints **resume** the same workflow run id. Session sends explicit `{ intent, runId, step, resumeData }` via AI SDK transport (no `__choice__:` protocol, no text `"approve"` inference). Gate UI is projected as product **`data-gate`** (+ **`data-plan`**) parts—not fake `tool-request_user_decision` / `data-choice`.
3. **Streaming:** Session UI uses `@mastra/ai-sdk` **`toAISdkStream`** over workflow `stream` / `resumeStream` (or equivalent projection into the same UIMessage timeline). Prefer the framework path aligned with `handleWorkflowStream` (or a documented minimal fork when product needs `result()` / abort / no nested `createUIMessageStream`) — see [ADR 0027](0027-framework-first-session-stream.md). Do not reintroduce hand-written Mastra chunk → product SSE projection for Session, and do not maintain a parallel product converter with different semantics. **Single write path does not excuse an empty Session timeline** — agent/workflow activity must still project operator-useful parts into the Session ([ADR 0026](0026-session-centric-agent-workspace.md)).
4. **Run Boundary** stays in `@okf-wiki/core` (path containment, validate, atomic publish, run/session records). Core must not depend on Mastra.
5. **Path policy** primitives (`isPathInside`, `resolveContainedPath`, `assertContainedPathSafe`) live in core; agent re-exports for tools.
6. **Web types** import domain shapes from `@okf-wiki/contract`; `api.ts` is HTTP transport only.
7. **Fixture mode** is an adapter on the same workflow/agent seam (`OKF_WIKI_AGENT_MODE=fixture`), not a Session-only materialize path.

## Consequences

- Session always forces plan confirm (`forcePlanConfirm`) for conversational negotiation even when workspace `planConfirm` is false for headless Run starts.
- Mastra libSQL storage under `$OKF_WIKI_HOME/mastra` (or `~/.okf-wiki/mastra`) holds workflow suspend snapshots; set `OKF_WIKI_MASTRA_STORAGE=memory` for tests.
- Dead parallel DTOs (`WikiRunRequest` / outcome kinds unused by the live path) are removed; frozen inputs live on `StoredRunRecord`.
- ADR 0023’s product SSE for the Run console may remain for job timeline UX, but must not host a second write pipeline.
