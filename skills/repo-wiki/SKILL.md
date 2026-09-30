---
name: repo-wiki
description: Builds and incrementally updates a source-grounded repository knowledge layer (an OKF wiki) that helps coding agents change a codebase safely - how each module and flow works, where a change starts, what else must change and how to verify it, plus architecture, the contracts and flows between repositories, invariants, project terminology and development conventions, each cited to source lines. Use to create, resume or refresh a repo wiki (single repository or a multi-repository hub, optionally with OpenGauss databases configured per repository), or to find which wiki pages a code change affects. Not for API reference dumps, single-file documentation or editing AGENTS.md by hand.
---

# Repo Wiki

Capture what an agent needs before changing code and cannot cheaply
rediscover: how each part works across files, where a change starts, what else
must change with it and how to verify it, plus boundaries, invariants, recorded
rationale, terminology and conventions.
`okf` owns scanning, status, validation, stamping and impact; you own judgment.
Run every command from the repository root (the hub root in hub mode);
`status`, `validate` and `impact` also work from any directory below it:

    okf = uv run <skill>/scripts/okf.py

`--wiki DIR` is needed only when the repository holds several wikis; it is
accepted before or after the subcommand.

**Loop:** run `okf status --json`, do its `next_actions`, repeat until phase `done`.
All work state lives in the wiki's draft pages: `status: draft` plus
`<!-- okf:todo ... -->` blocks that hold briefs and pending changes. Keep the
todo blocks current; they are your memory across context loss. Keep source code
untouched for the whole session; the only files you write are wiki pages (and
AGENTS.md, with user approval).

