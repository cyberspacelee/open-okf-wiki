# OKF Wiki

OKF Wiki turns a pinned **Repository Snapshot Set** into a source-grounded Markdown **Wiki**.

The product is a **local Web UI**, a **localhost Node server**, and a **Mastra agent**, with a trusted **Run Boundary** in TypeScript (`@okf-wiki/core`). The operator configures a **Workspace** of local Git checkouts; the agent follows a versioned Producer Skill, writes pages into isolated Staging, and returns a typed terminal result. The Run Boundary freezes snapshots and skill digests, enforces path policy, validates Markdown mechanically, and publishes the whole Wiki atomically.

Vocabulary lives in [CONTEXT.md](CONTEXT.md). Architecture decisions are in [docs/adr/](docs/adr/). The TypeScript monorepo layout is described in [packages/README.md](packages/README.md) and [ADR 0020](docs/adr/0020-typescript-mastra-web-workspace.md). Python is no longer the primary product path ([ADR 0021](docs/adr/0021-retire-python-primary-path.md)).

## Requirements

| Need | Detail |
|---|---|
| **Node.js** | 22+ |
| **pnpm** | Workspace package manager ([pnpm.io](https://pnpm.io/)) |
| **Git** | Local clean checkouts (no clone/fetch by the product) |

Supported platforms follow the portable filesystem policy ([ADR 0017](docs/adr/0017-portable-host-filesystem-and-directory-rename-publication.md); Run Boundary language in [ADR 0019](docs/adr/0019-prefer-run-boundary-over-host.md)): absolute non-overlapping roots, exclusive create, same-volume directory rename for publication.

## Install

```bash
pnpm install
```

| Package | Role |
|---|---|
| `@okf-wiki/web` | Operator Web UI (Vite + React) |
| `@okf-wiki/server` | Localhost HTTP API (`127.0.0.1`) |
| `@okf-wiki/agent` | Mastra agent assembly |
| `@okf-wiki/core` | Run Boundary (git probe, path policy, publish) |
| `@okf-wiki/contract` | Shared Zod schemas |
| `@okf-wiki/cli` | Headless CLI stubs |
| `@okf-wiki/skill` | Bundled Producer Skill assets |

See [packages/README.md](packages/README.md) for package details and scripts.

## Quick start

```bash
# 1) Install dependencies
pnpm install

# 2) Credentials (process env or untracked .env next to the project)
# At least OPENAI_API_KEY for OpenAI / OpenAI-compatible models.
export OPENAI_API_KEY=sk-...
# Optional gateway:
# export OPENAI_BASE_URL=https://openrouter.ai/api/v1

# 3) Start the localhost API (default http://127.0.0.1:8787)
pnpm dev:server
# or: pnpm --filter @okf-wiki/server dev

# 4) Start the Operator Web UI (separate terminal)
pnpm dev:web
# or: pnpm --filter @okf-wiki/web dev
```

Open the Web UI, create a Workspace pointing at local Git repository paths, configure model identity, and start a Wiki Run. Secrets never go in workspace JSON—only environment or user-level settings.

### Provider environment

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | API key for OpenAI / compatible Chat Completions |
| `OPENAI_BASE_URL` | Optional base URL (usually ends with `/v1`) for gateways |

Model identity stays provider-prefixed (for example `openai:<served-model-name>`) even on third-party gateways.

### Development checks (TypeScript)

```bash
pnpm install
pnpm --filter @okf-wiki/contract test
pnpm --filter @okf-wiki/core test
pnpm --filter @okf-wiki/agent test
pnpm typecheck
# Optional Web e2e (Playwright; install browsers first):
# pnpm exec playwright install chromium
# pnpm --filter @okf-wiki/web test:e2e
```

Or run the workspace test script: `pnpm test`.

## Legacy Python

The Python package under [`src/okf_wiki`](src/okf_wiki) is **frozen legacy**. It is not the primary product path and should not be extended for new features ([ADR 0021](docs/adr/0021-retire-python-primary-path.md), [`src/okf_wiki/LEGACY.md`](src/okf_wiki/LEGACY.md)).

Historically this repository shipped a Pydantic AI CLI / Textual Operator Session. That tree remains for reference and for the optional legacy CI job; new work lands in `packages/*` and `apps/*`.

```bash
# Optional historical path only — not recommended for new use
uv sync --locked
uv run --locked okf-wiki --help
```
