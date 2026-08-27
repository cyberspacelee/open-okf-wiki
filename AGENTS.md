# AGENTS.md

This repository develops the **repo-wiki skill**: a skill-driven harness that
generates a thin, evidence-anchored Wiki and agent onboarding files for other
codebases. Deterministic guarantees live in `scripts/`; orchestration lives in
the host agent following `SKILL.md`. Vocabulary: [CONTEXT.md](CONTEXT.md).
Decisions: `docs/adr/`. To *run* the generator, read
`skills/repo-wiki/SKILL.md` — not this file.

## Layout

```text
skills/repo-wiki/SKILL.md              # the skill's SOP (runtime, not dev docs)
skills/repo-wiki/references/           # writing contract + per-phase worker instructions
skills/repo-wiki/scripts/okf.py        # CLI entry; _state/_validate/_publish/_workspace/_db
skills/repo-wiki/scripts/tests/        # pytest suite for the deterministic kernel
skills/repo-wiki/assets/templates/     # page skeletons copied into output
skills/repo-wiki/evals/                # tier-1 deterministic e2e + tier-2 live-eval driver
```

## Development rules

- Contract changes (artifact JSON shapes, locator format, frontmatter fields)
  touch four places together: `_models.py`/`_validate.py`, the phase
  reference in `references/`, the tests, and `evals/run_cli_e2e.py` +
  `evals/grade_run.py`. Never change one without the others.
- Locators are plain `path#Lx-Ly` (line range optional; `source/` prefix in
  multi-source workspaces). No URI schemes — revision binding lives in run
  state, not in the locator text.
- Keep coordinator context small by design: dispatch packets and handoffs are
  paths and counts, long-form content stays on disk. Weigh any new field
  against that budget.
- Docs discipline: this file and CONTEXT.md describe developing the project;
  skill runtime behavior belongs in SKILL.md and references/.

## Verify

```text
cd skills/repo-wiki/scripts && uv run --with pytest --with "pydantic>=2.12" \
  --with PyYAML --with "psycopg[binary]" -m pytest tests -q
uv run skills/repo-wiki/evals/run_cli_e2e.py     # deterministic lifecycle e2e
```

Both must pass before merging kernel or contract changes.

<!-- okf-wiki:begin -->
<!-- Managed Block: replaced by okf propose after each publish. -->
<!-- okf-wiki:end -->
