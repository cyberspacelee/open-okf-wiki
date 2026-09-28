# Research

How a writer turns one page's brief into verified content, for canon pages
(stage 3) and every other page (stage 4). A brief is a scout's or tracer's
condensed notes: its items are **leads** — places to look, not a list of what
the page says. The page is only as complete as the writer's own **sweep** of
the source; the brief checks the sweep, it never replaces it.

## 1. Sweep

Before reading the todo block, read the source the page answers for: the page's
`scope`, plus for a Workflow the files the flow calls across its boundaries.
Order the reading by risk, and for each hit decide whether it constrains a
change:

| look for | where it lands |
|---|---|
| guards, asserts, validation that raises; restricted state transitions | invariants table |
| transactions, locks, idempotency keys, unique constraints, retries and rollbacks | invariants, failure and recovery |
| calls across a module boundary; the scan `deps` edges touching this scope | boundaries, dependency direction |
| topics and tables this scope names (scan `resources`) | ordering constraints, change impact |
| triggers in scope (scan `triggers`) and what each one reaches | Workflow trigger to outcome |
| extension seams: registries, plugin interfaces, strategy maps, config switches | extension points |
| comments and commit messages that record a why; TODO/FIXME/HACK | why, gotchas, open questions |
| tests whose names say must/never/always | invariants, related tests |

Useful searches (adjust the path to the page's scope):

    rg -n 'raise |throw new|assert |IllegalStateException|ValueError' <scope>
    rg -n '@Transactional|atomic\(|select_for_update|FOR UPDATE|lock|idempot|retry|rollback' <scope>
    rg -n 'TODO|FIXME|HACK|XXX|NOTE:' <scope>
    git log --format='%h %s' -- <scope> | head -40

For a symbol, prefer the language server's references over text search when
one is available; it returns only uses of that symbol.

The sweep is done when every trigger, guard and cross-boundary call in scope
has either a place in the page or a reason it does not matter.

## 2. Reconcile

Now read the todo block. Mark every lead:

- **confirmed**: the sweep found it, or you open the locator and it holds;
  fold it into the page with its citation.
- **dropped**: the source does not support it, or it fails the Grep Test.
- **moved**: it belongs to another page's scope; hand it to the coordinator.

A lead the sweep missed is a sign the sweep was too shallow there: widen the
sweep around it before moving on. Findings of the sweep that no lead mentions
are **new findings**; they matter most, because they are what discovery missed.

## 3. Finish

Write the page by [pages](pages.md), delete the todo block, run
`okf validate <page>`, and return:

```text
Page: workflows/order-checkout.md
Leads: 7 confirmed, 2 dropped, 1 moved (to modules/payments.md)
New findings: 3
Terms proposed: Settlement window | src/billing/window.py#L12
Open questions: 1
```

The counts are the coordinator's recall check: a page whose scope holds
triggers, guards or cross-module calls and reports no new finding gets a second
sweep.
