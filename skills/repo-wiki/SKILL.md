---
name: repo-wiki
description: Generate and maintain a thin, evidence-anchored repository Wiki plus AGENTS.md / CONTEXT.md proposals, with durable resumable state. Use whenever the user asks to generate or update a repo wiki, codebase documentation, an architecture map, onboarding docs, an AGENTS.md, a CONTEXT.md glossary draft, or to resume, continue, or check a previous wiki run — even if they never say the word "wiki".
---

# Repo Wiki

Produce a thin Wiki under `wiki/` that routes agents to knowledge expensive to
rebuild by search, plus human-reviewed proposals (AGENTS.md managed block,
CONTEXT.md draft, ADR stubs) under `.okf-wiki/proposals/`. Deterministic
guarantees live in `scripts/okf.py`; you orchestrate and never bypass it.

Requires `uv` on PATH (`command -v uv`; if missing, point the user to
https://docs.astral.sh/uv/ and stop). Run every command from the workspace
root. `<skill>` below means this skill's directory.

## Re-anchor first

Whenever you are unsure of progress — session start, after context compaction,
resuming, or several turns since your last state call — do this before
anything else:

1. `uv run <skill>/scripts/okf.py state status --json`
2. Read `<skill>/references/<current-phase>.md`
3. Continue from the earliest incomplete target. A `complete` target is never
   redone.

Disk state overrides your memory, always. If status reports no workspace, run
`uv run <skill>/scripts/okf.py init` (add `--lang zh` for Chinese output) from
the workspace root, register sources if needed, then `okf.py state init` to
open the run and begin at inspect.

## Workspace and sources

A workspace owns one Wiki and one or more sources. Running inside a single
Git repository with no workspace config is an implicit workspace: that repo is
the only source, named `self`, and citations carry no prefix. For multiple
repositories, register each one:

```
uv run <skill>/scripts/okf.py source add /abs/path/to/repo --name api
uv run <skill>/scripts/okf.py source add https://host/web.git --name web
```

Local paths are linked; URLs are cloned under `.okf-wiki/sources/`. In a
multi-source workspace every citation and draft locator starts with the
source name (`api/src/main.ts#L12`). Domain slugs are source-local — never
merge same-named domains across sources.

## Your context budget

You are the coordinator. Subagents read source; you do not read source files
or wiki page bodies yourself. You consume exactly three inputs: state status
output, subagent receipts (≤10 lines each), and validator issue lists. Hand
subagents file paths, never pasted contents — they read the latest version
themselves.

## Phases

| Phase | Who | How |
| --- | --- | --- |
| inspect | you | Follow `references/inspect.md`: shape pass per source, then decide survey partitioning. |
| survey | one subagent per source (large sources: per top-level area) | Dispatch with `references/survey.md`. Parallel when the host supports it. |
| synthesize | one subagent, multi-source only | Dispatch with `references/synthesize.md` after every survey completes — it depends on all of them; never run it alongside surveys. Skipped in a single-source workspace. |
| write | one subagent per page | Dispatch with `references/write.md`. Source-owned pages come from that source's survey draft; cross-source root pages additionally read the synthesis draft. Write source sections before workspace-root pages. |
| derive | one subagent | Dispatch with `references/derive.md`. Produces proposals only — one AGENTS block per source in a multi-source workspace. |
| review | one fresh subagent | Dispatch with `references/review.md`. It sees `wiki/` and the contract — never the writing history. Its report goes to `.okf-wiki/drafts/review/<target>.md`. |
| publish | you | Follow `references/publish.md`: start target, run `okf.py publish`, complete target. |

Every subagent task must be self-contained: paths to read, instruction file to
follow, output path to write. It must make sense with zero conversation
history, so any session can re-dispatch it.

A subagent reporting "complete" is a claim, not a fact. On receipt, run
`uv run <skill>/scripts/okf.py state complete <phase> --target <t>` — it
validates first and refuses to advance on failure. Relay refusal issues back
to the same target as a repair task.

## Without subagents

Work serially: one target at a time, `state complete` after each. At phase
boundaries, tell the user this is a safe point to clear context or start a
fresh session — everything needed to continue lives on disk.

## Commands

`init | source | state | validate | db | publish`, all via
`uv run <skill>/scripts/okf.py <command>`. `state` actions take named flags,
not positional phase/target:

```
uv run <skill>/scripts/okf.py state start --phase survey --target api
uv run <skill>/scripts/okf.py state complete --phase write --target overview.md
uv run <skill>/scripts/okf.py state status --json
```

Use `--json` when you need to parse the output. `state abandon` discards the
current run.
