# TypeScript monorepo

Primary product implementation for OKF Wiki. See [ADR 0020](../docs/adr/0020-typescript-mastra-web-workspace.md) and [ADR 0021](../docs/adr/0021-retire-python-primary-path.md).

| Package | Role |
|---|---|
| `@okf-wiki/contract` | Zod schemas (Workspace, Run, events, receipts) |
| `@okf-wiki/core` | Run Boundary + local git probe (no Mastra) |
| `@okf-wiki/agent` | Mastra agent assembly |
| `@okf-wiki/server` | Localhost HTTP API (`127.0.0.1`) |
| `@okf-wiki/web` | Operator Web UI (Vite + React) |
| `@okf-wiki/cli` | Headless CLI helpers |
| `@okf-wiki/skill` | Bundled Producer Skill assets |

```bash
pnpm install
pnpm --filter @okf-wiki/contract test
pnpm --filter @okf-wiki/core test
pnpm --filter @okf-wiki/agent test
pnpm --filter @okf-wiki/server dev    # http://127.0.0.1:8787
pnpm --filter @okf-wiki/web dev
pnpm --filter @okf-wiki/cli start doctor
```

Workspace root scripts: `pnpm dev:server`, `pnpm dev:web`, `pnpm test`, `pnpm typecheck`.

The former Python package was removed ([ADR 0021](../docs/adr/0021-retire-python-primary-path.md)).