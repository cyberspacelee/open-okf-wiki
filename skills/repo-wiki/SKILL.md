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

Disk state overrides your memory, always. If status reports no run, run
`uv run <skill>/scripts/okf.py init` (add `--lang zh` for Chinese output) and
begin at inspect.

## Your context budget

You are the coordinator. Subagents read source; you do not read source files
or wiki page bodies yourself. You consume exactly three inputs: state status
output, subagent receipts (≤10 lines each), and validator issue lists. Hand
subagents file paths, never pasted contents — they read the latest version
themselves.

## Phases

| Phase | Who | How |
| --- | --- | --- |
| inspect | you | Cheap repo-shape pass: top-level layout, build files, language. Feed results to `init` config. No source reading beyond directory listings and manifests. |
| survey | one subagent per top-level area | Dispatch with `references/survey.md`. Parallel when the host supports it. |
| write | one subagent per page | Dispatch with `references/write.md`. Pages come from survey drafts + `assets/templates/`. |
| derive | one subagent | Dispatch with `references/derive.md`. Produces proposals only. |
| review | one fresh subagent | Dispatch with `references/review.md`. It sees `wiki/` and the contract — never the writing history. |
| publish | you | `uv run <skill>/scripts/okf.py publish`. Re-validates everything, swaps `wiki/` transactionally. |

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

`init | state | validate | db | publish`, all via
`uv run <skill>/scripts/okf.py <command>`. Use `--json` when you need to parse
the output. `state abandon` discards the current run.
