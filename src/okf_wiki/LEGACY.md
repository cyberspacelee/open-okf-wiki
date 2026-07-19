# Legacy — do not extend

This package (`okf_wiki`) is **frozen legacy**.

- It is **not** the primary OKF Wiki product path.
- The product is the TypeScript monorepo under `packages/*` (local Web UI, localhost server, Mastra agent, Run Boundary). See [ADR 0020](../../docs/adr/0020-typescript-mastra-web-workspace.md) and [ADR 0021](../../docs/adr/0021-retire-python-primary-path.md).
- **Do not** add features, operator surfaces, or new dependencies here.
- **Do not** treat this tree as the source of truth for Run Boundary, Session, or Skill behavior going forward.
- Keep the tree for historical reference and optional legacy tests until an explicit cleanup removes it.

If you need product changes, work in `packages/*` (and `apps/*` when applicable).
