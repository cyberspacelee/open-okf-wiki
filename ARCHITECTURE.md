# Wiki Producer architecture

Canonical language lives in [CONTEXT.md](CONTEXT.md).

The Pi factory is `extensions/wiki/index.ts`. `createProductionWikiProducer()`
in `extensions/wiki/lib/` starts one Run: pin Sources, empty Candidate, Lead
session with `todo` / `subagent` / optional Catalog tools, then OKF validation
and rename to `wiki/`.

```text
Inspect → empty Candidate + Board → Lead (survey / write / review) → publish
```

`/wiki resume` re-enters that Lead on the same Candidate. Compaction and
process restart re-read `.okf-wiki/runs/<id>/board.json`; the transcript is
not the source of truth. The Lead session file lives under
`.okf-wiki/runs/<id>/sessions/` when present.

An optional Postgres Catalog is declared on the Workspace and retrieved
on demand (`db_tables`, `db_describe`). Only Postgres. Read-only.

SOP is `prompts/lead.md`. Named workers are `agents/*.md`. TypeScript does not
encode research/write/review stages.

Workspace init and `/wiki source add` stay host commands. Pi TUI is the user's
shell; Wiki does not ship a status overlay.

Decisions: [0001](docs/adr/0001-isolated-full-generation-runs.md),
[0004](docs/adr/0004-durable-run-board.md),
[0005](docs/adr/0005-postgres-catalog-on-demand.md).
