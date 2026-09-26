# Open OKF Wiki

`repo-wiki` is an agent skill that builds and incrementally updates a
**repository knowledge layer**: a small, source-cited wiki that coding agents
read before they change a codebase. The wiki is an OKF v0.2 bundle committed
next to the code it describes. A deterministic Python kernel (`okf`) handles
scanning, validation, stamping and change impact. The host agent handles
judgment by following [SKILL.md](skills/repo-wiki/SKILL.md).

## Why

The wiki is built for agents to pull from. It never sits in an agent's context
by default.
An evaluation of repository context files (Gloaguen et al. 2026) found that
LLM-generated overviews did not raise task success and raised inference cost by
more than 20%. The main cause was redundancy with the README and the directory
structure. The layer therefore records only knowledge that is expensive to
rediscover: design rationale, boundaries, invariants, workflows, terminology,
conventions, extension points and change impact (priorities and rules in
[pages.md](skills/repo-wiki/references/pages.md)).

The **Grep Test** applies to every page and section: leave out anything that
grep plus two or three files would rebuild in a minute. Only a pointer block of
at most 15 lines is meant to be always loaded, and a human pastes it into
AGENTS.md (in a hub, into each source's AGENTS.md). The evidence and ablation notes are in
[repository-knowledge-layer-evidence.md](docs/research/repository-knowledge-layer-evidence.md).

## What it produces

```text
<repo>/
  AGENTS.md              # optional managed pointer block (okf pointer, with approval)
  docs/wiki/             # default location; choose another with okf init --wiki DIR
    repo-wiki.yaml       # lang: en|zh (plus sources: [...] in a hub)
    index.md             # generated: pages grouped by type + Source map
    architecture.md      # canon: boundaries, dependency direction, Not covered table
    glossary.md          # canon: Term | Meaning | Avoid | Where
    conventions.md       # canon: commands table + rules table
    modules/<name>.md
    workflows/<name>.md
    _review.json         # review report; exists only while a review round is open
```

There are five author page types: **Architecture**, **Glossary** and
**Conventions** (together the *canon*, written first) plus **Module** and
**Workflow**. The OpenGauss extension generates **Schema** and **Table** pages.
The kernel recognizes the canon tables by their header rows, in English or
Chinese:

- glossary: Term, Meaning, Avoid, Where
- commands: Purpose, Command, Status
- rules: Area, Rule, Enforced by
- invariants: Invariant, Enforced at, Breaks when
- change impact: Change, Also change or check
- Not covered: Path, Reason

Rule `Area` is one of `layout`, `naming`, `api`, `errors`, `logging`,
`config`, `testing`, `build-ci`, `dependencies`, `vcs`. Each type also has
required headings that `okf new` writes and `okf validate` checks
(Architecture: Boundaries and dependencies, Not covered; Conventions: Commands,
Rules; Module: Responsibility and boundaries; Workflow: Trigger to outcome; zh
equivalents in zh wikis). Diagrams are recommended, not required.

Every row except Not covered must carry a citation. So must every causal "why"
sentence. A citation is an ordinary footnote whose definition starts with a
plain `path#Lx-Ly` locator (`<my app/x.py>#Lx-Ly` for a path with spaces).

```markdown
---
type: Module
title: Billing run
description: Read before changing invoice generation, proration or billing retries.
scope: [src/billing/**]
status: stable
revision: {.: 3f2a…}                  # source commit the page was checked against
sources: [{id: retry-cap, resource: src/billing/retry.py#L30-L44}]
generated: {by: repo-wiki/<model>, at: 2026-09-25T10:00:00Z}
verified: [{by: repo-wiki-reviewer/<model>, at: 2026-09-25T10:05:00Z}]
stamp: {content_sha256: …, reviewed_by: repo-wiki-reviewer/<model>}  # hash: body, frontmatter except status, sources, verified, stamp, and reviewed_by
---

## Responsibility and boundaries

| Invariant | Enforced at | Breaks when |
|---|---|---|
| At most 3 charge attempts per invoice. | `RetryPolicy.schedule`[^retry-cap] | Customers are charged repeatedly after a gateway timeout. |

Why 3 attempts: rationale not recorded.

[^retry-cap]: src/billing/retry.py#L30-L44
```

Authors write `scope`. The kernel writes `status` and `revision`, and at stamp
time `sources`, `generated`, `verified` and `stamp`. `index.md` lists every
stable page as `[title](path) - description`. Its **Source map** section links
each scanned module to the pages that cover it, or to its Not covered reason.
Modules are build-declared modules plus top-level code directories; a
top-level code root such as `src/` is split into one module per child (unless
it has its own manifest, declared modules or a `main` child), and top-level
test roots are not modules. See [pages.md](skills/repo-wiki/references/pages.md) for the full page
contract.

## Usage

Requirements: Git, Python 3.12+ and [uv](https://docs.astral.sh/uv/). `okf.py`
is a uv script that declares PyYAML and psycopg inline. Install the skill into
the repository that should get the wiki, for example with the skills installer:

```text
npx skills@latest add ../open-okf-wiki/skills/repo-wiki --skill repo-wiki -y
```

You can also copy `skills/repo-wiki/` into your agent's skill directory, such as
`.agents/skills/`. Then ask the agent to "build a repo wiki", "refresh the
wiki" or "which wiki pages does this change affect". The skill loops on
`okf status --json` and does its `next_actions` until the phase is `done`. It
changes only wiki pages, and AGENTS.md only with your approval. It never
commits. The source tree must stay clean for the whole session.

| Stage | What happens | Exit check |
|---|---|---|
| 1 Discover | `okf scan`, read docs, build and CI files; create page stubs whose todo blocks hold briefs; optional parallel scouts | stubs have briefs |
| 2 Structure | keep only pages that pass the Grep Test; settle `description` and `scope`; list skipped modules in Not covered | no coverage, scope or not-covered errors |
| 3 Research | write glossary, conventions and architecture first; run build, test and lint commands where it is safe | canon pages have no todo block and no validation error |
| 4 Write | one writer per remaining page, in parallel, given the three canon pages | no todo block and no validation error anywhere |
| 5 Review & stamp | `okf review prepare`, a fresh independent reviewer per round writing the review report, `okf stamp` | pages are stable, `index.md` is rewritten |
| Update | `okf update` redrafts the stale pages; stages 3-5 run again for those pages only | as above |

Kernel commands (`okf = uv run <skill>/scripts/okf.py`, run from the repository
or hub root; the read-only `status`, `validate` and `impact` also run from any
directory below it, including a hub source; every command accepts `--json`, and
`--wiki DIR` before or after the subcommand):

| Command | Purpose |
|---|---|
| `okf init [--wiki DIR] [--lang en\|zh] [--hub --source NAME ...]` | create `repo-wiki.yaml` and the three canon stubs; refuses a repository (or hub source) without a commit, and writes nothing when it fails |
| `okf status --json` | derived phase, next actions, counts, up to 20 issues |
| `okf scan --json` | repository facts at HEAD: modules, entry points, commands, CI, configs, tests, docs, term candidates, co-change pairs |
| `okf new PATH --type T --description D [--title T] [--scope GLOB ...]` | create a draft page stub with the required headings; a scope glob must match a tracked file |
| `okf validate [--json] [PATH ...]` | check every page; each issue carries a fix hint; exits 1 on errors |
| `okf review prepare --json` | review subject: `subject_digest`, draft pages, review report (`_review.json`) path |
| `okf stamp --by ACTOR [--unreviewed]` | stamp reviewed drafts stable, rewrite `index.md` and list remaining warnings |
| `okf impact [--files PATH ...] --json` | stale pages since their revision; with `--files`, per path `{read, update, change_impact, canon, note}` |
| `okf update --json` | redraft stale pages, listing the changes in a todo block; reasons whose page is missing come back as `unplaced` |
| `okf verify --actor human:ID PAGE ...` | record a human review of stamped pages |
| `okf pointer [--write FILE]` | print or write (through a symlink such as `CLAUDE.md -> AGENTS.md`) the AGENTS.md pointer block (at most 15 lines: index, must-read glossary and conventions, `impact --files`, an `rg` pattern for invariant rows, verified commands) |
| `okf db {tables,describe,capture} --url-env VAR ...` | OpenGauss extension |

For **multi-repository hubs** and **OpenGauss** Schema/Table pages, see
[extensions.md](skills/repo-wiki/references/extensions.md). A hub is a git
repository that holds only the wiki, with each source as an ignored child
repository. Locators there start with the source name, for example
`api/src/…#L10-L40`.

## Incremental update and change impact

Git provides history and transactions. Each page records a `revision` for each
source:

- while the page is a draft, the commit it is being written against;
- once the page is stable, the commit it was checked against.

A page is **stale** when a file in its `scope`, or a file it cites, has changed
since that revision. `okf impact` runs `git diff <revision>..HEAD` once for each
distinct revision and reports a reason for each affected page:

- `cited-moved`, with a suggested new locator when the cited lines moved
  unchanged
- `cited-changed`, `cited-deleted` and `cited-context`
- `scope-added`, `scope-modified` and `scope-deleted`
- `revision-missing`
- `catalog-changed` and `catalog-deleted`, for re-captured or removed tables

It also reports unmapped modules and deleted Not covered paths. `okf update`
turns the affected pages back into drafts and writes one reason line per change
into a todo block, ending in `(since <sha12>)` so `git diff <sha12> -- <path>`
shows the change. The agent then runs stages 3-5 again for those pages only. A
commit that
touches only the wiki does not make a single-repository page stale. While
coding, `okf impact --files <paths> --json` returns for each path the pages to
`read` before you edit it, the pages to `update` afterwards, the
`change_impact` rows to check (`{page, line, change, also}`), the `canon` pages
and a `note` (a resolved or ambiguous hub path, a Not covered reason, or `no
page covers this path`). It also works from a subdirectory or from inside a
hub source; relative paths start at the current directory.

## Trust model

- **Validation.** `okf validate` checks the following:
  - locators exist at the page's revision and point to tracked text files;
  - footnote references and definitions match, and match `sources`;
  - required citations, required section headings and allowed table values;
  - module coverage, scope globs and links;
  - secrets and Mermaid syntax;
  - a matching `index.md`;
  - that no stable page was edited after its stamp, body or frontmatter.

  Alias use, uncited "why" sentences and parroted code are warnings for the
  reviewer.
- **Review.** A reviewer that wrote none of the pages checks every canon row and
  causal sentence against the source. It samples the remaining prose and routes
  three invented tasks through `index.md`. It writes only the review report
  (`_review.json`), which is bound to the drafts by `subject_digest`, so a page
  edited after review makes the approval stale. Each repair round goes to a new
  reviewer with a fresh context that reads only the pages, the sources and the
  previous round's review report; issues carry no IDs or status. After three
  rounds, the remaining issues go to the user. See
  [review.md](skills/repo-wiki/references/review.md).
- **Stamping** needs all of the following: no validation errors, no todo
  blocks, clean sources with draft revisions at HEAD, and an approved review.
  Pages stamped this way get a `verified` record. `okf stamp --unreviewed`
  stamps without that record, so the pages stay honestly unverified; it is
  refused while a `changes_requested` review report exists. A
  `stamp.content_sha256` hash over the body, the frontmatter (except
  `status`, `sources`, `verified` and `stamp`, line endings normalized) and the
  approving reviewer `stamp.reviewed_by` catches later hand edits, including a
  `verified` entry nobody earned.
- **Human review.** You review the wiki as an ordinary `git diff` before you
  commit. `okf verify --actor human:<id>` adds a human `verified` record; it is
  the only `verified` entry allowed after the reviewer's.

## Evaluation

All scripts are uv scripts under `skills/repo-wiki/evals/`. Each tier-2 script
has a `selftest` subcommand (for `eval_update.py`, the default run is the
self-contained test).

| Script | Measures |
|---|---|
| `run_cli_e2e.py` (tier 1) | deterministic lifecycle on a fixture: init → stamp, then moved lines, a changed invariant, a new module and a HEAD move under a draft, checking impact, update and status |
| `eval_update.py [--strict] [--list] [scenarios ...]` | update recall and precision: planted changes in single-repository and hub fixtures must reach `impact` with the right reason kinds, and `update` must draft exactly those pages |
| `eval_routing.py tasks\|packet\|baseline\|score` | routing recall: real commits made after the wiki become tasks; a router that sees only `index.md` picks K pages; the score is how many touched files those pages cover |
| `eval_citations.py sample\|score\|calibrate\|agreement` | citation support rate: blind claim packets for a host-run judge, then scoring and a human calibration sheet with Cohen's kappa |
| `eval_canon.py score --gold G [--run-commands]` | term, rule and command recall against a hand-curated gold file; `--run-commands` re-runs the `verified` commands in a throwaway worktree |
| `setup_java_ws.py BASE` | builds a Kill Bill multi-repository hub for live evaluation |

```text
uv run skills/repo-wiki/evals/run_cli_e2e.py
uv run skills/repo-wiki/evals/eval_update.py --strict
uv run skills/repo-wiki/evals/eval_routing.py selftest
uv run skills/repo-wiki/evals/eval_citations.py selftest
uv run skills/repo-wiki/evals/eval_canon.py selftest
```

## Development

```text
skills/repo-wiki/SKILL.md            # the skill's runtime SOP
skills/repo-wiki/references/         # discovery, pages, review, extensions
skills/repo-wiki/scripts/okf.py      # CLI; _scan/_page/_validate/_review/_stamp/_impact/_status, _db/_dbpages
skills/repo-wiki/scripts/tests/      # pytest suite for the kernel
skills/repo-wiki/assets/templates/   # en and zh page stubs
skills/repo-wiki/evals/              # tier-1 e2e and tier-2 evaluations
docs/design/  docs/adr/  docs/research/
```

Verify, as in [AGENTS.md](AGENTS.md):

```text
cd skills/repo-wiki/scripts && uv run --with pytest --with PyYAML \
  --with "psycopg[binary]" -m pytest tests -q
uv run skills/repo-wiki/evals/run_cli_e2e.py     # deterministic lifecycle e2e
```

CI (`.github/workflows/qa.yml`) runs these on Linux, macOS and Windows, plus the
evaluation commands above and `uvx ruff check skills/repo-wiki`.

Further reading:

- [CONTEXT.md](CONTEXT.md): project vocabulary
- [ADR 0027](docs/adr/0027-repository-knowledge-layer.md): the current
  decision; it supersedes most earlier ADRs, which remain as history
- [Design](docs/design/repository-knowledge-layer.md): the design document
- [Kernel contract](docs/design/repository-knowledge-layer-kernel.md): module
  boundaries, data shapes and CLI output; authoritative for code-level details
