# OKF Wiki

OKF Wiki turns a pinned **Repository Snapshot Set** into a source-grounded Markdown **Wiki**.

The product is a **local Web UI**, a **localhost Node server**, and a **Mastra agent**, with a trusted **Run Boundary** in TypeScript (`@okf-wiki/core`). The operator configures a **Workspace** of local Git checkouts (link existing paths or clone into the workspace). The agent follows a versioned Producer Skill, writes pages into isolated Staging, and returns a typed terminal result. The Run Boundary freezes snapshots and skill digests, enforces path policy, validates Markdown mechanically, and publishes the whole Wiki atomically.

The primary operator surface is the **Session** page — a multi-turn conversational workspace (AI SDK `useChat` + message `parts`) for plan negotiation, tool visibility, and HITL choices. **Wiki Run** remains the bounded production job (history, staging, publish) that may be started from a Session.

| Doc | Purpose |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary |
| [docs/adr/](docs/adr/) | Architecture decisions ([index](docs/adr/README.md)) |
| [packages/README.md](packages/README.md) | Monorepo package map |
| [ADR 0020](docs/adr/0020-typescript-mastra-web-workspace.md) | TypeScript / Mastra / Web layout |
| [ADR 0021](docs/adr/0021-retire-python-primary-path.md) | Python primary path retired |
| [ADR 0022](docs/adr/0022-source-clone-into-workspace.md) | Operator-initiated source clone |
| [ADR 0024](docs/adr/0024-session-as-conversational-workspace.md) | Session as conversational workspace |
| [ADR 0025](docs/adr/0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) | Single Mastra workflow + official AI SDK bridge |
| [ADR 0028](docs/adr/0028-supervisor-tree-and-thin-workflow-shell.md) | Thin Workflow shell + Supervisor produce (WikiRunSpec, review council) |

## Requirements

