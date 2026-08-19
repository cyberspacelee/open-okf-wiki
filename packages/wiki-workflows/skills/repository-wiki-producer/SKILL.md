---
name: repository-wiki-producer
description: Use when the user asks to build or replace a repository Wiki. Invoke the /wiki command and let the extension own production.
---

# Repository Wiki Producer

Invoke `/wiki`. The extension generates the Wiki from pinned Git sources. Leave `wiki/` unchanged in this session.

## Produce

1. `/wiki [focus]` starts a full generation in an empty Candidate.
2. Report the Run id. Use `/wiki status [run-id]` for a text snapshot.

A Git repository without `workspace.yaml` is an implicit single-source Workspace.

## Configure Sources

`/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]` creates an explicit multi-source Workspace. Add sources with `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.

## Control

`/wiki runs`, `/wiki pause`, `/wiki resume [run-id]` (does not restore Pi sessions; run `/wiki` again), `/wiki cancel [run-id]`.
