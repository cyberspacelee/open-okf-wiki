---
name: repository-wiki-producer
description: Use when the user asks to build or replace a repository Wiki. Invoke the /wiki command and let the extension own production.
---

# Repository Wiki Producer

Invoke `/wiki` inside Pi (`pi -p "/wiki …"`). It is not `pi wiki` or
`pi extensions/wiki`. Leave `wiki/` unchanged in this session.

## Produce

1. `/wiki [focus]` starts a full generation in an empty Candidate.
   Print/json mode waits until the Run finishes.
2. Use `/wiki status` for the current Run's Board Tasks and agent tools. In the
   TUI this also opens an inspect overlay.

A Git repository without `workspace.yaml` is an implicit single-source Workspace.

## Configure Sources

`/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]` creates an explicit multi-source Workspace. Add sources with `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.

## Control

The Workspace has one current Run. Pause, resume, and cancel operate on it.
Resume continues its Candidate pages, Board, and persisted Lead session.
Compaction re-injects the Board. Success and cancel clear the current Run;
there is no historical Run lookup.

Writing is planned from completed survey handoffs. One writer owns one Domain
subtree and maintains an execution-local page Todo. Completed Domain receipts
survive Lead compaction; interrupted Domains restart from the handoff and the
current Candidate. Repository and Wiki-root aggregation pages are written only
after their child Domains, using directory-only targets that cannot overwrite
subtrees.

## Catalog

Optional openGauss evidence in `workspace.yaml`. Username and password go in
the URL:

```yaml
database:
  url: ${DATABASE_URL}   # postgresql://USER:PASSWORD@HOST:PORT/DB
  schema: public
  tables: [user*, order%]
```

```bash
export DATABASE_URL='postgresql://wiki:secret@127.0.0.1:5432/app'
```

`url` is an openGauss `postgres://` or `postgresql://` connection string (or `${ENV}` / `$ENV`).
URL-encode special characters in the password. `schema` defaults to
`public`. Omit `tables` to allow every table in that schema; otherwise names
are fuzzy-matched (`user` → `users`, `user_account`; `order%` → `orders`).
Agents list then describe matching tables. They do not dump the whole
schema. Connections are read-only. Expand the URL in the environment; do
not commit the expanded string.

A Catalog uses `database` in an explicit `workspace.yaml`. An implicit
single-source Workspace may instead use `.okf-wiki/database.yaml` with the
same database block.

## Templates

`/wiki init` copies the pack for `language` into `wiki-templates/` and
sets `wiki.templates`. Edit those files in the Workspace. Whole-pack
replacement, not a merge:

```yaml
wiki:
  templates: wiki-templates
```

Every Wiki directory kind has exactly one `identity` contract for its generated
index. Identity contracts are required singletons, while other required
singletons may share their placement. One required singleton uses
`altitudes: [wiki, repo]`. Other contracts
set `required: false` plus an evidence condition in `applies_when`; `many`
contracts use one `{slug}` in `filename` to create separate topic pages.
`purpose` defines page ownership. Each body H2 is a semantic obligation whose
body guides survey, writing, and review; the host derives the output skeleton.
A `diagram` mapping names its H2 `section` and allowed Mermaid `kinds`.
Generated pages use `sources` + `[^id]` footnotes. Publish checks contract
selection, placement, exact sections, footnotes, placeholders, links, diagrams,
sources, cited-file reads, and a current review pass.

Consuming agents start at `wiki/index.md`. Explicit Workspace knowledge pages
live at `<scopeId>/<domain>/<concept>/`; Workspace root pages explain
cross-Source composition. Implicit Workspace knowledge pages remain at
`<domain>/<concept>/`. Do not put `AGENTS.md` or `ARCHITECTURE.md` inside
`wiki/`.
