# Open OKF Wiki

A Pi extension that produces a source-grounded repository Wiki from one Git
repository or a multi-source `workspace.yaml`.

```bash
pnpm install
pi install .
```

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
database:
  url: ${DATABASE_URL}
  schema: public
  tables: [user*, order%]
sources:
  - path: backend
    origin:
      type: link
      localPath: /abs/path/to/backend
```

`wiki` accepts only `exclude` (source globs). Unknown fields are rejected.

### Board

Each Run keeps a host-owned Board in `.okf-wiki/runs/<id>/board.json`:
the goal and Tasks. The Lead updates it with `todo`. Compaction re-injects
the Board so remaining work survives a long context. `/wiki resume`
continues the same Candidate, Board, and Lead session. `/wiki status`
prints Task status.

### Catalog

Optional Postgres evidence. `url` must be `postgresql://` (or `${ENV}` /
`$ENV`). `schema` defaults to `public`. Omit `tables` to allow every table
in that schema; otherwise names are fuzzy-matched (`user` → `users`,
`user_account`; `order%` → `orders`). Agents call `db_tables` then
`db_describe`. The host never dumps the schema into the Lead prompt.
Connections are read-only. Put secrets in the environment, not in git.

A Catalog needs an explicit `workspace.yaml`. Implicit single-source
workspaces have no database block.

## Published layout

```text
wiki/overview.md
wiki/<source>/source.md
wiki/<source>/<domain>/domain.md
wiki/<source>/<domain>/<concept>/concept.md
wiki/<source>/<domain>/<concept>/models.md | flows.md | states.md | data.md | modules.md
```

The host generates every `index.md`. Citations are
`[label](<scopeId>/<path>#Lx)`. Publication validates OKF, paths, and
citations, then installs the Candidate as `wiki/`.

Lead sessions use Pi auto-compaction. Wiki sessions do not inherit project
or user Pi settings.

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
