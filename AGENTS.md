# AGENTS.md

v2 of the repository-wiki producer: a skill-driven harness that generates a
thin, evidence-anchored Wiki and agent onboarding files. Deterministic
guarantees live in scripts; orchestration lives in the host agent following
SKILL.md. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions: `docs/adr/`.

## Layout

```text
skills/repo-wiki/SKILL.md              # entry SOP: re-anchor + phase dispatch
skills/repo-wiki/references/           # contract + per-phase instructions, loaded on entry
skills/repo-wiki/scripts/okf.py        # init|state|validate|db|publish (uv run, no LLM)
skills/repo-wiki/assets/templates/     # page skeletons copied into output
.okf-wiki/state.json                   # durable Run state — write via okf.py state only
.okf-wiki/drafts/                      # phase products, survive interruption
.okf-wiki/proposals/                   # AGENTS block / CONTEXT draft / ADR stubs — human-reviewed
wiki/                                  # the Published Thin Wiki
```

## Rules

- State changes go through the state script; never edit `state.json` by hand.
- Wiki content must pass the Grep Test (see
  `skills/repo-wiki/references/contract.md`); when in doubt, leave it to
  source and write a pointer.
- Citations name read evidence with a Locator; an unverifiable claim is a
  recorded gap (`coverage: partial`), not prose.
- Proposals never touch a Source without human review; only the Managed Block
  of AGENTS.md is machine-writable.
- On any task, first run `state status`; resume the earliest incomplete phase,
  never redo a completed one.
- Phase order is inspect → survey → (synthesize, multi-source) → write →
  derive → review → publish; synthesize waits for every survey.

## Verify

- `uv run skills/repo-wiki/scripts/okf.py validate` — citations, structure,
  links (exit code is the verdict; `--json` for the issue list).
- Publish only through `okf.py publish`; it re-validates everything and swaps
  `wiki/` transactionally.

<!-- okf-wiki:begin -->
<!-- Managed Block: replaced by the derive phase after each publish. -->
<!-- okf-wiki:end -->
