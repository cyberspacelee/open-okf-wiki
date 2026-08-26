# Open OKF Wiki v3

A skill-driven producer for thin, evidence-anchored repository Wikis. Agents
follow skills/repo-wiki/SKILL.md; deterministic Python gates freeze sources,
validate phase artifacts, bind independent review to a candidate digest and
publish OKF v0.2 generations.

## Quick start

Run from a workspace root:

    uv run <skill>/scripts/okf.py workspace init --lang zh
    uv run <skill>/scripts/okf.py source add --kind git --name api <path-or-url>
    uv run <skill>/scripts/okf.py run start --producer repo-wiki/<model> --session <id>
    uv run <skill>/scripts/okf.py run status --json

The status response names the earliest incomplete phase, target specs and
artifact paths. Start and complete each target through the CLI. A formal run
requires clean Git sources and reads immutable snapshots rather than mutable
worktrees.

After a distinct reviewer approves the candidate:

    uv run <skill>/scripts/okf.py publication publish
    uv run <skill>/scripts/okf.py publication export --to wiki
    uv run <skill>/scripts/okf.py validate --published

The authoritative publication is
.okf-wiki/publication/generations/<digest>, selected through current.json.
wiki/ is an explicit recoverable export suitable for Git. This file/pointer
design behaves consistently on Windows, Linux and macOS without symlinks.

## Guarantees

- Grep Test keeps the Wiki a routing layer rather than a source mirror.
- Citations bind to source, Git commit, path and real line range.
- Frontmatter is parsed as bounded YAML with duplicate keys and aliases
  rejected, then validated by Pydantic.
- generated, verified, status and stale_after make lifecycle and trust
  machine-readable.
- Unchanged artifacts and pages are reused only from file hashes, exact page
  plans and freshness dates.
- Root index.md contains only okf_version 0.2; nested indexes and log.md have
  no frontmatter.
- PostgreSQL catalog access is read-only and selected-table only; canonical
  resources contain no credentials.
- Source-facing AGENTS, CONTEXT and ADR changes remain proposals requiring
  human ratification.

## Quality checks

Cross-platform deterministic QA:

    uv run --with pytest --with pydantic --with PyYAML --with "psycopg[binary]" pytest -q skills/repo-wiki/scripts/tests
    uv run skills/repo-wiki/evals/run_cli_e2e.py

The live agent eval and grader are under skills/repo-wiki/evals. They inspect
the current generation, not a legacy mutable wiki directory.

## Layout

    skills/repo-wiki/SKILL.md
    skills/repo-wiki/references/
    skills/repo-wiki/assets/templates/
    skills/repo-wiki/scripts/okf.py
    .okf-wiki/runs/<run-id>/
    .okf-wiki/snapshots/<content-hash>/
    .okf-wiki/publication/generations/<digest>/
    wiki/

No historical v1/v2 state or CLI compatibility is provided.
