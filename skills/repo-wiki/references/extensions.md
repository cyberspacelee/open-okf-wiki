# Extensions

Two optional additions to the normal loop: a hub that documents several
repositories in one wiki, and an OpenGauss schema rendered as wiki pages. The
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

## OpenGauss schema

Table structure comes from the live catalog, never from reading ORM models or
migrations. The kernel renders `Schema` and `Table` pages; you never write or
edit them.

Pass the connection as a variable name, never as a URL on the command line.
`--url-env VAR` reads `VAR` from the environment, then from `.env` at the
repository root; the value must be an `opengauss://user@host:port/db` URL.
`.env` serves only this lookup: never read it otherwise, cite it, or copy its
values into a page. Queries run in a read-only, repeatable-read transaction.

| command | use |
|---|---|
| `okf db tables --url-env VAR [--schema S]` | list tables in a schema (default `public`) |
| `okf db describe TABLE --url-env VAR` | inspect one table before deciding to capture it |
| `okf db capture --url-env VAR --schema S --table T ... --name DB [--into reference]` | render one Schema page and one Table page per table under the wiki |

Capture the tables that the modules and workflows read or write; capture the
whole schema only when it is small. `--name` is the database name used in page
paths and titles; `--into` is the directory inside the wiki the pages go under
(Schema page `<into>/<DB>.md`, Table pages `<into>/tables/<table>.md`). Commit the
generated pages with the rest of the wiki.

**Author pages link, never cite.** Link a Table page with a normal
bundle-absolute link, e.g. `[invoices](/reference/tables/invoices.md)`, where
the path is the one capture printed. Table pages are never footnote targets; a
claim about code that uses the table still cites the code. Do not restate
columns, types or constraints the Table page already shows; write what the
catalog cannot say: which module owns the table, which invariants the code adds
on top of it, which workflow writes it.

**Re-capture** regenerates the pages from the live catalog; each carries a
`catalog_sha256`. When a table's hash changes, `okf impact --json` lists every
author page linking that Table page and `okf update --json` drafts them with a
todo block, like any code change. Redo stages 3-5 for those pages.

**Capture failure is a blocker.** A missing variable, a bad URL, an unreachable
database, missing `psycopg` or a permission error stops the database part: report
the error to the user and continue the code-only wiki. Never hand-write Schema
or Table pages, and never fill the gap with a schema reconstructed from models,
migrations or SQL files.
