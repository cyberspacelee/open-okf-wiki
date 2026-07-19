# @okf-wiki/web

React + TypeScript UI for open-okf-wiki (Vite). Talks to `@okf-wiki/server` over the local HTTP API.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm --filter @okf-wiki/web dev` | Vite dev server (proxies/expects API on `127.0.0.1:8787`) |
| `pnpm --filter @okf-wiki/web build` | Typecheck + production build |
| `pnpm --filter @okf-wiki/web typecheck` | `tsc -b --noEmit` |
| `pnpm --filter @okf-wiki/web test:e2e` | Playwright e2e suite |
| `pnpm --filter @okf-wiki/web test:e2e:ui` | Playwright UI mode |

## End-to-end tests

Playwright specs live in `e2e/`. The config starts API + Vite via `scripts/e2e-dev.mjs`:

1. Builds `@okf-wiki/core...` (includes contract)
2. Starts `@okf-wiki/server` with a per-run `OKF_WIKI_HOME` temp dir
3. Starts Vite on `127.0.0.1:5173` with `--strictPort`

Workers are fixed at `1` until the app supports concurrent index locking. Artifacts (`test-results/`, `playwright-report/`) are gitignored.

```bash
# from monorepo root (first time: install browsers if needed)
pnpm exec playwright install chromium
pnpm --filter @okf-wiki/web test:e2e
```
