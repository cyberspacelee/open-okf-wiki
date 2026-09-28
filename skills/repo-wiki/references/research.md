# Research

How a writer turns one page's brief into verified content, for canon pages
(stage 3) and every other page (stage 4). A brief is a scout's or tracer's
condensed notes: its items are **leads**, places to look, not a list of what
the page says. The page is only as complete as the writer's own **sweep** of
the source; the brief checks the sweep, it never replaces it.

## 1. Sweep

Before reading the todo block, read the source the page answers for: the page's
`scope`, plus for a Workflow the files the flow calls across its boundaries.
Read it twice, for two different things.

**How it works.** Start from the entry points and follow the calls:

| look for | where it lands |
|---|---|
| public functions, routes, listeners, jobs, CLI commands in scope (scan `triggers`, `entry_points`) | How it works: entry; Workflow flow |
| the call chain from each entry until it leaves the scope; the scan `deps` edges touching this scope | How it works: path; Responsibility: dependencies |
| where the main objects are created, transformed, persisted; tables and topics named (scan `resources`) | How it works: data; change guide rows for shared shapes |
| registries, dependency injection, config switches, plugin discovery, strategy maps | How it works: wiring; an "adding a new X" section |

**What constrains a change.** Then order the reading by risk:

| look for | where it lands |
|---|---|
| guards, asserts, validation that raises; restricted state transitions | invariants table |
| transactions, locks, idempotency keys, unique constraints, retries and rollbacks | invariants; a section on failure and retry |
| error types raised and where they are translated | a section on error handling, or a Conventions `errors` rule |
| comments and commit messages that record a why; TODO/FIXME/HACK | why; known pitfalls; open questions |
| tests whose names say must/never/always; the test files that cover the scope | invariants; the Verify column |

Useful searches (adjust the path to the page's scope):

    rg -n 'raise |throw new|assert |IllegalStateException|ValueError' <scope>
    rg -n '@Transactional|atomic\(|select_for_update|FOR UPDATE|lock|idempot|retry|rollback' <scope>
    rg -n 'register|registry|@Component|@Bean|entry_points|plugins?|providers?' <scope>
    rg -n 'TODO|FIXME|HACK|XXX|NOTE:' <scope>

For a symbol, prefer the language server's references over text search when
one is available; it returns only uses of that symbol.

The sweep is done when every entry, trigger, guard and cross-boundary call in
scope has either a place in the page or a reason it does not matter.

## 2. Rehearse changes

The change guide comes from history, not imagination. Run:

    git log --format='%h %s' -- <scope> | head -40
    git show --stat <sha>        # for the commits that look like typical work

Group the commits into the few kinds of change this scope really gets (a new
provider, a changed rule, a new field end to end). For each kind, look at one
real commit: the file it started in is Start at; the other files it had to
touch are Also change (confirm with scan `co_change`); the tests it changed or
that cover the path are Verify. When history is thin, rehearse the change the
brief or the reviewer's routing test suggests, and trace it through the code
the same way.

## 3. Reconcile

Now read the todo block. Mark every lead:

- **confirmed**: the sweep found it, or you open the locator and it holds;
  fold it into the page with its citation.
- **dropped**: the source does not support it, or it fails the assembly test.
- **moved**: it belongs to another page's scope; hand it to the coordinator.

A lead the sweep missed is a sign the sweep was too shallow there: widen the
sweep around it before moving on. Findings of the sweep that no lead mentions
are **new findings**; they matter most, because they are what discovery missed.

## 4. Finish

Write the page by [pages](pages.md): the required sections first, then only
the sections this code gives you something to say about, named for what they
hold. Answer and delete every `okf:hint`, delete the todo block, run
`okf validate <page>`, and return:

```text
Page: workflows/order-checkout.md
Leads: 7 confirmed, 2 dropped, 1 moved (to modules/payments.md)
New findings: 3
Change guide rows: 3 (2 from history)
Terms proposed: Settlement window | src/billing/window.py#L12
Open questions: 1
```

The counts are the coordinator's recall check: a page whose scope holds
triggers, guards or cross-module calls and reports no new finding gets a second
sweep; a change guide with no row taken from history gets a second rehearsal
unless the scope has no history.
