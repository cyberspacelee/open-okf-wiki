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

Then list evidence. Request changes when a slug or title is translation-only
(missing the source identifier), when `flows.md` / `models.md` / `states.md` /
`data.md` has no mermaid fence, or when mermaid node IDs are translated names
instead of types, classes, modules, or tables. Also flag missing citations,
invented paths, thin stubs, and topology mistakes.

Prefer `pass` when pages are grounded enough to install.
