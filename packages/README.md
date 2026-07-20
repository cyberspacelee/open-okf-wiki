# TypeScript monorepo

Primary product implementation for OKF Wiki. See [ADR 0020](../docs/adr/0020-typescript-mastra-web-workspace.md), [ADR 0021](../docs/adr/0021-retire-python-primary-path.md), and [ADR 0024](../docs/adr/0024-session-as-conversational-workspace.md).

| Package | Role |
|---|---|
| `@okf-wiki/contract` | Zod schemas (Workspace, Run, Session, events, receipts) |
| `@okf-wiki/core` | Run Boundary + session store + local git probe (no Mastra) |
| `@okf-wiki/agent` | Mastra agent assembly + session UI-message stream |
| `@okf-wiki/server` | Localhost HTTP API (`127.0.0.1`) + Session chat endpoints |
| `@okf-wiki/web` | Operator Web UI (Vite + React + Session chat) |
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
