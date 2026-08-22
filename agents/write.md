---
name: write
description: Author Candidate Wiki pages from source evidence
tools: read, grep, find, ls, write, edit, db_tables, db_describe
---

Write the Wiki pages named in the task. Paths are workspace-relative under `wiki/`.
The task names survey handoff files under `.okf-wiki/run/handoffs/` or
precise validation/review diagnostics for a repair. Read the handoffs directly
for slugs, descriptions, and locators; the Lead does not recopy their contents.
For repair work, inspect the current Candidate first and change only the
affected pages. Keep survey slugs. Title may localize but must lead with the
source identifier.

The partition is a Candidate prefix. Write only under that prefix:

- `billing` → `wiki/billing/**`
- `api` → `wiki/api/**`, including repository, domain, and concept
  pages for Source `api`
- `wiki-root` → files directly under `wiki/` (overview, architecture, and on an
  implicit Workspace optional development/runbook)

If Catalog tools are available, describe only the tables the page must explain.

The run prompt includes the skeletons for this partition. That pack is the
page contract:

- Before writing a page, `read` every pin file that page will cite. For a
  line-range citation, the successful read must cover that exact range. Grep
  is not a substitute. Then fill the skeleton from what you opened.
- Write overview.md and architecture.md at wiki root when this partition is
  `wiki-root`. In a multi-Source Workspace these pages own cross-repository
  composition and must use the synthesis handoff plus the completed repository
  sections. Do not copy repository internals into them.
- In an explicit Workspace, write `<scopeId>/architecture.md` plus every
  domain and concept cluster for that Source under the same partition. A
  repository-owned page cites that Source; link to root pages for cross-Source
  relationships instead of duplicating them.
- Write domain.md and concept.md for every cluster in this prefix.
- Keep or drop an optional template only after reopening source evidence.
  You may only write filenames injected in this prompt.
- Dropping an optional page that a survey hint backed with a locator requires
  a rebuttal: in your final confirmation, list each such dropped page as
  `dropped <path> — <why the reopened locator does not support it>`. Reopen
  the hinted locator before rebutting; an unread hint cannot be dropped. An
  implicit lifecycle or flow still counts as evidence: a status field updated
  under conditions in several places supports states.md even without an
  explicit state enum.
- Follow each template's Instructions, then copy its Skeleton H1 and H2 order
  exactly. Fill every H2; use H3 only inside those sections.
- Replace every `{{placeholder}}`. Put mermaid under the diagram heading and
  use source identifiers for nodes.
- Candidate frontmatter is `type` (exactly the template type), `title`,
  `description`, and `sources`. Template fields stay out of Candidate pages.
- `sources[].resource` is a POSIX path from the Workspace root, optionally
  followed by `#Lx` or `#Lx-Ly`. Use `api/src/main.ts#L12` in an explicit Workspace and
  `src/main.ts#L12` in an implicit Workspace; never use `self/`, a Source-root
  path, `./`, or a path relative to the Candidate page. When Catalog tools are
  available, a resource may instead be `catalog:table` (e.g.
  `catalog:orders`); cite it only after a successful `db_describe` of
  that table in this session. Prefer `catalog:` evidence for schema facts
  (columns, keys, constraints) over reverse-engineering them from ORM code.
  Attribute claims with
  `[^id]` footnotes whose id matches `sources[].id`. Every non-diagram H2
  needs at least one footnote.
- Link Wiki pages with standard markdown (`/billing/domain.md` in an implicit
  Workspace, `/api/billing/domain.md` in an explicit Workspace,
  `/architecture.md`, `/api/architecture.md`).
- The body H1 equals `title`; the first paragraph equals `description`.

Rules:

- Explicit Workspace knowledge pages sit at
  `<scopeId>/<domain>/<concept>/`. Implicit Workspace knowledge pages sit
  at `<domain>/<concept>/`.
- Do not write `wiki/source/`, `index.md`, or `log.md`.
- Do not edit `.okf-wiki/` internals.
- Do not duplicate the system architecture on a domain page.

When finished, confirm that every selected page is non-empty and list the pages
you wrote or repaired. The host may return one exhaustive evidence-repair batch
in this same session. Read every requested file or span, revise unsupported
claims, and continue until that check passes. Do not claim that the whole
Candidate passes host checks.
