# Discovery

Find candidate knowledge, decide where each candidate lands, and leave it as a
brief in that page's todo block. Nothing here is verified yet; stage 3 and 4
verify or drop every candidate.

## Read the scan

`okf scan --json` prints repository facts for the current HEAD; nothing is saved.

| key | use it for |
|---|---|
| `sources` | `clean: false` lists dirty tracked files; stop until they are committed or stashed. `shallow: true` means a shallow clone: `co_change` is empty or thin, so ask whether full history can be fetched |
| `modules` | modules to cover: each needs a page scope or a Not covered row. Build-declared modules (Maven, Gradle, workspaces) plus top-level code directories; a top-level code root (`src`, `lib`, `app`, `pkg`, `internal`, `packages`, `source`, `cmd`) is split into one module per child directory holding code, unless it has its own manifest, declared modules below it or a `main` child (`src/main`, `src/test` stay one module); top-level test directories (`tests`, `test`, `spec`, `specs`, `__tests__`, `e2e`, `testing`, `*-tests`, `fixtures`, `testdata`, `__mocks__`) are not modules and need no scope or Not covered row; parents that only aggregate nested modules are left out, and a file belongs to its deepest module. Inside one build, packages split further: a JVM `src/main/java/<base package>` or a Python package with two or more child packages of at least 3 production files each makes each child a module (`src/main/java/com/acme/shop/order`), so a monolith shows its domain packages. `triggers` counts the trigger files each module holds |
| `triggers` | where work enters production code, one entry per file with its `module`, `kinds` and first `locator`: `http` (Spring MVC, JAX-RS, FastAPI/Flask routes, Django `urls.py`, DRF views, NestJS, Express, Go handlers, ASP.NET), `rpc` (Dubbo, gRPC), `listener` (Kafka, RabbitMQ, JMS, RocketMQ, SQS consumers), `job` (`@Scheduled`, XXL-Job, Quartz, Celery, APScheduler, Airflow, NestJS cron), `event` (in-process event listeners, Django signals), `cli` (click/typer, Django commands), `startup` (`CommandLineRunner`). Feign and MicroProfile REST client interfaces are outbound calls, not triggers. Each trigger file must end up in a Workflow page scope or a Not covered row (`trigger-coverage`) |
| `deps` | module edges `from` → `to` with the import `count`, the first import `locator`, and `mutual: true` when the modules import each other (a cycle); Java/Kotlin, Python, JS/TS (relative paths and workspace package names) and Go imports, test code excluded. The dependency direction Architecture states comes from here |
| `central` | files imported from two or more other modules, most importers first: shared kernels whose change ripples widely |
| `resources` | message topics and database tables named in two or more modules (listener annotations, consumers, send/publish calls with a literal name, entity mappings, MyBatis mapper XML, SQL files and SQL string literals), with one locator per module: coupling that no import shows |
| `entry_points` | process entry points (declared scripts, JVM `main` programs, Python files with `if __name__ == "__main__":`, `Dockerfile`, `web.xml`, API specs); never a test file. Framework entry points are in `triggers` |
| `commands`, `ci` | command candidates, each with the locator that defines it and the `cwd` it runs from (relative to the source root the locator names): that file's directory, or the source root when the command names that file by its source-root path. `kind` (`build`, `test`, `lint`, `format`, `typecheck`, `other`) says which Conventions row it can fill. A Python file with PEP 723 inline metadata (`# /// script`) is the command `uv run <path>` with `cwd` `.` (the source root). Besides declared scripts and targets, scan adds each build tool's own commands (Maven, Gradle, Cargo, Go, Python tools, .NET, CMake) with the project's wrapper, runner or lock prefix; to narrow a Maven reactor to one module add `-pl <module> -am`. A CI step `uses <workflow>` runs a reusable workflow kept elsewhere |
| `configs` | lint, format and type configs: rule candidates with `Enforced by` lint or typecheck; a file repeated per module is listed a few times only |
| `tests` | test layout and naming pattern: a `testing` rule candidate |
| `docs` | README, CONTRIBUTING, CONTEXT, GLOSSARY, ARCHITECTURE, ADRs, AGENTS/CLAUDE.md, PR templates to read and link, not restate; files under a `templates/` or `assets/` directory are skeletons, not docs |
| `terms` | term candidates with first locator and count, a fair share per kind: `defined` (bold definitions in docs), `state` (an enum-like type, with its first `members`), `camel` (type names used across directories); test files and Markdown under `templates/` or `assets/` add no candidates and do not count toward any kind's count. Abbreviations come from docs and code reading, not from scan |
| `co_change` | file pairs that change together: change impact rows (Architecture across modules, module Change guide within one); build-manifest version bumps are left out |
| `truncated` | one entry per key whose list hit its limit, saying how many were shown and where to find the rest; empty when nothing was cut |

