# Operator Event contract

**Status:** accepted (Phase 0 of architecture cleanup)  
**Date:** 2026-07-22  
**Authority:** [ADR 0029](../adr/0029-architecture-cleanup-no-compat.md)  
**Related:** ADR 0026 (Session timeline), ADR 0027 (framework-first stream), ADR 0028 (Produce / timeline parts)

## Purpose

Define **who may produce** which Operator Event (`data-*` and stream) parts so the Session timeline stays truthful and there is a **single emit path** for business progress: **Produce**.

Session shell **forwards** framework UIMessage parts. It does **not** invent business progress to compensate for a quiet Produce stream.

## Part table

| Part type | Meaning (operator-facing) | Who may produce | Who must not produce |
|---|---|---|---|
| `data-plan-progress` | Spec page queue / write progress (paths, done/total) | **Produce** (Supervisor produce step / writer.custom) | Session shell, Run REST adapter, SessionTurn fallbacks |
| `data-progress` | Phase strip / step timeline (`planning` → … → `done`/`failed`) | **Produce** | Session shell synthesis; dual HTTP-layer progress protocol |
| `data-defects` | Review council defect list after a round | **Produce** (Host review council path inside produce) | Session inventing defects; soft UI-only defect cards without produce emit |
| `data-agent-span` | Subagent / Domain / Leaf / reviewer span cards | **Produce** (delegation hooks → writer) | Session fabricating spans from logs alone |
| `data-sources-index` | Repo-relative sources index for Sources UI | **Produce** | Session synthesizing source lists outside produce |
| `data-gate` | HITL chip payload (plan / publish options) | Product shell / Session–Run transition (aligned with workflow suspend) | Free-text inference; legacy `data-choice` |
| `data-plan` | Plan / WikiRunSpec payload for gate UI | Produce (spec snapshot) **or** shell when attaching gate context for suspend | Parallel plan DTOs not on the Session timeline |
| `data-run` | Run identity / status projection for timeline | Shell / transition when linking Session ↔ Run; Produce may emit status-aligned run data | Second run lifecycle map that diverges from `mapWorkflowResult` |
| `tool-*` / tool UI parts | Tool call cards (name, args, result snippet) | Framework agent stream inside Produce (via `toAISdkStream` / step writer) | Hand-rolled Session SSE tool protocol |
| `text` / reasoning | Assistant narration and optional thinking | Framework agent stream inside Produce (or help-only SessionTurn replies with **no** fake run progress) | Fake CoT; progress text standing in for `data-progress` |

Notes:

- **Produce** = Layer B Semantic Workflow body (Supervisor produce step of the thin shell `plan-gate → produce → hard-validate → publish-gate`).
- Gate parts are **not** a substitute for progress parts: a suspended plan-gate may show `data-gate` + `data-plan` without inventing mid-run `data-progress`.
- Headless / Run REST automation uses the **same** Produce emit path; it must not become a second progress author.

## Session MUST NOT synthesize business progress

The SessionTurn / session-stream shell **MUST NOT**:

1. Construct `data-plan-progress`, `data-progress`, `data-defects`, `data-agent-span`, or `data-sources-index` because Produce was silent.
2. Reintroduce `data-choice` or free-text `"approve"` / `__choice__:` gate inference.
3. Maintain a second Mastra→UI converter that invents timeline parts outside `toAISdkStream` + Produce `writer.custom`.
4. Paper over missing Produce emissions with heuristic “fake steps” on refresh.

Allowed SessionTurn work (non-exhaustive):

- Intent / mode resolution and turn lock.
- Start / resume param assembly and product abort bind.
- Tee of framework UI stream into outer Session `createUIMessageStream`.
- Optional redaction before persist.
- Help-only text when sources or credentials are missing (**no** fake run progress parts).
- Aligning `data-gate` / durable Session status with the linked Run after suspend/terminal (transition / reconcile — not business progress).

If the timeline lacks progress, **fix Produce** (or the writer path), not Session.

## Deletion test note

Implementation phases should keep **deletion tests** that fail if Session (or server chat adapter) reintroduces business progress synthesis:

| Assert | Intent |
|---|---|
| No Session/server module constructs `data-plan-progress` / `data-progress` / `data-defects` / `data-agent-span` / `data-sources-index` for a live turn | Single emit path |
| No `data-choice` writers remain on the Session path | Legacy gate deleted |
| No references to `OKF_WIKI_DURABLE_PRODUCE` / durable-produce stub as a live feature | Stub deleted |
| Produce path tests still emit the progress parts above via writer | Emit ownership stays in Produce |

Prefer grep/unit guards over documenting dual paths “for compatibility.”

## Non-goals

- Specifying every JSON field of each `data-*` payload (live shapes live in `@okf-wiki/contract` / agent timeline helpers).
- Defining Run console SSE job logs (secondary audit surface; not a second write or progress-author path).
- Migrating historical Session message parts.
