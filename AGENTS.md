# AGENTS.md

This repository develops the **repo-wiki skill**: it builds and incrementally
updates a pull-based repository knowledge layer (an OKF wiki) that coding
agents read before changing other codebases. Deterministic guarantees live in
`scripts/`; orchestration lives in the host agent following `SKILL.md`. Vocabulary: [CONTEXT.md](CONTEXT.md).
Decisions: `docs/adr/`. To *run* the generator, read
`skills/repo-wiki/SKILL.md` — not this file.

## Layout

```text
skills/repo-wiki/SKILL.md              # the skill's SOP (runtime, not dev docs)
skills/repo-wiki/references/           # discovery, pages, review, extensions (hub, OpenGauss)
skills/repo-wiki/scripts/okf.py        # CLI; _scan/_page/_validate/_review/_stamp/_impact/_status, _db/_dbpages
skills/repo-wiki/scripts/tests/        # pytest suite for the deterministic kernel
skills/repo-wiki/assets/templates/     # page stubs (en, zh) used by okf init and okf new
skills/repo-wiki/evals/                # tier-1 deterministic lifecycle e2e, fixtures
docs/design/                           # product design and the kernel contract
```

## Development rules

- A contract change is complete only when the kernel module, the kernel
  contract (`docs/design/repository-knowledge-layer-kernel.md`), the matching
  reference, the templates, tests and `evals/run_cli_e2e.py` agree. Scanning,
  validation, review binding, stamping and impact remain deterministic kernel
  work.
- There is no compatibility or migration layer. Old Run state, Plan and
  Composition artifacts are not read; do not add dual schemas or legacy
  branches.
- Locators are plain `path#Lx-Ly` (line range optional; `source/` prefix in a
  hub). No URI schemes — revision binding lives in the page's `revision`
  frontmatter, not in the locator text.
- Work state lives in the wiki pages (draft status, revision, todo blocks) and
  the reviewer's `_review.json`; do not add runtime directories, caches,
  ledgers or scheduler identity to the kernel. Status exposes the derived
  phase and next actions; handoffs are paths and counts.
- Docs discipline: this file and CONTEXT.md describe developing the project;
  skill runtime behavior belongs in SKILL.md and references/.

## Verify

```text
cd skills/repo-wiki/scripts && uv run --with pytest --with PyYAML \
  --with "psycopg[binary]" -m pytest tests -q
uv run skills/repo-wiki/evals/run_cli_e2e.py     # deterministic lifecycle e2e
```

Both must pass before merging kernel or contract changes. CI
(`.github/workflows/qa.yml`) runs them on Linux, macOS and Windows together
with `eval_update.py --strict`, the `selftest` of `eval_routing.py`,
`eval_citations.py` and `eval_canon.py`, and `uvx ruff check skills/repo-wiki`.
