# Adaptive Wiki Run rollout decision (historical)

Date: 2026-07-16  
**Status:** superseded by [ADR 0028](../adr/0028-supervisor-tree-and-thin-workflow-shell.md) (2026-07-22)

## Historical decision (do not implement)

Keep adaptive orchestration enabled by deterministic scale triggers and keep small single-repository runs on a CodeMode-only path. Reviewer on by default for adaptive runs only.

## Current product

- **No** `adaptive` / `reviewer` workspace flags.
- **Always-on** Root → Domain → Leaf supervisor tree with Host budgets (`workspace.orchestration`).
- **Always-on** Host review council + repair + `hard-validate` before publish.
- Thin Workflow shell: `plan-gate → produce → hard-validate → publish-gate`.
- Living **WikiRunSpec** (domains, questions, acceptance, changelog).

See ADR 0028 for the accepted architecture.
