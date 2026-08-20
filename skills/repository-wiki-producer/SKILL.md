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
2. Report the Run id. Use `/wiki status [run-id]` for a text snapshot of
   status, Board Tasks, and agent notes. Without an id, status shows the
   live Run or the latest finished one.

A Git repository without `workspace.yaml` is an implicit single-source Workspace.

## Configure Sources

`/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]` creates an explicit multi-source Workspace. Add sources with `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.

## Control

`/wiki runs`, `/wiki pause`, `/wiki resume [run-id]`, `/wiki cancel [run-id]`.
Resume continues the same Run: Candidate pages, Board (goal and remaining
Tasks), and the persisted Lead session. Compaction re-injects the Board.

## Catalog

Optional Postgres evidence in `workspace.yaml`:

```yaml
database:
  url: ${DATABASE_URL}
  schema: public
  tables: [user*, order%]
```

`url` is a `postgresql://` connection string (or `${ENV}` / `$ENV`). `schema`
defaults to `public`. Omit `tables` to allow every table in that schema;
otherwise names are fuzzy-matched (`user` → `users`, `user_account`;
`order%` → `orders`). Agents list then describe matching tables. They do
not dump the whole schema. Connections are read-only.

A Catalog requires an explicit `workspace.yaml`. Implicit single-source
workspaces have no database block. Put the password in the environment.
