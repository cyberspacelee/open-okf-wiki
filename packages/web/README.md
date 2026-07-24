# @okf-wiki/web

Vite + React operator UI for OKF Wiki. It talks to `@okf-wiki/server` over local HTTP/SSE; among product packages it depends only on `@okf-wiki/contract`, never on Agent or Core implementation modules.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm --filter @okf-wiki/web dev` | Start Vite; `/api` proxies to `127.0.0.1:8787` |
| `pnpm --filter @okf-wiki/web build` | Typecheck and build production assets |
| `pnpm --filter @okf-wiki/web typecheck` | Typecheck without emitting |
| `pnpm --filter @okf-wiki/web test` | Run projector/unit tests |
| `pnpm --filter @okf-wiki/web test:e2e` | Run Playwright end to end |

## Operator surface

The Agent Workspace (`/w/:id`) is the only operate surface. Sources, Published Wiki, and Workspace settings remain supporting read/configuration pages; there is no independent Run page or Run command UI.

The workspace uses one projection path:

1. the Session SSE sends a current server snapshot;
2. genuine parent Pi `AgentSession` events update the transcript;
3. the real `wiki_produce` tool details expose its linked Run and plan/publication gate;
4. reconnecting replaces local state from a new snapshot.

The browser does not invent agent messages, retain an event replay database, or maintain a duplicate Produce tree. Gate actions use the structured `resume_gate` Session command.

UI primitives live under `src/components/ui/` (shadcn/Base UI). Workspace pages reuse `WorkspaceShell` and `WorkspaceSubnav`; destructive actions use `ConfirmDialog`, and toasts use `sonner`.

## End-to-end tests

Playwright specs live in `e2e/`. `scripts/e2e-dev.mjs` builds the libraries, starts a server with an isolated `OKF_WIKI_HOME`, and starts Vite. Workers remain fixed at one until product indexes support concurrent writers.

```bash
pnpm exec playwright install chromium
pnpm --filter @okf-wiki/web test:e2e
```

Keep existing `data-testid` values on the interactive element that a spec targets. Shared setup helpers live in `e2e/helpers.ts`; generated Playwright artifacts are ignored.
