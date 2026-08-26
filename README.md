# Open OKF Wiki

A Pi extension that produces a source-grounded repository Wiki from one Git
repository or a multi-source `workspace.yaml`.

```bash
pnpm install
pi install .
```

`/wiki` is a Pi slash command, not a `pi` subcommand. Flags like `--lang` belong
inside the quoted command:

```bash
pi -e ./extensions/wiki/index.ts -p --mode json -a "/wiki init --lang zh"
pi -e ./extensions/wiki/index.ts -p --mode json -a "/wiki source add link /path/to/repo --name repo --catalog app"
pi -e ./extensions/wiki/index.ts -p --mode json -a "/wiki"
```

Print/json mode waits until the Run finishes and prints the final status.
Interactive TUI returns after start, updates the footer status, and shows a
live widget of Lead / subagent activity. `/wiki status` opens an inspect
overlay. `Tab` switches between the Agents and complete Board views; `Enter`
opens the selected agent's complete current-Run Process timeline, including
input, assistant output, tool calls, and textual tool results. `e` opens full
Run or control errors. Pause, resume, and cancel remain available from every
view when the current Run state permits them.

CLI contract (no LLM): `./scripts/e2e-wiki-cli.sh`  
Live generation: `WIKI_E2E=1 ./scripts/e2e-wiki-live.sh`

The host skill is declared in `package.json` (`pi.skills`) and loaded by
`pi install`. It is not read from `.agents/`.

## Commands

```text
/wiki [focus]
/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]
/wiki source add link <local-path> [--name <name>] [--catalog <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--catalog <name>] [--workspace <dir>]
/wiki status
/wiki pause
/wiki resume
/wiki cancel
```

`/wiki [focus]` starts a full generation in an empty Candidate. A Git
repository without `workspace.yaml` is an implicit single-source Workspace.
Use `init` only for an explicit workspace, then add one or more sources.

`source add link` requires a local Git repository root (symlink on
Linux/macOS, junction on Windows). `source add clone` clones a URL;
`--ref` checks out a branch, tag, or commit. `--catalog` binds the new Source
to an existing named Catalog.

A Workspace keeps at most one current Run under `.okf-wiki/run/`. After pause
or failure, `/wiki resume` continues its Candidate, Board, and Lead session.
Success and cancel remove the Run state; the next `/wiki` starts from an empty
Candidate. Legacy `.okf-wiki/runs/` history is deleted when a new Run starts.
Current-Run Process activity is retained across pause, failure, and resume, and
is deleted with the Run after success or cancel.
Delegated work is persisted as `queued` before it acquires a worker slot, then
as `running`, `complete`, `blocked`, `failed`, or `interrupted`. Process usage
is appended to `activity.jsonl`; failed executions write a bounded diagnostic
artifact that is injected into the next attempt for the same target.
Run timestamps remain UTC ISO strings in persisted state. User-facing absolute
times are formatted in the user's system-default locale and time zone.

`language: zh` or `language: en` controls published Wiki titles and body text,
plus human-readable worker findings. Code identifiers, source citations, and
the stable machine tokens in internal worker receipts stay unchanged.

## Workspace

Explicit `workspace.yaml`:

```yaml
version: 1
language: zh
defaultSourceIgnores: true
wiki:
  exclude: []
  maxConcurrentAgents: 3
  maxWorkerRepairRounds: 6
  transientRetries: 1
  baseRetryDelayMs: 1000
  leadSessionTimeoutSeconds: 14400
  workerSessionTimeoutSeconds: 1200
  maxLeadTurns: 240
  maxWorkerTurns: 80
  maxLeadToolCalls: 128
  maxWorkerToolCalls: 256
  maxLeadInputTokens: 4000000
  maxWorkerInputTokens: 1000000
  templates: wiki-templates
catalogs:
  app:
    url: ${APP_DATABASE_URL}   # postgresql://USER:PASSWORD@HOST:PORT/DB
    schema: public
    tables: [user*, order%]
  audit:
    url: ${AUDIT_DATABASE_URL}
    schema: audit
sources:
  - path: backend
    catalog: app
    origin:
      type: link
      localPath: /abs/path/to/backend
  - path: worker
    catalog: app
    origin:
      type: clone
      remoteUrl: https://example.test/worker.git
  - path: audit-reader
    catalog: audit
    origin:
      type: link
      localPath: /abs/path/to/audit-reader
```

