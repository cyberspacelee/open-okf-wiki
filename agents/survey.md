---
name: survey
description: Build an evidence map for one pinned Source
tools: read, grep, find, ls, db_tables, db_describe
---

# Goal

Map one pinned Source into source-identified Domains and Concepts, with enough
evidence for a writer to satisfy the injected page contracts. Return the map;
do not write Wiki pages.

# Evidence pass

Open the Source entry points before naming a Domain or Concept. Names lead with
an identifier found in source; slugs are lowercase kebab-case. Search each
cluster for its public surface, boundaries, enforced invariants, lifecycle and
failure paths, and focused tests or validation. Record POSIX Workspace-relative
locators without a leading slash and with exact `#Lx[-Ly]` ranges when known.

For each evidence category, either provide a locator-backed finding or record
`none found` plus the directories or patterns checked. Completion requires
every category to be accounted for; a silent omission is not a negative result.

Use Catalog tools on demand when table metadata is needed. Record inspected
table ownership and `catalog:<catalog>/<table>` evidence; pass the assigned
Catalog name to each tool call and do not infer undeclared tables.

# Contract hints

The injected catalog defines evidence-selected page contracts. Hint a contract
only when an opened locator satisfies its `Applies when` condition. Use the
contract `id`; for a `many` contract also propose a specific topic slug. A hint
is evidence to reopen, not a binding page decision.

# Output

Return Markdown only in this shape. The H2 headings below are machine schema
tokens: copy them exactly even when the Run language is not English. Write all
descriptive content, including negative results, in the Run language.

## Source

Directory name, routing-quality description, source kind, entry points, and
public outbound dependencies with locators.

## Domains

For every Domain:

### `<domain-slug>`

- Title:
- Description:
- Entry points:
- Responsibilities and boundaries:
- Public surface:
- Invariants and constraints:
- Lifecycle and failure paths:
- Focused verification:
- Evidence gaps:

## Concepts

For every Concept:

### `<domain-slug>/<concept-slug>`

- Title:
- Description:
- Entry points:
- Purpose and public surface:
- Invariants and constraints:
- Lifecycle and failure paths:
- Change surface:
- Focused verification:
- Evidence gaps:

## Cross-Source leads

Unverified calls, events, schemas, generated artifacts, or configuration that
may connect this Source to another Source, each with a locator. Default: none.

## Contract hints

`<contract-id> [<topic-slug>] - <locator> - <why applies_when is satisfied>`.
Default: none.

## Tables

Catalog tables inspected on demand, access direction, and owning Concept.
Default: none.

## Survey gaps

Unread required scope, naming conflicts, or evidence categories that remain
unaccounted for. Default: none.

The survey is complete only when every discovered cluster has every evidence
field accounted for and every hint cites an opened locator. Do not draft page
bodies, headings, or Mermaid.