| Need | Detail |
|---|---|
| **Node.js** | 22+ |
| **pnpm** | Workspace package manager ([pnpm.io](https://pnpm.io/); pin in `packageManager`) |
| **Git** | Local checkouts; product may **clone** when the operator asks (never silently in the Semantic Workflow) |
| **pre-commit** (optional) | [pre-commit.com](https://pre-commit.com/) for staged hygiene + ESLint |

Supported platforms follow the portable filesystem policy ([ADR 0017](docs/adr/0017-portable-host-filesystem-and-directory-rename-publication.md); Run Boundary language in [ADR 0019](docs/adr/0019-prefer-run-boundary-over-host.md)): absolute non-overlapping roots, exclusive create, same-volume directory rename for publication.

## Install

```bash
pnpm install
# optional quality hooks
pre-commit install
```

Copy [`.env.example`](.env.example) to an untracked `.env` (or export vars in the shell). Secrets never go in `workspace.json`.

| Package | Role |
|---|---|
| `@okf-wiki/web` | Operator Web UI (Vite + React + AI Elements) |
| `@okf-wiki/server` | Localhost HTTP API + Session stream |
| `@okf-wiki/agent` | Mastra agent assembly + session chat stream |
| `@okf-wiki/core` | Run Boundary (git probe, path policy, publish, session store) |
| `@okf-wiki/contract` | Shared Zod schemas |
| `@okf-wiki/cli` | Headless CLI helpers |
| `@okf-wiki/skill` | Bundled Producer Skill assets |

## Quick start

```bash
# 1) Install
pnpm install

# 2) Credentials (process env or untracked .env)
export OPENAI_API_KEY=sk-...
# Optional OpenAI-compatible gateway (base usually ends with /v1):
# export OPENAI_BASE_URL=https://openrouter.ai/api/v1

# 3) API + Web (hot reload)
pnpm dev
# → API  http://127.0.0.1:8787
# → UI   http://127.0.0.1:5173  (proxies /api → server)
```

Without a live model key, the stack still runs in **fixture** mode (deterministic Session/Run streams for local UI and e2e).

`pnpm dev` builds shared packages once, then runs in parallel:

| Process | Hot reload |
|---|---|
| `@okf-wiki/web` | Vite HMR |
| `@okf-wiki/server` | `node --watch` |
| `contract` / `core` / `agent` | `tsc --watch` → dist changes restart the server |

Split terminals if you prefer: `pnpm dev:server` and `pnpm dev:web`.

### Operator flow (browser)

1. Open **Workspaces** → create a workspace with an **absolute** `rootPath`.
2. **Settings** → configure model catalog endpoints if needed (secrets stay machine-local / env).
3. **Sources** → link a clean local Git checkout **or** clone into the workspace.
4. **Session** → multi-turn chat: plan options, free-text revise, tool parts, linked run materialization.
5. **Run** → job history, staging review, **Approve / deny publish** when `awaiting_publication`.
6. **Wiki** → browse published Markdown.

Route map (per workspace): `/session` (chat), `/run` (jobs + publish), `/sources`, `/settings`, wiki browse.

### Provider and server environment

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | API key for OpenAI / compatible Chat Completions |
| `OPENAI_BASE_URL` | Optional API root (usually ends with `/v1`) |
| `OKF_WIKI_AGENT_MODE` | `fixture` \| `live` (default: auto — fixture without key/URL) |
| `OKF_WIKI_HOST` / `OKF_WIKI_PORT` | API bind (default `127.0.0.1:8787`) |
| `OKF_WIKI_HOME` | Machine-local product home (model catalog, app index) — not skills |
| `OKF_WIKI_ALLOW_LAN` | Opt-in LAN bind / CORS for private origins |
| `VITE_API_BASE` | Only if UI and API are **not** same-origin |

Model identity stays provider-prefixed (for example `openai:<served-model-name>`) even on third-party gateways. Full template: [`.env.example`](.env.example).

## Scripts and quality gates

| Command | What it does | When |
|---|---|---|
| `pnpm dev` | Build libs once + API/Web/lib watch | Day-to-day development |
| `pnpm build` | Build all packages | Release / packaging |
| `pnpm typecheck` | `tsc --noEmit` across packages | Local before PR; **CI** |
| `pnpm lint` / `pnpm lint:fix` | ESLint flat config (`eslint.config.mjs`) | Local; staged pre-commit; **CI** |
| `pnpm check` | `typecheck` + `lint` | Convenient full static check |
| `pnpm test` | Package unit tests (`node:test` where present) | Local; **CI** |
| `pnpm test:e2e` | Playwright Web e2e (`@okf-wiki/web`) | Local when touching UI/API; **CI job** |
| `pnpm cli` | Headless CLI entry (`@okf-wiki/cli`) | Doctor / automation stubs |

```bash
pnpm install
pnpm test
pnpm check          # typecheck + eslint
```

### Pre-commit (optional, recommended)

```bash
pre-commit install
pre-commit run -a   # full tree
```

Hooks stay **fast**: trailing whitespace / YAML hygiene + ESLint on **staged** `*.{ts,tsx,js,jsx}` only. Full typecheck and Playwright stay in **CI** so commits are not blocked by multi-minute runs.

Config: [`.pre-commit-config.yaml`](.pre-commit-config.yaml) · ESLint: [`eslint.config.mjs`](eslint.config.mjs).

### End-to-end (Playwright)

```bash
pnpm --filter @okf-wiki/web exec playwright install chromium
pnpm test:e2e
```

Covers workspace create, settings, sources, **session chat**, plan confirm, run console, and publish. Specs live under `packages/web/e2e/`. Not a pre-commit gate.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. **typescript** — unit tests (contract / core / agent) + `pnpm typecheck` + `pnpm lint`
2. **web-e2e** — Playwright Chromium against the local dev stack

## Manual verification

### Same machine (default)

```bash
pnpm dev
# → UI  http://127.0.0.1:5173
# → API http://127.0.0.1:8787
```

Smoke API:

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/doctor
```

Fixture path (no API key): open **Session**, send a message, confirm plan / choice UI streams; **Run** still supports one-shot generate + publish when you need the job console only.

### LAN (another device on the same network)

No hardcoded IP in the client. The UI uses **same-origin** `/api/*`; Vite proxies to the local API. Open `http://<host-ip>:5173`.

```bash
# Host machine — allow API on all interfaces (opt-in)
export OKF_WIKI_ALLOW_LAN=1
export OKF_WIKI_HOST=0.0.0.0
export OKF_WIKI_PORT=8787
pnpm dev:server

# UI (listens on 0.0.0.0:5173; proxies /api → 127.0.0.1:8787)
pnpm dev:web
```

On another device:

1. Find the host IP (e.g. `192.168.1.20`).
2. Open **`http://<host-ip>:5173`**.
3. Optional direct API: `http://<host-ip>:8787/api/health` (`allowLan: true`).

**Notes**

- Firewall: allow TCP **5173** (and **8787** if you hit the API directly).
- Paths are always on the **host** disk (browser is only a remote control).
- Optional override if UI and API are not same-origin: `VITE_API_BASE=http://host:8787`.
- Do not expose this to the public internet.
