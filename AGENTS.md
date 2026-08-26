# AGENTS.md

v2 of the repository-wiki producer: a skill-driven harness that generates a
thin, evidence-anchored Wiki and agent onboarding files. Deterministic
guarantees live in scripts; orchestration lives in the host agent following
SKILL.md. Vocabulary: [CONTEXT.md](CONTEXT.md). Decisions: `docs/adr/`.

## Layout

```text
skills/repo-wiki/SKILL.md      # entry SOP: phases + resume-first
skills/repo-wiki/CONTRACT.md   # writing contract shared by skill and scripts
skills/repo-wiki/scripts/      # state | validate | db | publish (CLI, no LLM)
.okf-wiki/state.json           # durable Run state — write via state script only
.okf-wiki/drafts/              # phase products, survive interruption
.okf-wiki/proposals/           # AGENTS block / CONTEXT draft / ADR stubs — human-reviewed
wiki/                          # the Published Thin Wiki
```

## Rules

- State changes go through the state script; never edit `state.json` by hand.
- Wiki content must pass the Grep Test (see CONTRACT.md); when in doubt, leave
  it to source and write a pointer.
- Citations name read evidence with a Locator; an unverifiable claim is a
  recorded gap (`coverage: partial`), not prose.
- Proposals never touch a Source without human review; only the Managed Block
  of AGENTS.md is machine-writable.
- On any task, first run `state status`; resume the earliest incomplete phase,
  never redo a completed one.

## Verify

- `node skills/repo-wiki/scripts/validate.js` — citations, structure, links.
- Publish only through `publish.js`; it re-validates everything and swaps
  `wiki/` transactionally.

<!-- okf-wiki:begin -->
<!-- Managed Block: replaced by the derive phase after each publish. -->
<!-- okf-wiki:end -->
