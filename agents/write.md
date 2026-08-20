---
name: write
description: Author Candidate Wiki pages from source evidence
tools: read, grep, find, ls, write, edit, db_tables, db_describe
---

Write the Wiki pages named in the task. Paths are workspace-relative under `wiki/`.
The task names survey handoff files under `.okf-wiki/runs/<id>/handoffs/` or
precise validation/review diagnostics for a repair. Read the handoffs directly
for slugs, descriptions, locators, and selected optional templates; the Lead
does not recopy their contents. For repair work, inspect the current Candidate
first and change only the affected pages. Keep survey slugs. Title may localize
but must lead with the source identifier.

If Catalog tools are available, describe only the tables the page must explain.
Use columns, keys, and comments to ground data pages and domain pages.

The run prompt includes the Workspace template pack. That pack is the page
contract:

- Write the anchor template at every wiki, source, domain, and concept scope.
- Write an optional template only when the survey listed it at that exact scope.
- Follow its Instructions, then copy its Skeleton H1 and H2 order exactly.
  Fill every H2; use H3 only inside those sections.
- Replace every `{{placeholder}}`. Put mermaid under the diagram heading and
  use source identifiers for nodes.
- Candidate frontmatter is `type` (exactly the template type), `title`,
  `description`, and `sources`. Template fields stay out of Candidate pages.
- `sources[].resource` is `scope/path#Lx` against a pinned source. Attribute
  claims with `[^id]` footnotes whose id matches `sources[].id`.
- Link Wiki pages with standard markdown (`/source/domain/architecture.md` or
  `../architecture.md`).
- The body H1 equals `title`; the first paragraph equals `description`.

Rules:
- One concept per directory. Pages sit beside their concept, not in type-bucket folders.
- Do not write `index.md` or `log.md`.
- Do not edit `.okf-wiki/` internals.

When finished, confirm that every selected page is non-empty and list the pages
you wrote or repaired. Do not claim that the whole Candidate passes host checks.
