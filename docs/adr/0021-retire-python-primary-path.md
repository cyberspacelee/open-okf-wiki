# Retire Python as the primary product path

**Status:** accepted (implemented — Python tree removed)  
**Date:** 2026-07-19  
**Supersedes:** Remaining “Python is the thin harness / primary product layer” language in [ADR 0006](0006-keep-python-as-a-thin-harness.md). Completes the transition begun in [ADR 0020](0020-typescript-mastra-web-workspace.md).  
**Does not supersede:** Portable filesystem publication ([ADR 0017](0017-portable-host-filesystem-and-directory-rename-publication.md)); Run Boundary naming ([ADR 0019](0019-prefer-run-boundary-over-host.md)); separation of operator UI from Wiki Visualization ([ADR 0016](0016-separate-run-operator-ui-from-wiki-visualization.md)); product vocabulary in CONTEXT.md.

## Context

ADR 0006 kept Python as the product harness over Pydantic AI. ADR 0020 adopted TypeScript, Mastra, a local Web UI, and Workspace as the next-generation product surface, treating `src/okf_wiki` as transitional. The TypeScript monorepo under `packages/*` is now the product; continuing to present Python as primary confuses operators and agents.

## Decision

1. **Primary product:** TypeScript on Node.js 22+ — local Web UI (`@okf-wiki/web`), localhost server (`@okf-wiki/server`), Mastra agent (`@okf-wiki/agent`), Run Boundary (`@okf-wiki/core`), contracts (`@okf-wiki/contract`), and related packages.
2. **Python is not primary:** `src/okf_wiki` is **frozen legacy**. Do not extend it for new features, new operator surfaces, or new ADRs that assume a Python-first product.
3. **ADR 0006:** Historical record only. Its “Python owns the thin harness” decision no longer describes the product. Run Boundary duties live in TypeScript (`@okf-wiki/core`) per ADR 0020.
4. **Tree removal:** The Python package (`src/okf_wiki`), Python tests, `pyproject.toml` / `uv.lock`, and Python CI jobs are **removed**. Historical Pydantic AI / Textual design remains only in older ADRs and git history.
5. **Documentation and CI:** Root README and monorepo docs are TypeScript / Web-first. CI runs TypeScript package tests and Web e2e only.

## Consequences

- All product work targets `packages/*` (and `apps/*` when present).
- Operator onboarding uses `pnpm install`, the local server, and the Web UI.
- Follow-up ADRs may still supersede framework-specific wording from older Python/Pydantic AI decisions as TypeScript implementations evolve.
- Domain language in CONTEXT.md remains authoritative; implementation package names in prose use `@okf-wiki/*`.