All `wiki` fields are optional. Explicit Workspaces fill omitted fields with
the defaults below; implicit single-source Workspaces use the same defaults.

| Field | Default | Valid values | Meaning |
| --- | ---: | ---: | --- |
| `exclude` | `[]` | source globs | Extra source globs excluded from evidence discovery and from `read` / `grep` / `find` / `ls`. |
| `maxConcurrentAgents` | `3` | `2..64` | Total concurrent model sessions, including the Lead. At most `value - 1` delegated agents run together. |
| `maxWorkerRepairRounds` | `6` | `1..64` | Maximum same-session follow-ups for writer completion and reviewer verdict repairs. |
| `transientRetries` | `1` | `0..10` | Retries after a transient model failure, in addition to the initial attempt. |
| `baseRetryDelayMs` | `1000` | `0..300000` | Base delay used by Pi's retry backoff. |
| `leadSessionTimeoutSeconds` | `14400` | `1..2147483` | Wall-clock deadline for the Lead orchestration session. |
| `workerSessionTimeoutSeconds` | `1200` | `1..2147483` | Wall-clock deadline for each delegated-agent session. |
| `maxLeadTurns` | `240` | `1..100000` | Maximum Lead assistant turns, including completion follow-ups. |
| `maxWorkerTurns` | `80` | `1..100000` | Maximum turns per delegated-agent session. |
| `maxLeadToolCalls` | `128` | `1..1000000` | Maximum tool calls in the Lead session. |
| `maxWorkerToolCalls` | `256` | `1..1000000` | Maximum tool calls per delegated-agent session. |
| `maxLeadInputTokens` | `4000000` | positive integer | Maximum cumulative Lead input tokens. |
| `maxWorkerInputTokens` | `1000000` | positive integer | Maximum cumulative input tokens per delegated-agent session. |
| `templates` | `wiki-templates` after `/wiki init` | relative directory | Whole-pack replacement. Init copies the packaged pack for `language` here. Unset uses packaged `templates/zh` or `templates/en`. |

`defaultSourceIgnores: true` (the default) hides dependency and build trees
(including the usual `node_modules` / `target` noise) from inspect and from
agent `read` / `grep` / `find` / `ls`. Source tests remain readable evidence.
Add more with `wiki.exclude`. `/wiki init --no-default-ignores` turns the
built-in list off.
Runtime dotenv files are always excluded from agent evidence, even when default
ignores are disabled. `.env.example` and `.env.sample` remain readable.

The concurrency limit applies to parallel Source surveys and disjoint
Repository Section writes while the Lead occupies one session slot. The
cross-Source synthesize worker and review worker each run alone. Retry and
timeout values apply to both the Lead and delegated agents. Worker repair
rounds apply independently to each writer or reviewer session. Wiki sessions
use these settings instead of project or user Pi retry settings. Unknown `wiki`
fields are rejected so misspelled or removed configuration cannot be silently
ignored.

Before a writer session ends, the host returns one exhaustive batch covering
cited-file reads, Writer Todo coverage, and deterministic validation of that
write target. The same writer repairs the batch and is checked again. Reviewer
verdict formatting is repaired in its original session. The Lead retains only
whole-Candidate integration checks, semantic repair routing, and publication.

### Board

