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
pi -e ./extensions/wiki/index.ts -p --mode json -a "/wiki source add link /path/to/repo --name repo"
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
/wiki source add link <local-path> [--name <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]
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
`--ref` checks out a branch, tag, or commit.

A Workspace keeps at most one current Run under `.okf-wiki/run/`. After pause
or failure, `/wiki resume` continues its Candidate, Board, and Lead session.
Success and cancel remove the Run state; the next `/wiki` starts from an empty
Candidate. Legacy `.okf-wiki/runs/` history is deleted when a new Run starts.
Current-Run Process activity is retained across pause, failure, and resume, and
is deleted with the Run after success or cancel.
Run timestamps remain UTC ISO strings in persisted state. User-facing absolute
times are formatted in the user's system-default locale and time zone.

`language: zh` or `language: en` controls generated titles and body text.
Code identifiers and source citations stay unchanged.

## Workspace

Explicit `workspace.yaml`:

```yaml
version: 1
language: zh
defaultSourceIgnores: true
wiki:
  exclude: []
  maxConcurrentAgents: 3
  maxEvidenceRepairRounds: 6
  transientRetries: 1
  baseRetryDelayMs: 1000
  sessionTimeoutSeconds: 1200
  templates: wiki-templates
database:
  url: ${DATABASE_URL}   # postgresql://USER:PASSWORD@HOST:PORT/DB
  schema: public
  tables: [user*, order%]
sources:
  - path: backend
    origin:
      type: link
      localPath: /abs/path/to/backend
```

All `wiki` fields are optional. Explicit Workspaces fill omitted fields with
the defaults below; implicit single-source Workspaces use the same defaults.

| Field | Default | Valid values | Meaning |
| --- | ---: | ---: | --- |
| `exclude` | `[]` | source globs | Extra source globs excluded from evidence discovery and from `read` / `grep` / `find` / `ls`. |
| `maxConcurrentAgents` | `3` | `2..64` | Total concurrent model sessions, including the Lead. At most `value - 1` delegated agents run together. |
| `maxEvidenceRepairRounds` | `6` | `1..64` | Maximum same-session writer follow-ups while citation evidence issues keep changing. The host stops earlier after two unchanged issue batches. |
| `transientRetries` | `1` | `0..10` | Retries after a transient model failure, in addition to the initial attempt. |
| `baseRetryDelayMs` | `1000` | `0..300000` | Base delay used by Pi's retry backoff. |
| `sessionTimeoutSeconds` | `1200` | `1..2147483` | Wall-clock deadline for each Lead or delegated-agent session. |
| `templates` | `wiki-templates` after `/wiki init` | relative directory | Whole-pack replacement. Init copies the packaged pack for `language` here. Unset uses packaged `templates/zh` or `templates/en`. |

`defaultSourceIgnores: true` (the default) hides dependency, build, and Java
test trees (`src/test/**`, `*Test.java`, and the usual `node_modules` /
`target` noise) from inspect and from agent `read` / `grep` / `find` / `ls`.
Add more with `wiki.exclude`. `/wiki init --no-default-ignores` turns the
built-in list off.
Runtime dotenv files are always excluded from agent evidence, even when default
ignores are disabled. `.env.example` and `.env.sample` remain readable.

The concurrency limit applies to parallel Source surveys and disjoint
Repository Section writes while the Lead occupies one session slot. The
cross-Source synthesize worker and review worker each run alone. Retry and
timeout values apply to both the Lead and delegated agents. Evidence repair
rounds apply to each writer partition. Wiki sessions use
these settings instead of project or user Pi retry settings. Unknown `wiki`
fields are rejected so misspelled or removed configuration cannot be silently
ignored.

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
DATABASE_URL=postgresql://wiki:secret@127.0.0.1:5432/app
```

The `.env` file must sit beside `workspace.yaml`. It is read only when the
Workspace declares `database`; loading one Workspace does not mutate
`process.env` or leak values into another Workspace. Resolution order is:
an already exported process variable, then the Workspace `.env`. An unresolved
variable fails Workspace loading with its variable name.

`database.url` must resolve to an openGauss `postgres://` or `postgresql://`
connection string and may use `${ENV}` or `$ENV`.
URL-encode special characters in the password. `schema` defaults to `public`.
Omit `tables` to allow every table in that schema; otherwise names are
fuzzy-matched (`user` → `users`, `user_account`; `order%` → `orders`). Agents
call `db_tables` then `db_describe`; the host never dumps the schema into the
Lead prompt. The schema is only the Catalog query scope: Agent tools expose
table names without it, and generated pages cite tables as `catalog:orders`.
Connections and transactions are read-only. Connection and SQL
statement deadlines remain fixed host safety limits, not Workspace tuning
parameters. Do not commit the expanded URL or `.env`.

A Catalog needs an explicit `workspace.yaml`, or in an implicit single-source
workspace, a `.okf-wiki/database.yaml` beside the repository root containing
one `database:` block (same fields, same `.env` resolution from the
repository root).

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
The Run language is also injected directly into writers, including when the
Workspace supplies a custom template pack.
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

Contract fields stay on the template file. Generated pages carry only `type`,
`title`, `description`, and `sources`. Claims use `[^id]` references keyed to
`sources[].id` and matching `[^id]: source title` footnote definitions.
`sources[].resource` is either a POSIX path from the Workspace root or a
successfully described Catalog table (`catalog:<table>`). A file path may
optionally end in `#Lx` or `#Lx-Ly`: for example `api/src/main.ts#L12` in an
explicit Workspace and `src/main.ts` in an implicit Workspace. A supplied range
must exist in the pinned file and must have been read by the writer. Paths are
never relative to the page or Source root, and implicit Workspaces never add
`self/`.

The contract body contains unique H2 semantic obligations. Each H2 body tells
survey, writer, and reviewer what question must be answered. The host derives
the output skeleton from those headings, so guidance never leaks into generated
pages. Generated pages preserve the H2 order, fill every section, and contain
no `{{placeholder}}`. H3 subsections remain available.

Publication fails on an undeclared page, wrong placement, missing architecture
or concept cluster, heading drift, an empty section, a non-diagram H2 without a
footnote, an unresolved placeholder, invalid diagram, missing source evidence,
a write that never read its cited files, a broken Wiki link, or stale review.

## Published layout

```text
wiki/index.md
wiki/log.md
wiki/overview.md
wiki/architecture.md
wiki/development.md | runbook-<topic>.md  # implicit Workspace only
wiki/<scopeId>/architecture.md            # explicit Workspace
wiki/<scopeId>/development.md | runbook-<topic>.md
wiki/<scopeId>/api-<surface>.md
wiki/<scopeId>/<domain>/domain.md | flow-<scenario>.md
wiki/<scopeId>/<domain>/<concept>/concept.md | states.md | data.md
wiki/<domain>/domain.md | flow-<scenario>.md # implicit Workspace only
wiki/<domain>/<concept>/concept.md | states.md | data.md
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
publishing a multi-Source Run; the Lead owns the remaining stage orchestration.

See [CONTEXT.md](CONTEXT.md) for terms and [ARCHITECTURE.md](ARCHITECTURE.md)
for the host shape.