Then read README, CONTRIBUTING, the build and CI files, the entry points and
the listed docs.

## Six categories

| category | signals | keep when | lands in |
|---|---|---|---|
| Modules and boundaries | scan `modules` and `deps` (direction, `mutual` cycles); `central` files; a module's public surface; who calls whom across a boundary | the boundary constrains a change (an allowed dependency direction, a seam, an owner) | architecture brief, plus a module stub when it has an invariant, extension point or rationale of its own |
| Workflows | scan `triggers`; a topic or table in `resources` that one module writes and another reads; follow calls from a trigger until they cross at least one module boundary | spans modules and an agent would debug or extend it | workflow stub scoped to its trigger files and the files the flow runs through; a trigger worth no page is a Not covered candidate |
| Terminology | see [Terminology](#terminology) | project-specific | glossary brief |
| Conventions and commands | see [Conventions](#conventions) | config-backed or ≥2 instances | conventions brief |
| Invariants and risks | asserts, guards, validation; exceptions with messages; transactions, locks, idempotency keys; DB constraints; restricted state transitions; must/never in test names; TODO/FIXME/HACK/NOTE; rollback and retry logic | breaking it corrupts data, loses work or fails silently | the owning module or workflow brief; cross-module ones in the architecture brief |
| Open questions | a why you cannot find; conflicting code and docs; dead-looking paths | an answer would change what the page says | the brief of the page it concerns |

A module earns its own page only when it has something beyond "what files are
here": a real boundary, an invariant, an extension point or recorded rationale.
Anything else becomes a Not covered row or a line in architecture.

## Terminology

Signals: existing CONTEXT, GLOSSARY or terminology files first; then
definition sentences and bold terms in docs; enum members, state
constants and state-machine states; message, protocol and event names; core
config keys; package and module names used as domain nouns; abbreviations used
across modules; test names that describe behavior.

- Take project-specific terms only: domain words, internal abbreviations,
  module nicknames, protocol and state names. A generic technical word qualifies
  only when this repository gives it a narrower meaning.
- One concept, one canonical name: prefer the name in code identifiers, then
  in docs. Put every other spelling in `Avoid`.
- Record the definition site locator for `Where`.

## Conventions

Signals: lint, format and type configs; CI steps; CONTRIBUTING; repeated code
patterns such as error type hierarchy, logging wrapper, config loading,
dependency injection, test fixtures; consistent directory and file naming.
Commit message format (`git log --format=%s -30`), branch naming and PR
templates are rules with Area `vcs`. Steps to add a new X go in Conventions'
Extension recipes, not in a rule; co-change pairs from scan become change
impact rows, not rules.

**Evidence threshold:** a rule comes from a config file, or from at least two
code instances. Record the instance count and the locators. One instance is an
observation, not a convention; drop it.

## Commands

Run the project's own commands found by scan (build, test, lint, typecheck,
format check) when they run locally without credentials or side effects.
Record the outcome for the Status column: `verified` (ran and succeeded now),
`failed` (ran and failed; note why in the brief), `not-run` (not safe or not
possible here).

Leave as `not-run` without running: deploy, release, publish, push, migrate
against a real database, anything that deletes data or touches remote services,
and anything needing secrets. Keep the working tree clean: if a command writes
tracked files, restore them with `git checkout -- <paths>` before continuing.

## Briefs

A brief is the todo block of the page the candidate belongs to. Write facts with
locators and questions, not prose:

```markdown
<!-- okf:todo
Boundary: billing calls payments only via payments.Client? src/billing/charge.py#L8-L21
Invariant: posted invoice never mutated; guard src/billing/invoice.py#L40-L58
Invariant: at most 3 charge attempts; src/billing/retry.py#L30-L44
Open question: why 3 attempts? nothing in docs or commit messages yet
Term: "dunning" used in src/billing/dunning.py#L1-L12 and docs/billing.md#L20
-->
```

Create module and workflow stubs as you go, each with a draft `description` and
`scope`; stage 2 finalizes them:

    okf new workflows/invoice-posting.md --type Workflow --description "Read before changing how invoices are posted or retried." --scope "src/billing/**" --scope "src/payments/client.py"

## Scouts

For a large repository, split by area (a group of modules). A scout runs
`okf scan --json` itself, reads only its area, creates the module stubs for it
with `okf new`, and writes their briefs. It writes no canon page;
it returns canon candidates in its handoff:

```text
Area: src/billing, src/payments
Pages: modules/billing.md, modules/payments.md
Terms: Billing run | scheduled pass turning due subscriptions into invoices | aliases: invoice job | src/billing/run.py#L12
Rules: errors | DomainError subclasses in service code (4 instances) | src/billing/errors.py#L3-L10
Commands: billing integration tests | make test-billing | Makefile#L22
Invariants (cross-module): payments never import billing | src/payments/__init__.py#L1-L6
Not covered: src/legacy_export | dead since 2023? no imports found
Open questions: 2
```

Merge each handoff into the canon briefs (glossary, conventions, architecture)
when it arrives.

## Tracers

Workflows cross the areas scouts are split by, so a second pass assigns them
by trigger, not by area. Group scan `triggers` by module and kind (all `http`
controllers of `order`, all `job` files of `billing`), add one group per topic
in `resources` that two modules share, and give each tracer one to three
groups. Its task names the trigger files, the output (workflow stubs and
briefs), the tools (`rg`, the language server's references, `git log`) and
where to stop: at the outcome (a row written, a message sent, a response
returned) or where the flow enters a page another tracer owns.

For each trigger, a tracer follows the calls from entry to outcome and notes
every module boundary crossed, every topic or table touched, and every guard,
transaction and retry on the way. Triggers that run the same flow share one
workflow stub; a trigger that crosses no boundary and guards nothing (health
check, plain CRUD) becomes a Not covered candidate with its reason. The brief
of a workflow stub records the path as leads:

```markdown
<!-- okf:todo
Trigger: POST /orders OrderController.create src/order/web/OrderController.java#L40-L58
Step: reserves stock via inventory Feign client src/order/client/InventoryClient.java#L12
Step: publishes order-created; payment consumes it src/payment/PaymentListener.java#L20
Invariant: order row and outbox insert share one transaction src/order/OrderService.java#L77-L95
Open question: what happens when the reservation times out? no handler found
-->
```

Handoff:

```text
Groups: order http (4 files), order-created topic
Pages: workflows/order-checkout.md, workflows/payment-capture.md
Not covered: src/order/web/HealthController.java | health probe, no flow
Unclaimed: 0 of 6 trigger files
Open questions: 1
```

Discovery is done when every scanned module has a page scope or a Not covered
candidate, every trigger file sits in a workflow stub's scope or a Not covered
candidate, and every candidate sits in some page's brief. `okf status` stays in
`discover` while a canon page or a stub has no brief, or while scan found
triggers and no Workflow page exists; its next actions name what is missing,
and `okf validate --json` lists every unclaimed trigger file (`trigger-coverage`).
