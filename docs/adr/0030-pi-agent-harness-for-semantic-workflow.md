# Use Pi agent harness for Semantic Workflow; product owns Run shell

**Status:** accepted  
**Date:** 2026-07-22  
**Related:** ADR 0002 (untrusted source), 0019 (Run Boundary), 0026 (Session-centric intent), 0028 (thin shell + supervisor tree intent)  
**Supersedes (framework clauses):** [0020](0020-typescript-mastra-web-workspace.md) Mastra/AI SDK stack; [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) Mastra workflow + `toAISdkStream`; [0027](0027-framework-first-session-stream.md) Mastra + AI SDK as the only stream/HITL backbone  
**Does not supersede:** Run Boundary (`@okf-wiki/core`), Staging/atomic publish, Producer Skill method layer, no-shell source policy (0002), Session as sole human operate surface (0026 intent)  
**Index:** [docs/adr/README.md](README.md)

## Context

The TypeScript product used Mastra agents/workflows and the Vercel AI SDK (`UIMessage` / `useChat` / `toAISdkStream`) as the Semantic Workflow and Session transport. Semantic work is repository-shaped (read sources, write Markdown, tool loops, long sessions). That fit **Pi** (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`) better than a general agent workflow framework.

Re-implementing FS tools (`list_source`, `read_source`, `write_wiki`, …) on Mastra duplicated Pi’s built-ins (`ls`, `find`, `grep`, `read`, `write`, `edit`) and fought Pi’s session/event model.

## Decision

### 1. Runtime stack

| Concern | Implementation |
|---------|----------------|
| LLM transport / providers | `@earendil-works/pi-ai` |
| Agent loop / tool execution / events | `@earendil-works/pi-agent-core` |
| Session JSONL tree, skills, compaction, SDK | `@earendil-works/pi-coding-agent` (`createAgentSession`, `SessionManager`, `AgentSession`) |
| Run Boundary, freeze, validate, publish | `@okf-wiki/core` (unchanged ownership) |
| Plan → produce → hard-validate → publish gates | Product **WikiRunShell** (thin phase machine; **not** Mastra Workflow) |

**Forbidden in product packages:** `@mastra/*`, `ai`, `@ai-sdk/*` as runtime dependencies after cutover.

### 2. Session is Pi-native

- Operator conversation truth = **Pi session JSONL tree** (`SessionManager`), workspace-scoped under `{rootPath}/.okf-wiki/pi-sessions/`.
- Live handle = **`AgentSession`** (`prompt` / `steer` / `followUp` / `abort` / `compact` / `navigateTree`).
- Live transport = **Pi event SSE** (pi-web pattern), not AI SDK `UIMessage` streams.
- **No second message database** (no product UIMessage `SessionMessage[]` history).
- Product Run Records and custom Pi entries (`okf.gate.*`, `okf.run.link`) attach **beside** the session; they do not replace it.
- Zero history compatibility: wipe old `.okf-wiki/sessions/*.json` and Mastra LibSQL stores; no migrators.

### 3. Tools: Pi built-ins first

Use Pi built-in tools; **delete** hand-rolled path-policy tool names.

| Role / phase | Allowlist | Write scope |
|--------------|-----------|-------------|
| Plan exploration, Domain, Leaf, Reviewer, Root research | `read`, `grep`, `find`, `ls` | none |
| Root write / repair | `read`, `grep`, `find`, `ls`, `write`, `edit` | `wiki/**`, `analysis/spec.json` (via policy) |
| All Semantic Workflow roles | **no `bash`** | — |

Multi-root sources fit Pi’s single-cwd model via a **run workdir**:

```text
{runWorkDir}/sources/<id>/   # snapshot (read-only)
{runWorkDir}/skill/          # Producer Skill (read-only)
{runWorkDir}/wiki/           # Staging (writable for write roles)
{runWorkDir}/analysis/       # spec, receipts
```

Effective Source Ignores and write-scope are enforced with Pi **Operations wrappers** (and/or tool allowlists), not custom FS tool APIs.

Custom tools only when Pi cannot express the action (e.g. `delegate_domain` / `delegate_leaf` spawning child sessions). Do not reintroduce `list_source` / `read_source` / `write_wiki`.

### 4. Supervisor tree

Domain / Leaf / Reviewer = **in-process child `AgentSession`s** with read-only tool allowlists and host budgets (product `delegation` / `limits`). Prefer SDK embedding over spawning the `pi` CLI.

### 5. Operator UI

- Vite + React + **shadcn (Base UI)** kit retained.
- **IA/UX redesigned**: Agent Workspace (session-home, panels for sources/wiki/run), not multi-tab peer pages.
- Patterns from pi-web (SSE, tool cards, tree, context meter); not Next.js / pi-web as host.

### 6. No-compat cutover

Same spirit as ADR 0029: hard cut, no dual runtime, no dual protocol, no “temporary” Mastra/AI SDK production path on the migration tip.

## Consequences

- Large delete/rewrite of `packages/agent` framework glue, server Session routes, and web Session UI.
- ADR 0026 “Session surface” is re-read as **Pi session + projected events**.
- ADR 0028 topology (thin shell + supervisor produce + review council) remains; implementation moves off Mastra Workflow/Agent.
- CONTEXT.md and operator-event-contract must drop Mastra/AI SDK language.
- Enterprise OpenAI-compatible gateways go through pi-ai / ModelRuntime.

## Invariants

| Id | Invariant |
|----|-----------|
| P1 | No `@mastra/*` / `ai` / `@ai-sdk/*` in product runtime after cutover |
| P2 | Conversation persist = Pi JSONL only |
| P3 | FS tools = Pi built-ins + phase allowlists; bash off for Semantic Workflow |
| P4 | WikiRunShell owns plan/publish job phases; Pi owns conversation |
| P5 | core has no Pi/Mastra framework dependency |
| P6 | Zero history migration for old Operator Session JSON |
