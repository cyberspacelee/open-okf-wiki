# AGENTS.md

v3 of the repository-wiki producer: a skill-driven harness that generates a
thin, evidence-anchored Wiki and agent onboarding files. Deterministic
guarantees live in scripts; orchestration lives in the host agent following
SKILL.md. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions: `docs/adr/`.

## Layout

```text
skills/repo-wiki/SKILL.md              # entry SOP: re-anchor + phase dispatch
skills/repo-wiki/references/           # contract + per-phase instructions, loaded on entry
skills/repo-wiki/scripts/okf.py        # workspace|source|run|task|review|publication
skills/repo-wiki/assets/templates/     # page skeletons copied into output
.okf-wiki/runs/<id>/state.json         # durable Run state — write via okf.py only
.okf-wiki/snapshots/                   # immutable source evidence
.okf-wiki/publication/generations/     # immutable Published Thin Wikis
wiki/                                  # explicit Git export, not publication authority
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
- On any task, first run `run status`; resume the earliest incomplete phase,
  never redo a completed one.
- Phase order is inspect → survey → (synthesize, multi-source) → plan → write →
  derive → review → publish; synthesize waits for every survey.

## Verify

- `uv run skills/repo-wiki/scripts/okf.py validate --published` — citations, structure,
  links (exit code is the verdict; `--json` for the issue list).
- Publish only through `okf.py publication publish`; it re-validates everything
  and atomically switches the current generation pointer.

<!-- okf-wiki:begin -->
<!-- Managed Block: replaced by the derive phase after each publish. -->
<!-- okf-wiki:end -->
