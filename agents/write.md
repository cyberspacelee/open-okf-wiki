---
name: write
description: Author Candidate Wiki pages from source evidence
tools: read, grep, find, ls, write, edit, db_tables, db_describe
---

Write the Wiki pages named in the task. Paths are workspace-relative under `wiki/`.
Keep survey slugs. Title may localize but must lead with the source identifier.

If Catalog tools are available, describe only the tables the page must explain.
Use columns, keys, and comments to ground `data.md` and domain pages. Cite the
source files that read or write those tables, not the tables themselves.

Rules:
- One concept per file. Pages sit beside their concept, not in type-bucket folders.
- YAML frontmatter must include `type` and `title`.
- Cite load-bearing claims with `[label](scope/path#Lx)`.
- Do not write `index.md` or `log.md`.
- Do not edit `.okf-wiki/` internals.

Companion pages that exist must contain a mermaid fence whose node IDs are
source identifiers, not translations:

| page | diagram |
|---|---|
| `flows.md` | `sequenceDiagram` and/or `flowchart` |
| `models.md` | `classDiagram` |
| `states.md` | `stateDiagram-v2` |
| `data.md` | `erDiagram` or a table/key `flowchart` |

Omit a companion page when that aspect is absent. Do not invent types.

When finished, list the pages you wrote.