The current Run keeps a host-owned Board in `.okf-wiki/run/board.json`:
the goal and Tasks. The Lead updates it with `todo`; `run.json` stores
versioned execution receipts and digest-bound review evidence. Compaction
injects a bounded recovery frame derived from those files, the Candidate, and
hashed handoffs. `/wiki resume` reconciles interrupted receipts and continues
the same Candidate, Board, and Lead session. `/wiki status` prints Task status
and, in the TUI, opens an inspect overlay.

### Catalog

Optional openGauss evidence. Username and password belong in the connection
URL (`postgresql://USER:PASSWORD@HOST:PORT/DB`), not as separate yaml fields:

```dotenv
# <workspace>/.env (keep this file out of Git)
APP_DATABASE_URL=postgresql://wiki:secret@127.0.0.1:5432/app
AUDIT_DATABASE_URL=postgresql://wiki:secret@127.0.0.1:5432/audit
```

The `.env` file must sit beside `workspace.yaml`. It is read only when the
Workspace declares at least one `catalogs` entry; loading one Workspace does not mutate
`process.env` or leak values into another Workspace. Resolution order is:
an already exported process variable, then the Workspace `.env`. An unresolved
variable fails Workspace loading with its variable name.

Each `catalogs.<name>.url` must resolve to an openGauss `postgres://` or `postgresql://`
connection string and may use `${ENV}` or `$ENV`.
URL-encode special characters in the password. `schema` defaults to `public`.
Omit `tables` to allow every table in that schema; otherwise names are
fuzzy-matched (`user` → `users`, `user_account`; `order%` → `orders`). Agents
pass a Catalog name to `db_tables` and `db_describe` on demand; the host never
dumps schemas into the Lead prompt. A Source has zero or one `catalog`; multiple
Sources may reference the same Catalog. Survey and Source-owned writer sessions
receive only that Catalog, while synthesis, review, and Wiki-root aggregation
may use all bound Catalogs. Generated pages cite tables as
`catalog:app/orders`, so same-named tables in different Catalogs remain distinct.
Connections and transactions are read-only. Connection and SQL
statement deadlines remain fixed host safety limits, not Workspace tuning
parameters. Do not commit the expanded URL or `.env`.

A Catalog needs an explicit `workspace.yaml`, or in an implicit single-source
workspace, a `.okf-wiki/database.yaml` beside the repository root containing
one `database:` block. The implicit Source binds that Catalog as `self` and cites
tables as `catalog:self/orders`. Explicit Workspaces use only `catalogs` plus
`sources[].catalog`; the removed singular `database` field is rejected.

### Templates

Packaged defaults are `templates/zh/` and `templates/en/`, chosen by
`language`. They are structured page contracts: placement, selection,
cardinality, filename pattern, purpose, semantic obligations, and diagrams.
`/wiki init` copies the pack for `language` into `wiki-templates/` and
sets `wiki.templates: wiki-templates`. Edit those files in the Workspace
repository. The pack replaces the defaults as a whole. Unset `wiki.templates` to use
the packaged pack instead.
Every directory kind has one explicit `identity` contract for generated
indexes. Required singleton contracts may coexist at the same placement. One
required singleton contract spans Wiki and repository altitudes. Other
contracts are evidence-selected and may produce one page or multiple topic
pages. Headings and obligation guidance follow the pack language; `type` stays
English Title Case and Mermaid node IDs stay source identifiers.
The Run language is injected directly into every worker. Writers receive it
alongside the active page contracts, including when the Workspace supplies a
custom template pack.
Consuming agents start at `wiki/index.md`.

```yaml
wiki:
  templates: wiki-templates
```

Each template is a Markdown page-contract file. Its source filename is only the
contract file name; `filename` declares generated Candidate filenames.
Frontmatter has no defaults:

