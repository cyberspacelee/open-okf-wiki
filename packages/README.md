# Packages

Primary product implementation for OKF Wiki. Current stack ADR: [0030](../docs/adr/0030-pi-agent-harness-for-semantic-workflow.md) (Pi agent harness + WikiRunShell + Agent Workspace). Also: [0021](../docs/adr/0021-retire-python-primary-path.md), [0026](../docs/adr/0026-session-centric-agent-workspace.md) (Session-centric intent), [0028](../docs/adr/0028-supervisor-tree-and-thin-workflow-shell.md) (shell + supervisor intent), [0029](../docs/adr/0029-architecture-cleanup-no-compat.md) (no-compat). Full index: [docs/adr/README.md](../docs/adr/README.md). Operator events: [operator-event-contract.md](../docs/design/operator-event-contract.md).

| Package | Role |
|---------|------|
| `@okf-wiki/contract` | Shared schemas (workspace, run, agent protocol) |
| `@okf-wiki/core` | Run Boundary: path policy, publish, session/run stores, git probe (no Pi/Mastra) |
| `@okf-wiki/agent` | Pi sessions, WikiRunShell, produce, tool policy (no Mastra/AI SDK) |
| `@okf-wiki/server` | Localhost API: agent sessions SSE/commands, runs, workspaces |
| `@okf-wiki/web` | Operator Web UI (Vite + React + shadcn Agent Workspace) |
| `@okf-wiki/cli` | Headless helpers including `wiki-run` (Pi fixture/live) |
| `@okf-wiki/skill` | Embedded Producer Skill |

**Forbidden product deps (CI):** `@mastra/*`, `ai`, `@ai-sdk/*` — see `scripts/check-no-forbidden-agent-deps.mjs`.
