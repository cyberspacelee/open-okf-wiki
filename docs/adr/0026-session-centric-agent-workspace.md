# Session-centric agent workspace

**Status:** accepted  
**Date:** 2026-07-21  
**Related:** ADR 0018 (HITL), ADR 0019 (Run Boundary), ADR 0023 (stream/plan-confirm), ADR 0024 (Session as conversational workspace), ADR 0025 (wiki workflow + AI SDK bridge)  
**Supersedes (partial):** conflicting product-center implications in [0023](0023-operator-session-stream-and-plan-confirm.md) (Run as primary HITL surface), [0024](0024-session-as-conversational-workspace.md) §6 misread that Session history may be non-durable operator trajectory, [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) reading that workflow opacity excuses empty Session timelines  
**Index:** [docs/adr/README.md](README.md)

## Context

The product repeatedly oscillated between “Session as chat UX” and “Run as job console.” Operators expect a **Grok/Codex-class agent**: conversation first; skill and workflow evolve later; long work may run in the background—but **everything still appears in the Session**. Dual HITL surfaces and “black box until gate” contradict that model.

## Decision

1. **Operator Session is the sole operator truth surface**  
   Conversation, tool/process visibility, gates (plan / publish), stop/retry intent, and catch-up after disconnect all belong on the Session timeline (`UIMessage` parts or an append-only event log projected into parts).

2. **Wiki Run is a bounded job owned by a Session**  
   A Run freezes Snapshot Set + Skill under the Run Boundary, may write Staging and publish. It is **started from** a Session (or linked into one). It is **not** a parallel product center. Foreground vs background is only an **execution mode**; both must **append observable trajectory to the same Session**.

3. **Observe never leaves the Session**  
   - Every Run (interactive or background) projects status, tool use, material assistant text, and HITL into that Session.  
   - Refresh / re-open Session = restore the durable timeline + linked run state.  
   - “Session history is not the Semantic Workflow graph checkpoint” still holds for **Manual Retry / frozen inputs** ([ADR 0012](0012-treat-manual-retry-as-a-new-run.md)); it does **not** mean the operator timeline may be discarded or only live in Run logs.

4. **Run console is secondary and read-mostly**  
   `/run` (or equivalent) is job index + raw/job logs for audit and headless automation. **Primary plan/publish HITL and conversational controls live on Session.** Headless REST approve/deny may remain for CI/automation, not as the default human path.

5. **Skill and workflow are method layers**  
   Producer Skill, plan-confirm flags, and Mastra wiki-run workflow evolve without changing (1)–(4). Single production write path ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)) remains; **opacity of internal steps is not a product goal**—execution may be stepped, but Session must still receive a human-usable projection.

6. **Transport is implementation, not product center**  
   Prefer AI SDK UIMessage stream for live turns ([ADR 0024](0024-session-as-conversational-workspace.md) / [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)). Background catch-up may use the same durable Session record (and optional resume of an open stream). Do not invent a second operator protocol that bypasses Session persistence.

## Product UX defaults (aligned 2026-07-21)

Industry pattern (Claude Code / Cursor Agents / Codex CLI·App, 2025–2026): **conversation = primary timeline**; thinking / tool calls / subagents stream into that timeline with progressive disclosure; **last session is the default resume**, with an explicit picker for history; background work stays attachable to the same thread.

### Visibility fidelity (Session timeline)

**Default: maximize operator-visible trajectory** (not a job black box).

| Kind | Session UI | Persistence | Notes |
|------|------------|-------------|--------|
| Assistant text | Stream live | Yes | Material narration / summaries |
| **Thinking / reasoning** | Stream when provider sends it; **collapsed by default**, expand on demand | Prefer yes (collapsed) | Matches Claude Code / Cursor; full raw CoT may still be policy-redacted per provider |
| **Tool calls** | Live cards: name, args (redacted), status, result snippet | Yes | Primary trust surface industry-wide |
| **Subagents** | Nested card / panel: id, status, elapsed; open for child tool trail or parent-facing summary | Yes (at least spawn + summary; full child trail best-effort) | Claude/Cursor/Devin pattern: isolate context, still visible from parent |
| Workflow / run steps | Progress on same timeline (not only Run log) | Yes | Run page remains secondary log |
| HITL gates | Chips / plan cards on timeline | Yes | Human path only on Session |

Progressive disclosure: dense by default in data model; UI collapses thinking and large tool payloads so the thread stays scannable.

### Session open / refresh

| Event | Behavior |
|-------|----------|
| Enter Session with **no** `sessionId` | Open **most recently updated** Session for the workspace (`latest`) |
| Enter / refresh with **`sessionId`** | Open that Session; restore full durable timeline + linked run/gate state |
| User chooses another Session | Switcher / picker (list by updatedAt); non-latest may be read-only for chat if product keeps “only newest is writable” — still **fully viewable** |
| New Session | Explicit action (`/new` or button); becomes latest |

Codex-class pattern: `resume --last` + interactive history picker. Do **not** rely on “memory only while tab open.”

### Background (product intent; phased impl OK)

Background Run still **belongs to a Session** and appends to its timeline; user returns to **that** Session (or latest if unspecified) and sees catch-up—not a separate job-only world.

## Non-goals (explicit)

- Replacing Run Boundary, Staging, or atomic publication.  
- Treating Session messages as the frozen Manual Retry skill/snapshot checkpoint.  
- Forcing providers that do not emit reasoning to fake thinking; do not invent CoT.  
- Dumping unbounded raw payloads (secrets, huge file bodies) without redaction/truncation.

## Consequences

- Product language: Session-centric agent; Run = Session-scoped job.  
- UI priority: Session page for operate; Run page for logs/history of jobs.  
- Implementation debt (not decided here, but now in scope): project agent/workflow activity into Session parts; durable Session save must not silently drop timeline; deep-link/restore active Session; migrate human HITL off Run as default.  
- ADR 0024/0025 remain for stack choices; **this ADR wins on “who is the center” and “background still on Session.”**

## Invariants (checklist)

| Id | Invariant |
|----|-----------|
| I1 | Single human operate surface: Session |
| I2 | Single operator timeline: Session messages/parts |
| I3 | Background execution still appends to that Session |
| I4 | Skill/workflow changes do not move the center off Session |
| I5 | Runs attach to Session; many runs per session allowed |
| I6 | Refresh restores Session timeline + linked run/gate state |
| I7 | Visibility: thinking (collapsible) + tools + subagents on Session timeline when available |
| I8 | Default open = latest Session; explicit switcher + optional sessionId deep-link |
