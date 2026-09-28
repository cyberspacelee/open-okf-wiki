# Extensions

Two optional additions to the normal loop: a hub that documents several
repositories in one wiki, and OpenGauss databases rendered as wiki pages. The
stages, page rules and review are unchanged; only the differences are here.

## Hub: several repositories, one wiki

A hub is its own git repository that holds only the wiki. Each source is a
separate git repository in a direct child directory, ignored by the hub:

```text
<hub>/
  .gitignore        # /api/ and /worker/, appended by okf init --hub
  api/              # source: its own git repository, not tracked by the hub
  worker/
  docs/wiki/        # repo-wiki.yaml has lang and sources: [api, worker]
```

Set up with plain git; `okf` never clones or fetches:

    git init <hub> && cd <hub>
    git clone <api-url> api
    git clone <worker-url> worker
    okf init --hub --source api --source worker

Then commit `.gitignore` and the wiki stubs in the hub. Run every `okf` command
from the hub root; run inside a source, a command that writes refuses and names
the hub root, while the read-only `okf status`, `okf validate` and `okf impact`
load the hub wiki from anywhere below the hub. `impact --files` reads relative
paths from the current directory (`src/a.py` in `api/` becomes `api/src/a.py`).
From the hub root, an unprefixed path found in exactly one source is resolved
to it, with a `resolved ...` note; one found in several is reported as
`ambiguous` (its only note).

Differences from a single repository:

- **Locators** are relative to the hub root, so the first segment is the source
  name: `api/src/billing/run.py#L10-L40`. A path with no source prefix fails
  `locator`. Scope globs carry the prefix too: `api/src/billing/**`; `okf new`
  rejects a scope glob that starts with neither a source name nor a wildcard.
- **Revision** is recorded per source: `revision: {api: <sha>, worker: <sha>}`.
  `okf impact` diffs each source from its own recorded commit to its own HEAD.
- **Clean sources.** Every source must be clean (no uncommitted tracked
  changes); status reports `blocked` and names the dirty files otherwise. Do not
  commit or stash inside a source yourself; ask the user.
- **Modules** from `okf scan` carry the source prefix; a source with no module
  of its own is one module named after the source.
- **Refresh.** To document newer code, the user (or you, when asked) fetches
  and checks out the wanted commit in each source with plain git. The next
  `okf status --json` shows the moved HEAD; follow it into `okf update --json`.
- **Commit** wiki changes in the hub repository, never in a source.
- **Pointer.** `okf pointer` prints one block for the hub, with one line asking
  to paste it into each source's AGENTS.md (paths are relative to the hub root).
  A human does that; never write into a source yourself.
- Cross-source flows (api enqueues, worker consumes) are Workflow pages whose
  `scope` lists globs from both sources; the architecture page states which
  source depends on which.

## OpenGauss databases

Table structure comes from the live catalog, never from reading ORM models or
migrations. The kernel renders `Schema` and `Table` pages; you never write or
edit them.

### Configure the databases

Databases are declared in `repo-wiki.yaml`, next to `lang` and `sources`. Each
entry says which variable holds its URL, which repositories use it, and which
schemas and tables to capture:

```yaml
lang: zh
sources: [order-api, order-worker, billing]      # hub only
databases:
  - name: order_db                 # directory under databases/ and page titles
    url_env: ORDER_DB_URL          # variable (environment, then .env) holding opengauss://...
    repos: [order-api, order-worker]   # hub sources whose code uses it; omit in a single repository
    schemas:
      - name: public
        include: ["t_order*", "*_config"]   # starts with t_order, or ends with _config
        exclude: ["*_bak", "*_tmp"]
      - name: "tenant_*"                    # a schema glob: every tenant schema
        include: ["t_*"]
      - audit                               # a bare name: every table of audit
  - name: billing_db
    url_env: BILLING_DB_URL
    repos: [billing]                        # schemas omitted: every table of public
```

- **Repositories and databases.** A repository usually uses one database; one
  database may serve several repositories (two services sharing a store), and
  a repository may use more than one. In a hub, `repos` must list the sources
  whose code reads or writes the database; the list drives the "used by" line
  of the pages, which code `okf db tables` checks, and the `db-binding`
  warning. In a single repository omit `repos`.
- **Matching.** `include` and `exclude` are globs over table names: `*` is any
  run of characters, so `t_order*` means "starts with `t_order`" and `*_log`
  "ends with `_log`"; `?` is one character. A table is captured when an
  `include` matches and no `exclude` does; `include` defaults to every table.
  Matching is case-sensitive, like unquoted catalog names (lowercase). A
  schema `name` may be a glob too; system schemas (`pg_*`,
  `information_schema`) never match.
- **Quote globs.** A YAML value that starts with `*` must be quoted
  (`"*_bak"`); unquoted, YAML reads it as an alias and the config fails.
- **Secrets.** `url_env` names a variable, never a URL. The URL is read from the
  environment, then from `.env` at the workspace root, and must be an
  `opengauss://user@host:port/db` URL. `.env` serves only this lookup: never
  read it otherwise, cite it, or copy its values into a page. When a variable
  is missing, ask the user to set it; never write a URL into a tracked file.

Queries run in a read-only, repeatable-read transaction.

### Commands

| command | use |
|---|---|
| `okf db tables [--db NAME]` | per database: the tables each schema rule takes, the ones an `exclude` dropped, how many others it skipped, rules that matched no schema, and the gaps against the bound repositories' code |
| `okf db describe TABLE [--db NAME] [--schema S]` | inspect one table before widening a rule to take it |
| `okf db capture [--db NAME]` | render the configured databases (all, or the named ones) as pages |

Tune the rules before the first capture. `okf db tables` lists
`code_not_taken`, tables the bound repositories' code reads or writes that the
catalog holds but the rules leave out (with the reason and a code locator),
and `code_not_found`, tables the code names that no matched schema holds
(another database, a view, a stale name). Widen `include` or narrow `exclude`
until every table the code uses is taken, unless the user says otherwise.
Show the user a rule change before making it: the config is theirs.

Capture writes, per schema, `databases/<db>/<schema>.md` (Schema page) and
`databases/<db>/<schema>/<table>.md` (Table pages), so tables of the same name
in two schemas or databases stay apart. Capture always follows the config:
generated pages of a table that was dropped or no longer matches are removed.
Commit the generated pages with the rest of the wiki.

### Link, never cite

Link a Table page with a normal bundle-absolute link, e.g.
`[t_order](/databases/order_db/public/t_order.md)`, where the path is the one
capture printed. Link the table of the database the page's code uses: in a hub,
linking a table whose database is bound to none of the page's sources raises a
`db-binding` warning (a wrong database, or a `repos` entry missing). Table
pages are never footnote targets; a claim about code that uses the table still
cites the code. Do not restate columns, types or constraints the Table page
already shows; write what the catalog cannot say: which module owns the table,
which invariants the code adds on top of it, which workflow writes it.

### Re-capture and failures

**Re-capture** regenerates the pages from the live catalog; each carries a
`catalog_sha256`. When a table's hash changes or its page is removed,
`okf impact --json` lists every author page linking it and `okf update --json`
drafts them with a todo block, like any code change. Redo stages 3-5 for those
pages.

**Capture failure is a blocker for that database only.** A missing variable, a
bad URL, an unreachable database, missing `psycopg` or a permission error is
reported per database (`error`), the others are still captured, and the
command exits 1. Report the error to the user and continue the rest of the
wiki. Never hand-write Schema or Table pages, and never fill the gap with a
schema reconstructed from models, migrations or SQL files.