| phase | do |
|---|---|
| `init` | `okf init [--wiki DIR] [--lang en\|zh]`; it creates `repo-wiki.yaml` and the canon stubs (glossary, conventions, architecture; in a hub also each source's overview and conventions), or writes nothing (a repository needs a first commit) |
| `blocked` | fix the config error (a wrong `--wiki` names the configured wiki), or ask the user to commit or stash the dirty source files it names |
| `update` | `okf update --json`: source changed since a page's revision; redrafts the affected pages with the changes in todo blocks |
| `discover` | stage 1; it lasts until every canon page and every stub has a brief, a Workflow or Flow page exists whenever scan found triggers, and (hub) a Flow page exists whenever contracts are unclaimed; next actions name what is missing |
| `structure` | stage 2 |
| `research` | stage 3; a missing or broken canon page comes first: run the `okf new` command the action names, or fix its frontmatter |
| `write` | stage 4 |
| `assemble` | stage 5 |
| `review`, `stamp` | stage 6 |
| `done` | rewrite stale indexes, `log.md` or the System map with `okf stamp`, or show `git diff -- <wiki>` and commit only if asked; "nothing to do" means the wiki is committed and current |

After `blocked`, `status` lists up to 20 issues, the phase's own first; `pending`
issues are todo blocks and template hints, which block stamp but not validate.

## Write, skip, cite

A page answers an agent about to edit its scope: what this part owns, how it
works (entry, call path across files, data, wiring), where to start, what else
changes and how to verify. Keep what takes more than one file or a record to
rebuild; cut what one file answers at a glance (signatures, field lists,
directory trees, copied config, README restatement). Past the required
sections, write only sections this code gives you something to say about,
named for what they hold. Cite every table row and every causal "why" with a
footnote whose definition starts with a locator:
`[^billing-run]: src/billing/run.py#L10-L40`. Write only recorded rationale;
where none exists, write "rationale not recorded". Page types, required
sections, tables, voice and examples: [pages](references/pages.md).

## 1. Discover
Run `okf scan --json`. Read README, CONTRIBUTING, docs and ADRs, build and CI
files and entry points. Scan's `triggers` (routes, listeners, jobs, commands),
`deps` (module imports), `central` (files many modules import) and `resources`
(topics and tables shared across modules) are the map: they say where work
enters the code and which modules touch each other; in a hub, `contracts`
(routes and their clients, RPC services, topics, tables, libraries two sources
share) are how the sources depend on each other. Create a stub per candidate
module or workflow; `okf new` derives the path from the type, name and scope
(`modules/billing.md`; in a hub `sources/<source>/modules/...`):

    okf new --type Module --name billing --description "Read before changing invoice generation or retries." --scope "src/billing/**"

Write each finding as a brief into the todo block of the page it belongs to.
Discovery runs in two passes; for a large repo dispatch each pass to 2-4 agents:

1. **Scouts, by area** (a group of modules): each creates the module stubs of
   its area, writes their briefs and returns canon candidates, which you merge
   into the canon briefs as each handoff arrives.
2. **Tracers, by trigger group** (trigger files that share a module and kind,
   or a topic from `resources`): each follows its triggers from entry to outcome
   across module boundaries and creates the workflow stubs, scoped to the
   trigger files and the files the flow runs through. In a hub, tracers also
   follow `contracts` across sources: one Flow stub per end-to-end path, claiming
   the contracts it crosses (`okf new --type Flow --contract "<id>" ...`).

When `repo-wiki.yaml` declares `databases`, run `okf db tables`, settle the
include and exclude rules with the user, then `okf db capture`, so pages can
link the tables their code uses ([extensions](references/extensions.md)).

Done when every scanned module has a stub scope or a Not covered candidate,
every trigger file sits in a Workflow or Flow stub's scope or a Not covered
candidate, every contract is claimed or a Not covered candidate, and `okf
status` leaves `discover`. Signals, tracer rules and handoff format:
[discovery](references/discovery.md).

## 2. Structure
Keep module pages only for real boundaries, mechanisms or extension seams,
and workflow pages only for flows an agent would debug or extend; delete stubs
with nothing beyond "what files are here". Finalize each
page's `description` (when to read it) and `scope` globs. List scanned modules
not worth a page, and trigger files that start no flow worth a page (plain
CRUD, health checks), in the Not covered table with a reason (architecture's;
in a hub the source's overview); a glob row covers a group. In a hub, claim
each remaining contract in the `contracts` frontmatter of `architecture.md`
(libraries, shared tables) or give it a Not covered row matching one of its
site files. Done when `okf validate` reports no `coverage`,
`trigger-coverage`, `link-coverage`, `contract-claim`, `scope`, `page-path` or
`not-covered` error.

## 3. Research: canon first
Write the glossary and every conventions page before any other page; in a
large repository give each its own writer, but decide canonical names
yourself. Every writer, canon or not, follows
[research](references/research.md): a sweep of the source before reading the
brief, then the brief's leads reconciled against it.
- Glossary: project-specific terms only; one canonical name; aliases in `Avoid`.
- Conventions: a rule needs a config file or two code instances, counted over
  the whole repository; cover where new code goes, errors, config and
  registration, and tests. Each extension seam gets an "adding a new X"
  section. Run build, test and lint when safe and record `verified`,
  `not-run` or `failed`. In a hub each source's conventions page holds its
  commands and rules; the system conventions page holds rules that span
  repositories (branches, releases, contract versioning, change order).

Keep the required headings `okf new` wrote. Done when these pages have no
todo block or hint and `okf validate` shows no error on them.

## 4. Write
Dispatch one writer per Module, Workflow and Flow page, in parallel. Give each
writer the page path, the glossary, the conventions pages (in a hub the
system's and the page's source's), [research](references/research.md) and
[pages](references/pages.md). Writers sweep their scope, rehearse its
typical changes from `git log`, reconcile the brief, use canonical terms,
answer and delete the template hints and the todo block, and return the page
path, the counts `leads confirmed / dropped / new findings`, the change guide
row count, proposed new terms and the open-question count. A writer that
reports no new finding on a scope with triggers, guards or cross-module calls
gets a second sweep. A Flow writer fills the call chain (one cited row per hop,
naming the contract that carries it), a `sequenceDiagram` with the sources as
participants, and changes that need both sides. Merge accepted
terms into the glossary yourself. Done when `okf status` leaves `write`.

## 5. Assemble
Write the pages above the ones just written, bottom-up: each source's overview
(hub) and the architecture page. Structure: how the code splits and which way
dependencies point, from scan `deps` (a `mutual` edge is a cycle to explain or
flag), recorded rationale, cross-module invariants, shared `resources`,
cross-module change guide rows (scan `co_change`), and links to the pages
below. In a hub the architecture page says which repository owns what and
holds the Contracts table: one row per contract it claims, with the change
order and how to verify both sides. Done when no page has a todo block and
`okf validate` shows no error; warnings go to review.

## 6. Review and stamp
Run `okf review prepare --json`. Dispatch a fresh reviewer that wrote none of
these pages; it follows [review](references/review.md) and writes the review
report (`_review.json`) at the path prepare names. On `changes_requested`,
repair the issues and dispatch a new fresh reviewer; it reads the pages, the
sources and the previous review report, nothing else from earlier rounds. Stop
after 3 rounds and show the user the remaining issues. When approved, run
`okf stamp --by repo-wiki/<model>`; it also writes the indexes, `log.md` and,
in a hub, `system-map.md`. Show the user the warnings stamp lists
and `git diff -- <wiki>`; commit only if asked. With no independent reviewer
available, run `okf stamp --unreviewed --by repo-wiki/<model>`; the pages stay
honestly unverified. Stamp refuses `--unreviewed` while a `changes_requested`
review report exists.

## Update
With an existing wiki, `okf impact --json` shows which pages are stale and why;
`okf update --json` turns them into drafts with todo blocks listing each change
(ending in `(since <sha12>)`, so `git diff <sha12> -- <path>` shows it) and a
suggested locator for moved lines. Reasons whose page is missing or unparsable
come back under `unplaced`; restore that page as `okf status` says, then update again.
Redo stages 3-6 for those pages only; revisit stage 2 only for unmapped or
deleted modules, trace each `unclaimed-trigger` (a new route, listener or
job) into a Workflow or Flow page scope or give it a Not covered row, and
claim each `unclaimed-contract`. A `contract-changed` reason means the other
side of a contract the page describes changed: check the call chain or
Contracts row against both sides.
While coding: `okf impact --files <paths> --json` gives, per path, `read` (pages
to read before editing), `update` (pages citing it), `change_guide` rows
(where to start, what else to change, how to verify), the `canon` pages, in a
hub the `contracts` the path is a site of (counterpart sites, the pages that
describe them, their change order), and a `note` (e.g. `no page covers this path`). It also
works from a subdirectory or from inside a hub source, with relative paths read
from the current directory.

## Optional
- `okf pointer` prints the AGENTS.md pointer block (at most 15 lines: how to use
  the wiki, glossary and conventions as must-read, `impact --files`, an `rg`
  pattern for invariant rows, verified commands); `okf pointer --write
  AGENTS.md` only with user approval. In a hub, `okf pointer --source <name>`
  prints the block for that source's AGENTS.md; a human pastes it there.
- `okf links --json` answers "what depends on X" in a hub (`--source`,
  `--contract`, `--file`); `okf log --json` lists recent stamps (`--since`,
  `--files`).
- `okf verify --actor human:<id> <page>` records a human review of a stable page
  (once per actor until the page is re-stamped); never edit `verified` by hand (validate reports it as `unreviewed-edit`).
- Multiple repositories (hub), or OpenGauss databases declared in `repo-wiki.yaml`
  (which repositories use each one, which schemas and tables to capture by
  prefix or suffix globs): [extensions](references/extensions.md).

## Rules
- Locators are plain `path#Lx-Ly` relative to the repository root (hub root in
  hub mode, where the first segment is the source name); a path with spaces is
  written `<my app/x.py>#Lx-Ly`.
- One writer per file at a time. The reviewer writes only `_review.json`.
- Cite and copy only tracked source text; `.env` files, keys and credentials stay out.
