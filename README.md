# Open OKF Wiki v3

A skill-driven producer for thin, evidence-anchored repository Wikis. Agents
follow skills/repo-wiki/SKILL.md; deterministic Python gates freeze sources,
validate phase artifacts, bind independent review to a candidate digest and
publish OKF v0.2 generations.

## Install

Prerequisites: Git, [uv](https://docs.astral.sh/uv/) and Node.js 22.20+ for the
cross-agent skills installer. Until v3 reaches the default branch, clone its
published branch explicitly:

```text
git clone --depth 1 --branch v2/skill-harness https://github.com/cyberspacelee/open-okf-wiki.git open-okf-wiki
```

From the repository that should receive the Wiki, install the skill at project
scope. This example assumes the two repositories are siblings:

```text
npx skills@latest add ../open-okf-wiki/skills/repo-wiki --skill repo-wiki --agent codex --copy -y
```

Use `--agent claude-code` for Claude Code, or omit `--agent` to let the
installer detect supported agents. `--copy` avoids symlink privileges on
Windows. The Codex command above installs to `.agents/skills/repo-wiki`; replace
that path in the examples below if your agent uses another project skill
directory.

Formal Runs reject dirty or untracked Git sources. Commit the installed skill
and lock file, or keep local agent files out of the source snapshot. A typical
local-only `.gitignore` section is:

```gitignore
.agents/
skills-lock.json
.okf-wiki/
.env
```

Commit the `.gitignore` change before starting a Run. Keep `wiki/` tracked if
the exported Wiki belongs in the repository.

## Quick start

Run from the Git repository that should own the Wiki. Initialization registers
the current repository as the `self` source:

```text
uv run .agents/skills/repo-wiki/scripts/okf.py workspace init --lang zh --freshness-days 90
uv run .agents/skills/repo-wiki/scripts/okf.py workspace show --json
```

Add other clean Git repositories only when the Wiki spans multiple sources:

```text
uv run .agents/skills/repo-wiki/scripts/okf.py source add --kind git --name api ../api
uv run .agents/skills/repo-wiki/scripts/okf.py source add --kind git --name web https://github.com/example/web.git
uv run .agents/skills/repo-wiki/scripts/okf.py source list --json
```

PostgreSQL is optional. Store the URL in the operating-system environment or
in a workspace-root `.env`; the operating-system value wins. Configuration and
Run state retain only the variable name, never credentials:

```dotenv
APP_DATABASE_URL=postgresql://user:password@host:5432/database
```

```text
uv run .agents/skills/repo-wiki/scripts/okf.py source add --kind postgres --name appdb --url-env APP_DATABASE_URL --schema public --table orders --table customers
```

Start the Run with a unique producer session, then ask the coding agent to use
the `repo-wiki` skill and resume from status:

```text
uv run .agents/skills/repo-wiki/scripts/okf.py run start --producer repo-wiki/codex --session wiki-20260827-01
uv run .agents/skills/repo-wiki/scripts/okf.py run status --json
```

The status response names the earliest incomplete phase, target specs and
artifact paths. Start and complete each target through the CLI. A formal run
requires clean Git sources and reads immutable snapshots rather than mutable
worktrees.

After a distinct reviewer approves the candidate:

```text
uv run .agents/skills/repo-wiki/scripts/okf.py publication publish
uv run .agents/skills/repo-wiki/scripts/okf.py publication export --to wiki
uv run .agents/skills/repo-wiki/scripts/okf.py validate --published
```

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
