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
live widget of Lead / subagent tool calls. `/wiki status` opens an inspect
overlay (agents, Board, and the selected agent's process).

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
/wiki status [run-id]
/wiki runs
/wiki pause
/wiki resume [run-id]
/wiki cancel [run-id]
```

`/wiki [focus]` starts a full generation in an empty Candidate. A Git
repository without `workspace.yaml` is an implicit single-source Workspace.
Use `init` only for an explicit workspace, then add one or more sources.

`source add link` requires a local Git repository root (symlink on
Linux/macOS, junction on Windows). `source add clone` clones a URL;
`--ref` checks out a branch, tag, or commit.

A Workspace admits one running or paused Run. After pause or a failed
publish, `/wiki resume` continues that Run. After success, failure, or
cancel, `/wiki` starts a new one.

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
| `transientRetries` | `1` | `0..10` | Retries after a transient model failure, in addition to the initial attempt. |
| `baseRetryDelayMs` | `1000` | `0..300000` | Base delay used by Pi's retry backoff. |
| `sessionTimeoutSeconds` | `1200` | `1..2147483` | Wall-clock deadline for each Lead or delegated-agent session. |
| `templates` | `wiki-templates` after `/wiki init` | relative directory | Whole-pack replacement. Init copies the packaged pack for `language` here. Unset uses packaged `templates/zh` or `templates/en`. |

`defaultSourceIgnores: true` (the default) hides dependency, build, and Java
test trees (`src/test/**`, `*Test.java`, and the usual `node_modules` /
`target` noise) from inspect and from agent `read` / `grep` / `find` / `ls`.
Add more with `wiki.exclude`. `/wiki init --no-default-ignores` turns the
built-in list off.

The concurrency limit applies to a parallel survey batch while the Lead
occupies one session slot. Writers run serially and review is exclusive across
concurrent `subagent` calls. Retry and timeout values apply to both the Lead
and delegated agents. Wiki sessions use these settings instead of project or
user Pi retry settings. Unknown `wiki` fields are rejected so misspelled or
removed configuration cannot be silently ignored.

### Board

Each Run keeps a host-owned Board in `.okf-wiki/runs/<id>/board.json`:
the goal and Tasks. The Lead updates it with `todo`; `run.json` stores
versioned execution receipts and digest-bound review evidence. Compaction
injects a bounded recovery frame derived from those files, the Candidate, and
hashed handoffs. `/wiki resume` reconciles interrupted receipts and continues
the same Candidate, Board, and Lead session. `/wiki status` prints Task status
and, in the TUI, opens an inspect overlay.

### Catalog

Optional Postgres evidence. Username and password belong in the connection
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

`database.url` must resolve to `postgresql://` and may use `${ENV}` or `$ENV`.
URL-encode special characters in the password. `schema` defaults to `public`.
Omit `tables` to allow every table in that schema; otherwise names are
fuzzy-matched (`user` → `users`, `user_account`; `order%` → `orders`). Agents
call `db_tables` then `db_describe`; the host never dumps the schema into the
Lead prompt. Connections and transactions are read-only. Connection and SQL
statement deadlines remain fixed host safety limits, not Workspace tuning
parameters. Do not commit the expanded URL or `.env`.

A Catalog needs an explicit `workspace.yaml`. Implicit single-source
workspaces have no database block.

### Templates

Packaged defaults are `templates/zh/` and `templates/en/`, chosen by
`language`. They are the page contract: which files exist at wiki /
source / domain / concept, their fixed sections, and which need a mermaid diagram.
`/wiki init` copies the pack for `language` into `wiki-templates/` and
sets `wiki.templates: wiki-templates`. Edit those files in the Workspace
repository. The pack replaces the defaults as a whole. Unset `wiki.templates` to use
the packaged pack instead.
Each scope has exactly one non-optional anchor; every other template is
evidence-selected. Headings and writer instructions follow the pack language;
`type` stays English Title Case and mermaid node IDs stay source identifiers.
Consuming agents start at `wiki/index.md`.

```yaml
wiki:
  templates: wiki-templates
```

Each template is a markdown file. Filename is the page name. Frontmatter:

| Field | Meaning | Default |
| --- | --- | --- |
| `type` | OKF `type` on the generated page (Title Case, e.g. `Architecture`) | filename without `.md` |
| `scope` | `wiki` / `repo` / `domain` / `concept` | `concept` |
| `altitudes` | `wiki` and/or `repo` for dual-placement pages | unset |
| `diagram` | mermaid kind, or a list of kinds | no mermaid check |
| `optional` | writer may keep this file after reopening source | `false` (scope anchor) |
| `instructions` | writer-only completion criteria | required |

`scope` / `altitudes` / `diagram` / `optional` / `instructions` stay on the
template file. Generated pages carry `type`, `title`, `description`, and
`sources`. Claims use `[^id]` footnotes keyed to `sources[].id`.
`sources[].resource` is `<scopeId>/path#Lx` (`self/path#Lx` on an implicit
Workspace).

`instructions` tells the writer what evidence completes the page. The body is
the output skeleton: exactly `# {{title}}`, then `{{description}}`, then fixed,
unique `##` sections. Generated pages preserve that H2 order, fill every
section, and contain no `{{placeholder}}`. H3 subsections remain available.

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
wiki/development.md | runbook.md          # implicit Workspace only
wiki/repos/<scopeId>/architecture.md      # explicit Workspace
wiki/repos/<scopeId>/development.md | runbook.md
wiki/<domain>/domain.md | flows.md
wiki/<domain>/<concept>/concept.md | states.md | data.md
```

Filenames at each layer come from the template pack. The host generates every
`index.md` and root `log.md`. Each index uses the next scope's identity title
and description, so agents can choose a branch without opening it. Wiki-to-wiki
links are standard markdown. Publication validates OKF, paths, templates,
sources, and review, then installs the Candidate as `wiki/`.

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

SOP is `prompts/lead.md`. Named workers are `agents/*.md`. TypeScript does
not encode survey / write / review stages.

See [CONTEXT.md](CONTEXT.md) for terms and [ARCHITECTURE.md](ARCHITECTURE.md)
for the host shape.
