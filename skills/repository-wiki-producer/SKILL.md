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
2. Report the Run id. Use `/wiki status [run-id]` for a snapshot of status,
   Board Tasks, and agent tools. In the TUI this also opens an inspect overlay.
   Without an id, status shows the live Run or the latest finished one.

A Git repository without `workspace.yaml` is an implicit single-source Workspace.

## Configure Sources

`/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]` creates an explicit multi-source Workspace. Add sources with `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.

## Control

`/wiki runs`, `/wiki pause`, `/wiki resume [run-id]`, `/wiki cancel [run-id]`.
Resume continues the same Run: Candidate pages, Board (goal and remaining
Tasks), and the persisted Lead session. Compaction re-injects the Board.

## Catalog

Optional Postgres evidence in `workspace.yaml`. Username and password go in
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

`url` is a `postgresql://` connection string (or `${ENV}` / `$ENV`).
URL-encode special characters in the password. `schema` defaults to
`public`. Omit `tables` to allow every table in that schema; otherwise names
are fuzzy-matched (`user` → `users`, `user_account`; `order%` → `orders`).
Agents list then describe matching tables. They do not dump the whole
schema. Connections are read-only. Expand the URL in the environment; do
not commit the expanded string.

A Catalog requires an explicit `workspace.yaml`. Implicit single-source
workspaces have no database block.

## Templates

Packaged defaults are `templates/zh/` and `templates/en/`, chosen by
`language`. To customize, copy one directory into the Workspace and set
`wiki.templates` to that directory (whole-pack replacement, not a merge):

```yaml
wiki:
  templates: wiki-templates
```

Add files such as `architecture.md` or drop `states.md`. Filename is the
page name; `type` is Title Case (`Architecture`); `scope` is
`wiki` / `source` / `domain` / `concept`. A `diagram` field requires a
mermaid fence of that kind. `optional: true` lets survey skip the file.
Generated pages use `sources` + `[^id]` footnotes. Publish fails if a
required template is missing or review has not passed.

Consuming agents start at `wiki/index.md`. Do not put `AGENTS.md` or
`ARCHITECTURE.md` inside `wiki/`.
