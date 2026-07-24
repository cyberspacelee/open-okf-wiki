# Packages

Primary product implementation for OKF Wiki. Current stack ADR: [0032](../docs/adr/0032-pi-tool-owned-wiki-runs.md) (real Pi `wiki_produce` tool + SessionManager + Agent Workspace). Also: [0031](../docs/adr/0031-unidirectional-framework-first-operator-surface.md), [0030](../docs/adr/0030-pi-agent-harness-for-semantic-workflow.md), and [0029](../docs/adr/0029-architecture-cleanup-no-compat.md). Full index: [docs/adr/README.md](../docs/adr/README.md). Operator events: [operator-event-contract.md](../docs/design/operator-event-contract.md).

| Package | Role |
|---------|------|
| `@okf-wiki/contract` | Shared schemas (workspace, run, agent protocol) |
| `@okf-wiki/core` | Run Boundary: immutable snapshots, Run Record v2, validation, publication (no Pi) |
| `@okf-wiki/agent` | Pi Operator Sessions, real `wiki_produce` tool, Semantic Workflow, tool policy |
| `@okf-wiki/server` | Localhost HTTP: Agent Session commands/SSE, read-only Run projection, workspaces |
| `@okf-wiki/web` | Operator Web UI (Vite + React + shadcn Agent Workspace) |
| `@okf-wiki/skill` | Embedded Producer Skill |

The single architecture guard, `pnpm check:architecture`, protects these dependency arrows and rejects retired packages, operator surfaces, protocols, and dependencies.
