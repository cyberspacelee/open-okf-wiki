# Adopt TypeScript, Mastra, local Web UI, and Workspace

**Status:** accepted
**Date:** 2026-07-19
**Supersedes (partial):** ADR 0006 (Python thin harness); operator-surface clauses of ADR 0016 and ADR 0018 that mandate CLI/TUI as the primary UX.
**Does not supersede:** ADR 0016’s separation of operator UI from Published Wiki visualization; ADR 0017 portable filesystem publication; product vocabulary in CONTEXT.md except Host→Run Boundary already covered by ADR 0019.

## Context

The product was a Python CLI with Pydantic AI, pydantic-ai-harness (CodeMode, SubAgents, DynamicWorkflow, compaction), and a Textual Operator Session TUI. Target constraints for the next generation:

- Primary interactive platform: **Windows**, local single-operator use
- Models: **enterprise OpenAI-compatible** gateways (`base URL` + served model id)
- Operator UI: **local Web** (later embeddable in Tauri or Electron), not a terminal TUI
- Configuration: explicit **Workspace** with **local Git** paths only (no clone/fetch/credentials)

## Decision

1. **Language / runtime:** TypeScript on Node.js LTS. Python `okf_wiki` is transitional and will be removed from the main path.
2. **Semantic Workflow:** Mastra agents (Code Mode + `LocalSandbox`, Skills, tool approval, optional Supervisor). Prefer framework capabilities; do not reimplement sandbox/subagent engines.
3. **Run Boundary:** Product-owned TypeScript package (`@okf-wiki/core`) for snapshot freeze, path policy, mechanical validation, atomic publication, records, local `git` inspection, and secret-safe events. Core must not depend on Mastra or React.
4. **Operator surface:** Local Web app (Vite + React + shadcn with **Base UI** primitives) talking to a **127.0.0.1** Node server. Headless `wiki-run` remains for automation. Terminal TUI (Textual/Ink/slash) is not ported.
5. **Workspace:** First-class project entity (name, root path, sources, model ref, publication path, flags). Secrets stay in environment or user-level settings, never in `workspace.json`.
6. **Git sources:** Operators point at **existing local checkouts**. The product runs local `git rev-parse` / `status` only. No remote clone, fetch, push, or credential UX. Dirty trees default to blocking a Wiki Run.
7. **Sandbox on Windows:** `LocalSandbox` with `isolation: 'none'`; safety via denied shell tools and path-policy tools (source/skill read-only; wiki write only for Root).
8. **Defaults:** `adaptive: false` (single Root agent). Optional bounded Supervisor tree is a later, explicit opt-in.
9. **Desktop shell:** Deferred; same Web UI may later ship inside Tauri (preferred) or Electron without changing the API contract.

## Consequences

- New monorepo packages under `packages/*` (`contract`, `core`, `agent`, `server`, `web`, `cli`, `skill`).
- ADR 0003/0004/0010/0014/0018 framework-specific wording should be revised or superseded in follow-up ADRs as implementations land.
- Analysis-run temporary storage is renamed in product language to **analysis scratch** to avoid clashing with **Workspace**.
- Wiki Visualization remains a read-only view of Published Wiki content, not a live run console.
