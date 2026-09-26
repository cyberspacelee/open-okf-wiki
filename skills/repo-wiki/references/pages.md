# Pages

How to write one wiki page so it passes `okf validate` and earns its place.

- [Write and skip](#write-and-skip)
- [Page types and section menu](#page-types-and-section-menu)
- [Frontmatter](#frontmatter)
- [Citations](#citations)
- [Canon tables](#canon-tables)
- [Links, todo blocks, diagrams](#links-todo-blocks-diagrams)
- [Good and bad](#good-and-bad)

## Write and skip

Apply the Grep Test to every sentence: if grep plus reading two or three files
rebuilds it within a minute, cut it. Link existing docs instead of restating them.
When space is short, favor content in this order:

1. design rationale
2. boundaries and dependency direction
3. invariants and failure modes
4. workflows and lifecycles
5. terminology
6. conventions
7. extension points
8. co-change points and gotchas

Skip: signature lists, field lists, directory trees, copied config, restated code
comments, README-style overviews, generic best practices.

**Why.** State a reason only when source, a comment, a commit, a doc or an ADR
records it, and cite that record. Otherwise write "rationale not recorded".
A guessed reason is worse than none: it reads as fact and steers the next change.

## Page types and section menu

Headings come from this menu; omit any optional section with nothing grounded
to say. `okf new` writes the required headings and lists optional ones in a
comment. A missing required heading fails `section`; keep the heading text as
the template wrote it (en or zh).

| type | when | required headings (zh) | optional |
|---|---|---|---|
| `Architecture` | always, one page | Boundaries and dependencies (边界与依赖方向); Not covered (未覆盖) with its table | design rationale; cross-module invariants; change impact table (change X → also change or check); links to existing ADRs |
| `Glossary` | always, one page | a glossary table | ambiguities and context boundaries |
| `Conventions` | always, one page | Commands (命令) with its table; Rules (规则) with its table | extension recipes (steps to add a new X) |
| `Module` | a module with a real boundary, invariant or extension point | Responsibility and boundaries (职责与边界) | why; invariants table; extension points; failure modes; change guide (change impact table); gotchas; related tests |
| `Workflow` | a cross-module flow an agent would debug or extend | Trigger to outcome (从触发到结果) | ordering constraints and invariants; failure and recovery; where to change |

A diagram is recommended for Architecture's boundaries and a Workflow's
trigger to outcome, not required.

`Schema` and `Table` pages come only from `okf db capture`; never write them by hand.

## Frontmatter

Author-owned keys:

| key | rule |
|---|---|
| `type` | one of the five types above |
| `title` | short noun phrase |
| `description` | when to read this page, e.g. "Read before changing invoice generation, proration or billing retries." It is copied into `index.md` and is the routing entry point |
| `tags` | optional list of strings |
| `scope` | source globs this page answers for; required for Module and Workflow. `**` spans directories; a plain directory path covers everything below it. Scopes may overlap |

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
impact table, and
every causal sentence (because, so that, to avoid, 因为, 为了). Other prose needs
a citation when it states a fact an agent would act on.

## Canon tables

The kernel recognizes tables by header row; use exactly one of these headers
(en or zh). Every row except Not covered needs a footnote.

| kind | en header | zh header |
|---|---|---|
| glossary | Term, Meaning, Avoid, Where | 术语, 含义, 避免, 位置 |
| commands | Purpose, Command, Status | 用途, 命令, 状态 |
| rules | Area, Rule, Enforced by | 范畴, 规则, 保障 |
| invariants | Invariant, Enforced at, Breaks when | 不变量, 强制位置, 违反后果 |
| change impact | Change, Also change or check | 变更, 同步修改或检查 |
| not covered | Path, Reason | 路径, 原因 |

Allowed values (same tokens in zh pages):

- Command `Status`: `verified` (ran successfully this session), `not-run`, `failed`.
- Rule `Area`: `layout`, `naming`, `api`, `errors`, `logging`, `config`,
  `testing`, `build-ci`, `dependencies`, `vcs` (commit message, branch and PR
  conventions). Extension knowledge is not a rule: steps to add a new X go in
  Conventions' Extension recipes, module-specific ones in the Module's
  Extension points.
- Rule `Enforced by`: `lint`, `typecheck`, `test`, `ci`, `review`, `convention`.
  It tells the agent whether a tool will catch a violation.

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

| Change | Also change or check |
|---|---|
| Add an invoice state | `InvoiceState` transitions and `tests/test_invoice_states.py`[^states] |

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
- Change impact has one home: cross-module rows in Architecture, rows local to
  one module in that module's Change guide. Each row cites the co-change
  evidence (scan `co_change`, a test, or the code that couples the two).

## Links, todo blocks, diagrams

- Link pages with bundle-absolute paths: `[billing run](/modules/billing.md)`.
  Link Schema/Table pages the same way; they are never footnote targets.
- `<!-- okf:todo ... -->` is the only place for briefs and pending changes. A
  page with a todo block cannot be stamped. Fold what you verified into the
  body, drop the rest, then delete the whole block.
- Diagrams are optional fenced `mermaid` blocks: `flowchart` for boundaries,
  `sequenceDiagram` or `flowchart` for workflows. One per page is usually
  enough; each edge must be backed by cited prose nearby.
- Identifiers, paths and commands stay in their original language.

## Good and bad

Bad: parrots code an agent can read in seconds, invents a reason, cites nothing.

```markdown
## Responsibility and boundaries
The `RetryPolicy` class has fields `max_attempts`, `backoff` and `jitter`.
`schedule()` calls `next_delay()` and then `enqueue()`. Retries are capped at 3
because the payment gateway rate-limits.
```

Good: states the boundary and the invariant, cites both, and is honest about why.

```markdown
## Responsibility and boundaries
Billing owns invoice creation and retries; it never calls the payment gateway
directly and goes through `payments.Client`.[^gateway-seam]

| Invariant | Enforced at | Breaks when |
|---|---|---|
| At most 3 charge attempts per invoice. | `RetryPolicy.schedule`[^retry-cap] | Customers are charged repeatedly after a gateway timeout. |

Why 3 attempts: rationale not recorded.

[^gateway-seam]: src/billing/charge.py#L8-L21
[^retry-cap]: src/billing/retry.py#L30-L44
```
