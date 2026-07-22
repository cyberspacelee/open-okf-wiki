# Architecture cleanup with no historical compatibility

**Status:** accepted  
**Date:** 2026-07-22  
**Related:** ADR 0026 (Session-centric agent), ADR 0027 (framework-first Session stream), ADR 0028 (thin Workflow shell + Supervisor produce)  
**Supersedes (partial):** dual Operator Event emit paths; Session synthesis of business progress; optional `OKF_WIKI_DURABLE_PRODUCE` reservation in [0028](0028-supervisor-tree-and-thin-workflow-shell.md); `data-choice` / free-text gate leftovers; Session business fallbacks that paper over missing Produce parts  
**Index:** [docs/adr/README.md](README.md)

## Context

ADRs 0026–0028 fixed product center (Session), stream/HITL conversion (framework-first), and Wiki generation topology (thin shell + Supervisor produce). Implementation still carried parallel emit paths, Session-layer synthesis of business progress, reserved durable-produce stubs, adaptive aliases, and legacy gate parts (`data-choice`). Those leftovers reintroduce dual protocols and hide missing Produce emissions.

This refactor is **no-compat**: wipe on-disk sessions rather than migrate; delete stubs rather than feature-flag them; one emit path rather than dual projection.

## Decision

### 1. No historical compatibility

- Do **not** migrate old Session files, dual stream converters, adaptive/reviewer workspace flags, or legacy gate part types.
- When Session on-disk shape changes (see §2), reject unsupported `schemaVersion` and require an operator wipe — same pattern as ADR 0027 for v1→v2, applied again for v2→v3.

### 2. Session schema v3 (wipe sessions)

- Bump product Session `schemaVersion` to **3** (implementation phase after this ADR).
- **Reject** on-disk sessions with missing or non-3 `schemaVersion` — **no migrate-from-v2**.
- Operator wipe: delete `.okf-wiki/sessions/*.json` (or the named file) and create a new Operator Session. Do not hand-edit JSON to set `schemaVersion: 3`.

### 3. Single Operator Event emit from Produce

- **Produce** (Layer B Semantic Workflow body — Supervisor produce step inside the thin Workflow shell) is the **only** producer of business Operator Event parts: `data-plan-progress`, `data-progress`, `data-defects`, `data-agent-span`, `data-sources-index`, and related run-timeline payloads.
- Session shell **forwards** framework UI stream parts; it **MUST NOT** synthesize business progress, invent plan-progress, or fabricate agent spans / sources / defects to fill an empty timeline.
- Gate/plan presentation parts (`data-gate`, `data-plan`) remain product-owned at the shell/transition boundary as today; they are not a second business-progress pipeline.
- Contract detail: [docs/design/operator-event-contract.md](../design/operator-event-contract.md).

### 4. SessionTurn deep module

- **SessionTurn** is a deep module: intent/mode resolution, turn lock, start/resume param assembly, framework stream tee, and onFinish/drain into Session–Run transition.
- It owns conversational HITL routing and durable Session message append — **not** Wiki generation semantics and **not** business progress synthesis.

### 5. Human HITL is Session-only

- Plan confirm and publication approve/deny for humans live on the Operator Session timeline (structured `resumeData` + workflow suspend/resume).
- **Run REST** remains an **automation adapter only** (CI/headless resume, job index, audit logs) — not the default human operate surface (ADR 0026).

### 6. Delete list (implementation follows this ADR)

| Remove | Why |
|---|---|
| Durable-produce stub / `OKF_WIKI_DURABLE_PRODUCE` reservation | Never wired; dual path risk; superseded here |
| Adaptive / reviewer aliases and workspace toggles | Already decided off in ADR 0028; finish deletion |
| `data-choice` legacy gate parts | Replaced by `data-gate` (+ `data-plan`); no migrate |
| Session business fallbacks that invent progress | Hides missing Produce emissions; breaks single-emit invariant |
| Dual materialize / dual converter leftovers | ADR 0025/0027 already forbid; finish deletion |

## Consequences

- Operators wipe sessions on the v3 cutover (same guidance pattern as ADR 0027).
- Empty or incomplete progress UI is a **Produce bug**, not a Session shell feature to paper over.
- Headless Run REST and Session share the same Produce emit path; only transport/projection framing differs.
- ADR 0028’s reserved durable-produce env is **deleted / superseded** — do not implement it.
- Tests should assert “deletion”: Session code paths do not construct business progress parts (see operator-event contract).

## Non-goals

- Migrators for Session schema v2 → v3 or for `data-choice` → `data-gate`.
- Reintroducing adaptive/reviewer product flags.
- DurableAgent / durable-produce as a second Produce implementation.
- Making Run REST the human HITL center.
- Changing Run Boundary duties (path policy, validate, publish) or moving Mastra into `@okf-wiki/core`.

## Invariants (checklist)

| Id | Invariant |
|----|-----------|
| C1 | One business Operator Event emit path: Produce only |
| C2 | Session does not synthesize business progress parts |
| C3 | Human HITL surface: Session only; Run REST = automation |
| C4 | Session schema v3 reject-and-wipe (no migrator) |
| C5 | No durable-produce stub; no adaptive aliases; no `data-choice` |
| C6 | SessionTurn deep module ≠ Semantic Workflow body |
