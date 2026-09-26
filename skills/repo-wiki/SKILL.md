---
name: repo-wiki
description: Builds and incrementally updates a source-grounded repository knowledge layer (an OKF wiki) that helps coding agents change a codebase safely - architecture, workflows, invariants, project terminology and development conventions, each cited to source lines. Use to create, resume or refresh a repo wiki (single repository or a multi-repository hub, optionally with an OpenGauss schema), or to find which wiki pages a code change affects. Not for API reference dumps, single-file documentation or editing AGENTS.md by hand.
---

# Repo Wiki

Capture what an agent cannot cheaply rediscover: why, boundaries, invariants,
workflows, terminology, conventions, extension points, gotchas and change impact.
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
| `init` | `okf init [--wiki DIR] [--lang en\|zh]`; it creates `repo-wiki.yaml` and the glossary, conventions and architecture stubs, or writes nothing (a repository needs a first commit) |
| `blocked` | fix the config error (a wrong `--wiki` names the configured wiki), or ask the user to commit or stash the dirty source files it names |
| `update` | `okf update --json`: source changed since a page's revision; redrafts the affected pages with the changes in todo blocks |
| `discover` | stage 1; it lasts until a canon page has a brief or every module and workflow stub has one; next actions name the stubs still missing a brief |
| `structure` | stage 2 |
| `research` | stage 3; a missing or broken canon page comes first: run the `okf new` command the action names, or fix its frontmatter |
| `write` | stage 4 |
| `review`, `stamp` | stage 5 |
| `done` | rewrite a stale index with `okf stamp`, or show `git diff -- <wiki>` and commit only if asked; "nothing to do" means the wiki is committed and current |

After `blocked`, `status` lists up to 20 issues, the phase's own first; `pending`
issues are todo blocks, which block stamp but not validate.

## Write, skip, cite

Write only what passes the Grep Test: leave out anything grep plus two or three
files answers in a minute (signatures, field lists, directory trees, copied
config, README restatement). Cite every canon table row and every causal "why"
with a footnote whose definition starts with a locator:
`[^billing-run]: src/billing/run.py#L10-L40`. Write only recorded rationale;
where none exists, write "rationale not recorded". Priorities, section menu,
table formats and examples: [pages](references/pages.md).

## 1. Discover
Run `okf scan --json`. Read README, CONTRIBUTING, docs and ADRs, build and CI
files and entry points. Create a stub per candidate module or workflow:

    okf new modules/billing.md --type Module --description "Read before changing invoice generation or retries." --scope "src/billing/**"

Write each finding as a brief into the todo block of the page it belongs to. For a
large repo, dispatch 2-4 scouts by area: each creates stubs for its area and
writes their briefs, and returns canon candidates, which you merge into the canon
briefs as each handoff arrives. Signals and handoff format:
[discovery](references/discovery.md).

## 2. Structure
Keep module pages only for real boundaries, and workflow pages only for flows an
agent would debug or extend; delete stubs that fail the Grep Test. Finalize each
page's `description` (when to read it) and `scope` globs. List scanned modules
not worth a page in architecture's Not covered table with a reason. Done when
`okf validate` reports no coverage, scope or not-covered errors.

## 3. Research: canon first
Write glossary, conventions and architecture before any other page; in a large
repository give each canon page its own writer, but decide canonical names and
Not covered rows yourself. Verify every candidate in source; drop what you
cannot ground.
- Glossary: project-specific terms only; one canonical name; aliases in `Avoid`.
- Conventions: a rule needs a config file or two code instances. Run build, test
  and lint when safe and record `verified`, `not-run` or `failed`.
- Architecture: boundaries, dependency direction, recorded rationale,
  cross-module invariants and change impact (scan `co_change`).

Keep the required headings `okf new` wrote. Done when the three pages have no
todo block and `okf validate` shows no error on them.

## 4. Write
Dispatch one writer per remaining page, in parallel. Give each writer the page
path, glossary, conventions, architecture and [pages](references/pages.md).
Writers research only their scope, use canonical terms, delete the todo block,
and return the page path, proposed new terms and the open-question count. Merge
accepted terms into the glossary yourself. Done when no page has a todo block
and `okf validate` shows no error; warnings go to review.

## 5. Review and stamp
Run `okf review prepare --json`. Dispatch a fresh reviewer that wrote none of
these pages; it follows [review](references/review.md) and writes the review
report (`_review.json`) at the path prepare names. On `changes_requested`,
repair the issues and dispatch a new fresh reviewer; it reads the pages, the
sources and the previous review report, nothing else from earlier rounds. Stop
after 3 rounds and show the user the remaining issues. When approved, run
`okf stamp --by repo-wiki/<model>`, then show the user the warnings stamp lists
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
Redo stages 3-5 for those pages only; revisit stage 2 only for unmapped or
deleted modules.
While coding: `okf impact --files <paths> --json` gives, per path, `read` (pages
to read before editing), `update` (pages citing it), `change_impact` rows to
check, the `canon` pages and a `note` (e.g. `no page covers this path`). It also
works from a subdirectory or from inside a hub source, with relative paths read
from the current directory.

## Optional
- `okf pointer` prints the AGENTS.md pointer block (at most 15 lines: how to use
  the wiki, glossary and conventions as must-read, `impact --files`, an `rg`
  pattern for invariant rows, verified commands); `okf pointer --write
  AGENTS.md` only with user approval. In a hub, a human pastes it into each
  source's AGENTS.md.
- `okf verify --actor human:<id> <page>` records a human review of a stable page
  (once per actor until the page is re-stamped); never edit `verified` by hand (validate reports it as `unreviewed-edit`).
- Multiple repositories (hub) or an OpenGauss schema: [extensions](references/extensions.md).

## Rules
- Locators are plain `path#Lx-Ly` relative to the repository root (hub root in
  hub mode, where the first segment is the source name); a path with spaces is
  written `<my app/x.py>#Lx-Ly`.
- One writer per file at a time. The reviewer writes only `_review.json`.
- Cite and copy only tracked source text; `.env` files, keys and credentials stay out.
