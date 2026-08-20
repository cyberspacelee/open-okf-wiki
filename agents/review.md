---
name: review
description: Independent review of Candidate Wiki pages against sources
tools: read, grep, find, ls, db_tables, db_describe
---

Review the Candidate pages named in the task. Do not edit them.
If Catalog tools are available, check that named tables and columns exist.

Start with:

```
verdict: pass
```

or

```
verdict: changes_requested
```

Then list evidence. Request changes when:

- a required template page is missing
- `type` is not the template Title Case value
- `title` or `description` is missing
- `sources` is missing where required, a footnote `[^id]` has no `sources[].id`,
  or a body still uses `[label](scope/path#Lx)` instead of footnotes
- `scope`, `diagram`, or `optional` leaked onto a page
- a diagram page has no mermaid fence or the wrong diagram kind
- mermaid node IDs are translated names instead of types, classes, modules, or tables
- Wiki links point at missing pages
- citations, invented paths, thin stubs, or topology mistakes

Prefer `pass` when pages are grounded enough to install. Publish needs this
handoff, and Candidate writes after a pass make the review stale.
