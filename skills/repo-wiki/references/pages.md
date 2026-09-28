# Pages

How to write one wiki page so it passes `okf validate` and helps an agent that
is about to change code.

- [What a page answers](#what-a-page-answers)
- [Write and skip](#write-and-skip)
- [Page types](#page-types)
- [How it works](#how-it-works)
- [Making changes](#making-changes)
- [Headings and voice](#headings-and-voice)
- [Frontmatter](#frontmatter)
- [Citations](#citations)
- [Tables](#tables)
- [Links, todo blocks, hints, diagrams](#links-todo-blocks-hints-diagrams)
- [Good and bad](#good-and-bad)

## What a page answers

An agent opens a page right before it edits the page's scope. The page earns
its place when it answers, faster than reading the code:

1. What does this part own, and what must it not depend on?
2. How does it work: where does a call enter, which files does it pass
   through, where is data created, changed and stored?
3. Where do I start reading, and which files does a typical change touch?
4. What must not break, and what else changes when this changes?
5. How do I check that my change works?

A page that lists responsibilities and risks but cannot answer 2, 3 and 5 has
failed, however correct it is.

## Write and skip

**Assembly test.** Keep a fact when rebuilding it takes more than one file or
a record outside the code: a call chain across files, a data path from entry
to storage, a rule stated nowhere in code (an invariant expressed as an
absence), a reason recorded in a commit or ADR, the set of files a change
must touch together. Cut a fact that one file answers at a glance.

| cut (one file answers it) | keep (needs several files or a record) |
|---|---|
| a class's fields, a function's signature | the call chain from the route to the row written, across four files |
| the order of calls inside one function | which module owns a table two modules write |
| a directory tree | where a new provider goes and the three places it must be registered |
| a restated code comment or README | why the retry cap is 3, cited to the commit that set it |
| generic best practice | the one test that catches a broken posting guard |

**Why.** State a reason only when source, a comment, a commit, a doc or an ADR
records it, and cite that record. Otherwise write "rationale not recorded"
(zh: "原因未记录"). A guessed reason is worse than none: it reads as fact and
steers the next change.

**Shape follows the code.** Every page has its type's required sections; past
them, write only the sections this part of the code gives you something to say
about, and name them after what they hold. A module whose hard part is a state
machine gets a section on its states; one that carries a legacy protocol gets a
section on the compatibility it keeps. An empty or generic section is worse
than none: the reviewer flags it as `filler`.

## Page types

Required headings are fixed (en or zh, any level, case-insensitive); a missing
one fails `section`. Keep the heading text as the template wrote it. Every
other heading is yours.

| type | when | required headings (en / zh) | often worth adding |
|---|---|---|---|
| `Architecture` | always, one page | Structure / 整体结构; Not covered / 未单独成页 with its table | design decisions (link ADRs); cross-module invariants; cross-module changes (change guide table) |
| `Glossary` | always, one page | a glossary table | commonly confused terms / 易混淆的术语 |
| `Conventions` | always, one page | Commands / 常用命令 with its table; Rules / 开发规则 with its table | where new code goes; adding a new X (one section per extension seam) |
| `Module` | a module with a real boundary, mechanism or extension seam | Responsibility / 模块职责; How it works / 工作原理; Making changes / 修改指南 with a change guide table | invariants; why it is built this way; error handling; adding a new X; compatibility; known pitfalls |
| `Workflow` | a flow an agent would debug or extend, from a scan trigger or a public entry point | Flow / 执行流程; Making changes / 修改指南 with a change guide table | ordering and consistency; failure, retry and compensation; where to look when it breaks |

A Module or Workflow page needs at least one change guide row
(`change-guide`); an Architecture page may hold cross-module rows.

`Schema` and `Table` pages come only from `okf db capture`; never write them by hand.

## How it works

The section an agent cannot get from grep. Describe the mechanism, not the
inventory:

- **Entry**: where calls come in (public functions, routes, listeners, jobs,
  CLI commands), cited.
- **Path**: the key call chain in order, naming each file it crosses; stop
  where the call leaves the scope, and link the page that picks it up.
- **Data**: where the main objects are created, transformed and persisted;
  which tables, topics, files or caches are read or written.
- **Wiring**: how the parts are connected: registries, dependency injection,
  config switches, plugin discovery. This is often what an agent misses.
- **Collaborators**: which modules it calls and which call it, with the
  direction.

Prefer a short numbered path plus one mermaid diagram over paragraphs. Each
step and each diagram edge needs cited prose nearby.

## Making changes

Open with two or three sentences on where to start reading: the two or three
files that hold the logic, each with its role. Then the change guide table,
one row per change this scope really gets:

| en | zh | holds |
|---|---|---|
| Change | 修改场景 | the task, in the words a developer would use ("add a payment method", "raise the retry cap") |
| Start at | 从这里改 | the file or symbol to open first, cited |
| Also change | 同步修改 | files, registrations, config, docs or tests that must change with it; `-` when none |
| Verify | 如何验证 | the test file, command or manual check that shows it works |

Take the rows from real history: `git log --format='%h %s' -- <scope>` shows
the changes this scope actually gets, and scan `co_change` shows what moved
together. Name concrete tests in Verify; a bare "run the tests" helps nobody.
`okf impact --files` returns these rows to an agent about to edit a matching
file, so a row is a promise: the files in Also change really do move with it.

## Headings and voice

Write the way a senior engineer hands a module over: plain, specific, in the
team's words. Name a heading after what the section says ("How refunds reach
the gateway", "退款如何到达网关"), not after a category ("Failure modes",
"失败模式"). Identifiers, paths and commands stay in their original language.

For zh pages, avoid word-by-word translations of English template words:

| stiff | natural |
|---|---|
| 职责与边界 | 模块职责；边界与依赖 |
| 不变量 | 关键约束 |
| 失败模式 | 常见故障；出错时会怎样 |
| 陷阱 | 已知的坑；开发注意事项 |
| 强制位置 / 违反后果 | 由谁保证 / 违反会怎样 |
| 变更指引 | 修改指南 |

## Frontmatter

Author-owned keys:

| key | rule |
|---|---|
| `type` | one of the five types above |
| `title` | short noun phrase |
| `description` | when to read this page, e.g. "Read before changing invoice generation, proration or billing retries." It is copied into `index.md` and is the routing entry point |
| `tags` | optional list of strings |
| `scope` | source globs this page answers for; required for Module and Workflow. `**` spans directories; a plain directory path covers everything below it. Scopes may overlap. A Workflow scope names its trigger files and the files the flow runs through; that claims the triggers (`trigger-coverage`) and routes `okf impact --files` on them to the page |

Kernel-owned keys; leave them as the kernel wrote them: `status`, `revision`
(set by `okf new` and `okf update`), and after stamp `sources`, `generated`,
`verified`, `stamp`. Edit a page only while `status: draft`: `stamp.content_sha256`
covers the body, every frontmatter key except `status`, `sources`,
`verified` and `stamp`, and the approving reviewer `stamp.reviewed_by` (null for
`--unreviewed`), so any other edit under `status: stable` fails
`unreviewed-edit`. `verified` must be the reviewer entry stamp wrote (if any)
followed only by `human:` entries from `okf verify`; a hand-added entry fails
`unreviewed-edit` too. To change a stable page, set `status: draft` first.

## Citations

Cite with a footnote whose definition starts with a locator, optionally followed
by a note of at most one line:

```markdown
Posted invoices are immutable; corrections become credit items.[^posted]

[^posted]: src/billing/invoice.py#L40-L58 guard in post()
```

- Label: `[A-Za-z0-9][A-Za-z0-9._-]*`, a semantic slug (`posted`, `retry-cap`), not `1`, `2`.
- Every reference has a definition and every definition is referenced.
  A `[^x]` inside a code span does not count as a reference.
- Locator: `path`, `path#L5` or `path#L5-L9`; path relative to the repository
  root (hub root in hub mode, so it starts with the source name). It must exist
  as a tracked text file at the page's `revision`, with the lines in range. A
  path containing spaces goes in angle brackets, `<my app/run.py>#L5-L9`, the
  form `okf scan` prints for it; other paths, Unicode included, stay bare.

| locator | valid? |
|---|---|
| `src/billing/run.py#L10-L40` | yes |
| `src/billing/run.py#L12` | yes |
| `Makefile` | yes, whole file |
| `api/src/billing/run.py#L10-L40` | yes, in a hub with source `api` |
| `<my app/run.py>#L10-L40` | yes, a path with spaces |
| `my app/run.py#L10-L40` | no: the locator ends at the first space; use `<my app/run.py>#L10-L40` |
| `服务/核心.py#L3` | yes, Unicode paths need no brackets |
| `./src/billing/run.py#L10` | no: `.` segment |
| `/src/billing/run.py` | no: absolute |
| `src/billing/run.py:10` | no: line goes in `#L10` |
| `src/billing/run.py#L40-L10` | no: start after end |
| `src/billing/run.py#10-40` | no: missing `L` |
| `src/billing/` | no: directory |
| `https://github.com/o/r/blob/main/x.py` | no: URL |
| `.env`, `deploy/key.pem` | no: secret files are never cited |

**Must cite:** every row of a glossary, commands, rules, invariants or change
guide table, every step of How it works, and every causal sentence (because,
so that, to avoid, 因为, 为了). Other prose needs a citation when it states a
fact an agent would act on.

## Tables

The kernel recognizes tables by header row; use exactly one of these headers
(en or zh). Every row except Not covered needs a footnote.

| kind | en header | zh header |
|---|---|---|
| glossary | Term, Meaning, Avoid, Where | 术语, 定义, 勿用别名, 代码位置 |
| commands | Purpose, Command, Status | 用途, 命令, 状态 |
| rules | Area, Rule, Enforced by | 类别, 规则, 检查方式 |
| invariants | Invariant, Enforced at, Breaks when | 关键约束, 由谁保证, 违反会怎样 |
| change guide | Change, Start at, Also change, Verify | 修改场景, 从这里改, 同步修改, 如何验证 |
| not covered | Path, Reason | 路径, 原因 |

Allowed values (same tokens in zh pages):

- Command `Status`: `verified` (ran successfully this session), `not-run`, `failed`.
- Rule `Area`: `layout` (where code of each kind goes), `naming`, `api`,
  `errors`, `logging`, `config` (loading, defaults, registration),
  `testing`, `build-ci`, `dependencies`, `vcs` (commit message, branch and PR
  conventions). Steps to add a new X are not a rule: they go in an "adding a
  new X" section, in Conventions when the seam spans modules, on the Module
  page otherwise.
- Rule `Enforced by`: `lint`, `typecheck`, `test`, `ci`, `review`, `convention`.
  It tells the agent whether a tool will catch a violation.
- Change guide `Start at` and `Verify` must not be empty or `-`.

```markdown
| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | In billing, the scheduled pass that turns due subscriptions into invoices. | invoice job, cycle | `BillingRun`[^billing-run] |

| Purpose | Command | Status |
|---|---|---|
| Unit tests | `uv run pytest -q`[^pytest] | verified |

| Area | Rule | Enforced by |
|---|---|---|
| errors | Service code raises `DomainError` subclasses; HTTP mapping happens only in `api/errors.py` (4 instances).[^err] | convention |

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never mutated. | `Invoice.post`[^posted] | Totals drift from the ledger; refunds double-count. |

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Add an invoice state | `InvoiceState`[^states] | transition table in `invoice.py`; `docs/states.md` | `tests/test_invoice_states.py` |

| Path | Reason |
|---|---|
| `third_party/` | Vendored upstream code; never modified here. |
```

- Glossary `Meaning` names, in words, the module or context that owns the
  term (e.g. "In billing, ..."); `Where` cites the definition site; `Avoid`
  lists aliases, comma separated. Other pages use the canonical term; an alias outside a code span
  raises an `alias` warning.
- A command cites where it is defined (Makefile, package.json, CI file).
- A rule cites its config file, or one of at least two code instances with the
  instance count written in the Rule cell.
- A change guide row has one home: cross-module rows in Architecture, rows
  local to one module or flow on its page. Each row cites the code it starts
  at or the co-change evidence (scan `co_change`, a test, the code that
  couples the files). A topic or table two modules share (scan `resources`)
  belongs in a row too: changing its shape means changing the other side.
- A Not covered row names a module, a file or a glob and gives a reason; it
  excludes modules from `coverage` and trigger files from `trigger-coverage`
  (`src/**/web/Health*.java | Health probes; no flow.`).

## Links, todo blocks, hints, diagrams

- Link pages with bundle-absolute paths: `[billing run](/modules/billing.md)`.
  Link Schema/Table pages the same way; they are never footnote targets.
- `<!-- okf:todo ... -->` is the only place for briefs and pending changes. A
  page with a todo block cannot be stamped. Fold what you verified into the
  body, drop the rest, then delete the whole block.
- `<!-- okf:hint ... -->` comments come from the template and say what a
  section should answer. Answer it, then delete the comment; a hint left in
  the page is pending work (`hint`) and blocks stamp like a todo block.
- Diagrams are fenced `mermaid` blocks: `flowchart` for structure,
  `sequenceDiagram` or `flowchart` for how it works and flows. One per page is
  usually enough; each edge must be backed by cited prose nearby.

## Good and bad

Bad: a risk checklist with nothing on how the module runs or how to change it,
headings named after categories, a guessed reason.

```markdown
## Responsibility

Billing is responsible for billing.

## Failure modes

Errors may occur. Retries are capped at 3 because the gateway rate-limits.

## Pitfalls

Be careful when changing billing.
```

Good: owner and boundary, the mechanism across files, where to start, a real
change with its co-changes and its test, and honesty about why.

```markdown
## Responsibility

Billing turns due subscriptions into posted invoices and retries failed
charges. It never calls the payment gateway directly; every charge goes
through `payments.Client`.[^gateway-seam]

## How it works

1. The nightly job calls `BillingRun.execute`, which loads due subscriptions.[^run]
2. `Invoice.post` freezes the totals and writes the ledger entry in one
   transaction.[^posted]
3. `charge()` calls `payments.Client.charge`; a gateway timeout goes to
   `RetryPolicy.schedule`, which re-enqueues the invoice.[^retry-cap]

## Making changes

Start with `run.py` (the pass) and `invoice.py` (posting rules); retries live
apart in `retry.py`.

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Change the retry cap | `RetryPolicy.schedule`[^retry-cap] | `tests/test_retry.py` expectations | `uv run pytest tests/test_retry.py` |
| Add a line-item type | `LineItem`[^items] | proration in `proration.py`; ledger mapping in `ledger.py` | `uv run pytest tests/test_invoice.py` |

## Posted invoices are frozen

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never mutated. | `Invoice.post`[^posted] | Totals drift from the ledger; refunds double-count. |

Why 3 charge attempts: rationale not recorded.

[^gateway-seam]: src/billing/charge.py#L8-L21
[^run]: src/billing/run.py#L12-L40
[^posted]: src/billing/invoice.py#L40-L58
[^retry-cap]: src/billing/retry.py#L30-L44
[^items]: src/billing/items.py#L5-L30
```