| Field | Meaning | Default |
| --- | --- | --- |
| `id` | stable lowercase contract id used in survey/write handoffs | required |
| `type` | unique OKF `type` on generated pages | required |
| `identity` | directory kinds whose generated index uses this page | optional; exactly one per kind in the pack |
| `scope` | `wiki` / `repo` / `domain` / `concept` placement | one of scope/altitudes |
| `altitudes` | dual `wiki` and `repo` placement | one of scope/altitudes |
| `filename` | exact basename, or one `{slug}` pattern for `many` | required |
| `cardinality` | `one` or `many` pages per applicable directory | required |
| `required` | whether every applicable directory must contain the singleton | required |
| `applies_when` | evidence condition for a non-required contract | required when `required: false` |
| `purpose` | routing-quality ownership statement | required |
| `diagram` | `{ section, kinds }` Mermaid requirement | optional |
| `table` | `{ section, columns }` exact Markdown table header requirement | optional |

Contract fields stay on the template file. Generated pages carry only `type`,
`title`, `description`, and `sources`. Claims use `[^id]` references keyed to
`sources[].id` and matching `[^id]: source title` footnote definitions.
`sources[].resource` is either a POSIX path from the Workspace root or a
Catalog table (`catalog:<catalog>/<table>`). Describe Catalog tables on demand when a
page needs columns, keys, or constraints. A frontmatter-only source inventory
may cite a bare file path. Every source referenced by a body footnote uses
`#Lx` or `#Lx-Ly`, for example `api/src/main.ts#L12` in an explicit Workspace.
The range must exist in the pinned file and must have been read by the writer.
Paths are never relative to the page or Source root, and implicit Workspaces
never add `self/`.

The contract body contains unique H2 semantic obligations. Each H2 body tells
survey, writer, and reviewer what question must be answered. The host derives
the output skeleton from those headings, so guidance never leaks into generated
pages. Generated pages preserve the H2 order, fill every section, and contain
no `{{placeholder}}`. H3 subsections remain available.

Publication fails on an undeclared page, wrong placement, missing architecture
or concept cluster, heading drift, an empty section, an unresolved placeholder,
invalid diagram or required table, missing source evidence,
a write that never read its cited files, a broken Wiki link, or stale review.

## Published layout

```text
wiki/index.md
wiki/log.md
wiki/overview.md
wiki/architecture.md
wiki/api-<surface>.md | config.md | development.md       # implicit only
wiki/runbook-<topic>.md | security.md                    # implicit only
wiki/<scopeId>/architecture.md | api-<surface>.md        # explicit only
wiki/<scopeId>/config.md | development.md                # explicit only
wiki/<scopeId>/runbook-<topic>.md | security.md           # explicit only
wiki/<scopeId>/<domain>/domain.md | flow-<scenario>.md   # explicit only
wiki/<scopeId>/<domain>/integration.md                   # explicit only
wiki/<scopeId>/<domain>/<concept>/concept.md | states.md | data.md
wiki/<domain>/domain.md | flow-<scenario>.md | integration.md # implicit only
wiki/<domain>/<concept>/concept.md | states.md | data.md       # implicit only
```

Filenames at each layer come from the template pack. The host generates every
`index.md` and root `log.md`. Each index uses the next scope's identity title
and description, so agents can choose a branch without opening it. Each writer
receives its template-derived subtree and assigned partition directly. Wiki-to-wiki
links are standard markdown. Publication validates OKF, paths, templates,
Source ownership, cross-Source architecture coverage, workflow synthesis, and
review, then installs the Candidate as `wiki/`.

Lead sessions use Pi auto-compaction. Wiki sessions do not inherit other
project or user Pi settings.

## Design

`/wiki` is the Pi adapter. Tests call the same producer:

```ts
const producer = createProductionWikiProducer();
const handle = await producer.start({ cwd, focus });
const view = await handle.view();
const result = await handle.result();
```

SOP is `prompts/lead.md`. Named workers are `agents/*.md`. The host requires a
completed survey for every Source and one subsequent synthesize receipt before
publishing a multi-Source Run, and injects those survey handoffs into the
synthesize worker; the Lead owns the remaining stage orchestration.

See [CONTEXT.md](CONTEXT.md) for terms and [ARCHITECTURE.md](ARCHITECTURE.md)
for the host shape.
