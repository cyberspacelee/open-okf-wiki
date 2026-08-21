# Wiki Producer architecture

Canonical language lives in [CONTEXT.md](CONTEXT.md).

The Pi factory is `extensions/wiki/index.ts`. `createProductionWikiProducer()`
in `extensions/wiki/lib/` starts one Run: pin Sources, empty Candidate, Lead
session with `todo` / `subagent` / `candidate_check`, then OKF validation,
digest-bound review, and rename to `wiki/`. Catalog tools belong to workers,
not the Lead.

```text
Inspect → Candidate + Board → survey(N) → synthesize(1) → write → review → publish
```

`/wiki resume` re-enters that Lead on the same Candidate. The durable recovery
frame is derived from `board.json`, versioned execution receipts in `run.json`,
Candidate content, and hashed handoffs. Compaction injects that bounded frame
as an immediate follow-up; the transcript is not the source of truth. The Lead session file lives under
`.okf-wiki/runs/<id>/sessions/` when present.

An optional Postgres Catalog is declared on the Workspace and retrieved
on demand (`db_tables`, `db_describe`). Only Postgres. Read-only.

SOP is `prompts/lead.md`. Named workers are `agents/*.md`. Multi-Source Runs
fan in all Source survey handoffs through one read-only synthesize worker before
writing begins. Page kinds come
from `wiki-templates/` after init (or packaged `templates/zh` /
`templates/en`). Wiki, domain, and concept each have one anchor.
`architecture.md` is required at wiki and repo altitudes. Optional templates
are kept or dropped after the writer reopens source. Survey and review receive
a compact template catalog; the writer receives only the skeletons for its
path prefix. Structure is mechanically validated. `type` is Title Case;
filenames stay kebab-case. The host enforces Source-survey fan-in before
cross-Source synthesis and rejects writes that predate synthesis. It also
enforces execution receipts, disjoint write prefixes, prefix-bound writer
digests, review exclusivity, cited-file reads, Candidate validation, review
freshness, and publication. The Lead session has `todo`, `subagent`, `candidate_check`,
`publish`, and read-only Candidate tools. `write` / `edit` belong to the write
agent. An explicit Workspace owns knowledge by Repository Section
(`repos/<scopeId>/<domain>/<concept>/`); its root pages own cross-Source
composition. An implicit Workspace remains knowledge-shaped at
`<domain>/<concept>/`, uses Workspace-root citation paths without a `self/`
segment, and has no `repos/` directory.

Workspace init and `/wiki source add` stay host commands. Pi TUI is the user's
shell. Print/json `/wiki` waits for the Run. TUI updates `setStatus("wiki")`
and a below-editor widget of Lead / subagent tool calls. `/wiki status` opens
an inspect overlay. Tool start/update/end are pushed through `handle.subscribe`;
the process tail is memory-only.

Decisions: [0001](docs/adr/0001-isolated-full-generation-runs.md),
[0004](docs/adr/0004-durable-run-board.md),
[0005](docs/adr/0005-postgres-catalog-on-demand.md),
[0006](docs/adr/0006-repository-sections-and-cross-source-synthesis.md).
