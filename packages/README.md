# TypeScript monorepo

Primary product implementation for OKF Wiki. Current ADRs: [0020](../docs/adr/0020-typescript-mastra-web-workspace.md) (stack), [0021](../docs/adr/0021-retire-python-primary-path.md) (no Python path), [0025](../docs/adr/0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) (single workflow + AI SDK bridge), [0028](../docs/adr/0028-supervisor-tree-and-thin-workflow-shell.md) (Supervisor produce + thin shell), [0029](../docs/adr/0029-architecture-cleanup-no-compat.md) (single Produce Operator Event emit; no durable-produce stub). Full index: [docs/adr/README.md](../docs/adr/README.md). Operator Event ownership: [operator-event-contract.md](../docs/design/operator-event-contract.md).

| Package | Role |
|---|---|
| `@okf-wiki/contract` | Zod schemas (Workspace, WikiRunSpec, defects, Run, Session, events, receipts); SessionTurn policy helpers |
| `@okf-wiki/core` | Run Boundary: path policy, publish, session/run stores, git probe (no Mastra) |
| `@okf-wiki/agent` | Thin wiki-run workflow shell + **Produce** (Supervisor Domain/Leaf/review council; sole business Operator Event emit) + SessionTurn stream shell (forward only; no progress synthesis; no durable-produce stub) |
| `@okf-wiki/server` | Localhost HTTP API; SessionTurn chat adapter; Run REST automation adapter (not human HITL center) |
| `@okf-wiki/web` | Operator Web UI (Vite + React + Session `useChat`); types from contract |
| `@okf-wiki/cli` | Headless CLI helpers |
| `@okf-wiki/skill` | Bundled Producer Skill assets |

```bash
pnpm install
pnpm dev                 # API + Web + lib watch (one command)
# UI: http://127.0.0.1:5173  API: http://127.0.0.1:8787

pnpm check               # typecheck + eslint (root)
pnpm test                # package unit tests
pnpm test:e2e            # Playwright (web)

pnpm --filter @okf-wiki/cli start doctor
```

Workspace root scripts: `pnpm dev`, `pnpm dev:server`, `pnpm dev:web`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm check`, `pnpm test:e2e`.

ESLint config lives at the monorepo root (`eslint.config.mjs`). The former Python package was removed ([ADR 0021](../docs/adr/0021-retire-python-primary-path.md)).
