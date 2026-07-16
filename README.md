# OKF Wiki

OKF Wiki turns a pinned Repository Snapshot Set into a source-grounded Markdown Wiki. A single
PydanticAI Agent follows an exact Skill Version, writes pages into an isolated Staging Wiki, and
returns either a typed Complete result or bounded Needs Input questions. Python keeps every source
and the Skill read-only, validates the finished Markdown mechanically, and publishes the whole Wiki
atomically.

The product vocabulary is defined in [CONTEXT.md](CONTEXT.md), and the execution boundaries are
recorded in the [architecture decisions](docs/adr/).

## Install

Development and source installs require Python 3.14, Git, and
[uv](https://docs.astral.sh/uv/):

```bash
uv sync --locked
uv run --locked okf-wiki --help
```

The installed command exposes these operations:

| Command | Purpose |
|---|---|
| `init` | Write a starter `wiki-run.yaml` to edit and run later |
| `wiki-run` | Generate or refresh a Wiki |
| `wiki-retry` | Manual Retry Run from a failed or cancelled Wiki Run Record |
| `tui` | Line-oriented interactive run operator (TTY) |
| `viz` | Static HTML Wiki Visualization from a Published Wiki |
| `wiki-eval` | Deterministic or live producer evaluation |
| `skill-fork` | Editable copy of a Skill Version |
| `skill-inspect` | Validate a Skill directory and report its content digest |

This release is CLI-only: it has no product web app or Console process. Optional Wiki Visualization
is static HTML under `viz/` (open with a browser or `file://`); it is not a run dashboard.

The current publication implementation targets Linux because stable directory handles use
`/proc/self/fd`.

## Quick start

```bash
# 1) Provider credentials (untracked)
cp .env.example .env
# Edit .env — e.g. OPENAI_API_KEY=...

# 2) Starter YAML for this working directory + one local repository
uv run --locked okf-wiki init \
  --source /absolute/path/to/repository \
  --source-id application

# 3) Edit wiki-run.yaml: model, staging/publication paths, extra ignore patterns, multi-repo
# 4) Generate
uv run --locked okf-wiki wiki-run --config ./wiki-run.yaml

# 5) Optional: browse the Published Wiki as static HTML + link graph
uv run --locked okf-wiki viz ./.okf-wiki/wiki
```

`init` never runs the model. It only writes configuration. Re-run with `--force` to replace an
existing file.

## Provider environment

Copy [.env.example](.env.example) to an untracked `.env` and uncomment only the provider you use:

```bash
cp .env.example .env
# Edit .env, then run the CLI normally.
```

OpenAI uses `OPENAI_API_KEY`; optional OpenAI-compatible endpoint and project selection use
`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID`. The example also lists Anthropic,
Google, Azure OpenAI, and OpenRouter variables supported by the installed PydanticAI providers. For
`wiki-run --config`, the CLI loads `.env` beside the YAML file when present; otherwise it loads
`.env` from the current directory. Existing process environment variables always win, and
`PYTHON_DOTENV_DISABLED=1` disables local loading. Deployments should still inject environment
variables through their runtime or secret manager. OpenAI likewise recommends keeping API keys out
of code and public repositories and exposing them through environment variables or a secret manager
in its [production guidance](https://developers.openai.com/api/docs/guides/production-best-practices#api-keys).

Provider credentials, tokens, and headers are rejected from Wiki Run YAML and are never copied into
prompts, traces, staging, or publication metadata.

## Initialize and configure a Wiki Run

### `okf-wiki init`

```bash
# Default: ./wiki-run.yaml with placeholder repository paths
uv run --locked okf-wiki init

# Prefill one local repository (path relative to the YAML when possible)
uv run --locked okf-wiki init \
  --config ./wiki-run.yaml \
  --source /absolute/path/to/repository \
  --source-id application \
  --model openai:gpt-5-mini

# Pin a branch or exact revision for the prefilled source
uv run --locked okf-wiki init --source ./repo --branch main
uv run --locked okf-wiki init --source ./repo --revision "$(git -C ./repo rev-parse HEAD)"

# Replace an existing file
uv run --locked okf-wiki init --force
```

Success prints JSON with the written path and short next steps. After init:

1. Edit `repositories` (paths, `branch` or `revision`, optional `ignore`).
2. Confirm `staging` and `publication` paths (defaults under `.okf-wiki/`).
3. Set `model` and optional `limits` / `write_visualization`.
4. Put provider credentials in `.env` or the process environment.
5. Run `okf-wiki wiki-run --config ./wiki-run.yaml` (or `okf-wiki tui --config ./wiki-run.yaml`).

### YAML contents

You can also start from [examples/wiki-run.yaml](examples/wiki-run.yaml). YAML contains only
non-secret settings: operation, model string, output paths, optional limits, and one or more named
repositories. Paths are relative to the YAML file. Each repository selects exactly one local
`branch` or exact `revision`; a branch is resolved once to a complete commit before model work, and
that commit is recorded in `.okf-wiki.json`. Repository IDs must be unique lowercase hyphen-case
names.

```yaml
repositories:
  - id: application
    path: ../path/to/application
    branch: main
    apply_default_source_ignores: true   # default when omitted
    ignore: []                           # additive extra fnmatch patterns
```

**Default Source Ignores** are Host-owned noise patterns (`node_modules`, `dist`, `.venv`, caches,
and similar). They apply when `apply_default_source_ignores` is true (the default). User `ignore`
entries are always additive; writing a custom ignore never turns defaults off. Set
`apply_default_source_ignores: false` when you need full control and list every exclusion yourself.
There is no gitignore import and no `!` re-include syntax. Tests are kept in the Snapshot by
default. The expanded **Effective Source Ignores** are frozen into the Wiki Run Record and
publication metadata so Manual Retry reproduces the same membership.

The first version reads existing clean local checkouts; it does not clone, fetch, or pull.

## Generate a Wiki

### With YAML (recommended after `init`)

```bash
uv run --locked okf-wiki wiki-run --config ./wiki-run.yaml
```

Optional flags include `--write-visualization` / `--no-write-visualization` when not set in YAML.

### Direct CLI (single repository)

The source must be a clean Git working tree, and `--source-revision` must be its complete commit ID.
The Staging Wiki must be empty and must not overlap the source, Producer Skill, or publication path.

```bash
SOURCE=/absolute/path/to/repository
REVISION=$(git -C "$SOURCE" rev-parse HEAD)

OPENAI_API_KEY=... uv run --locked okf-wiki wiki-run "$SOURCE" \
  --source-revision "$REVISION" \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

With the bundled Producer Skill, no Skill flags are needed. Success is one JSON object with a
Complete result, the Wiki Manifest, and a mechanical change summary:

```json
{
  "ok": true,
  "result": {
    "status": "complete",
    "manifest": {"pages": ["index.md"]},
    "summary": {
      "added": ["index.md"],
      "changed": [],
      "removed": [],
      "unchanged": [],
      "content_changed": true,
      "publication_changed": true
    }
  }
}
```

When trustworthy generation genuinely needs external information, the same command returns a
successful structured Needs Input result instead of publishing:

```json
{"ok": true, "result": {"status": "needs_input", "questions": ["Which audience?"]}}
```

Operational failures return `ok: false`, an exception type, and a secret-safe message. A failed or
incomplete run does not update the Published Wiki.

## Refresh a Published Wiki

Refresh uses the same application seam. It copies the current Published Wiki into a new empty
Staging Wiki, then asks the Agent to reconsider the complete Wiki against the newer Repository
Snapshot Set:

```bash
NEW_REVISION=$(git -C "$SOURCE" rev-parse HEAD)

OPENAI_API_KEY=... uv run --locked okf-wiki wiki-run "$SOURCE" \
  --refresh \
  --source-revision "$NEW_REVISION" \
  --staging /absolute/path/to/new-empty-refresh-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

Refresh requires a producer-managed publication created by a successful Generate. The summary
reports added, changed, removed, and unchanged pages. A content no-op remains a successful Complete
result with `content_changed: false`; `publication_changed` remains true when any repository
revision, Effective Source Ignores, or Skill digest changed, so provenance can still produce a new
release. Publication is unchanged only when both page content and recorded provenance are unchanged.
In YAML mode, set `operation: refresh` and use a fresh empty staging path.

## Interactive TUI

For a line-oriented run operator on a TTY (plan/branch status, receipts, retries—not a web UI):

```bash
uv run --locked okf-wiki tui --config ./wiki-run.yaml
```

Non-TTY use is rejected; automation should keep using `wiki-run` JSON.

## Wiki Visualization

Generate a deterministic static HTML view (page browser + link graph) from an existing Published
Wiki. This does not call the model and does not modify wiki Markdown pages.

```bash
uv run --locked okf-wiki viz /absolute/path/to/published-wiki
# artifacts default to <publication>/viz/index.html and graph.json
```

Or set `write_visualization: true` in YAML / pass `--write-visualization` on `wiki-run`. Failure to
write visualization never unpublishes a successful Wiki.

## Manual Retry

After automatic provider retries are exhausted, create a new run from a secret-free Wiki Run Record
(frozen revisions, Effective Source Ignores, Skill digest, limits):

```bash
uv run --locked okf-wiki wiki-retry /path/to/run-record.json \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki
```

## Producer Skills and Wiki Templates

Every Wiki Run freezes one exact Producer Skill digest. The bundled Skill contains the semantic
workflow, focused Generate, Refresh, and review guidance, plus adaptable overview, architecture,
module, flow, and concept Wiki Templates. Templates guide useful page shapes; they do not impose a
fixed taxonomy or page count. Host policy (Default Source Ignores, mounts, budgets) is not part of
the Skill.

Create an editable Skill Fork:

```bash
uv run --locked okf-wiki skill-fork ./my-producer-skill
```

After editing its Markdown guidance or Templates, validate it and capture the new digest:

```bash
uv run --locked okf-wiki skill-inspect ./my-producer-skill
```

Select that exact revision for a run:

```bash
uv run --locked okf-wiki wiki-run "$SOURCE" \
  --source-revision "$REVISION" \
  --skill ./my-producer-skill \
  --skill-digest SKILL_DIGEST \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

A selected Skill directory whose contents no longer match its digest is rejected before model
execution.

## Source Citations, validation, and publication

Each page must begin with YAML frontmatter containing a non-empty `title`. Source Citations use a
repository-relative POSIX path and a one-based inclusive line range:

```markdown
[Source](repo:src/example.py#L10-L20)
```

When a Wiki Run has multiple repositories, prefix every citation path with its repository ID:

```markdown
[Source](repo:application/src/example.py#L10-L20)
```

Before publication, Python checks mechanically decidable invariants:

- only canonical UTF-8 Markdown pages are present, including a non-empty `index.md`;
- the returned Wiki Manifest exactly matches the staged page tree;
- YAML frontmatter is valid and raw HTML is absent;
- relative internal links and heading fragments resolve inside the Wiki;
- every page has at least one Source Citation whose repository ID, path, and line range resolve in
  the pinned Repository Snapshot Set;
- paths, symlinks, temporary artifacts, entry counts, and configured byte limits stay contained.

Citation validation proves that referenced source spans exist. It does not prove semantic
entailment or exhaustive repository coverage; the Producer Skill's review pass and evaluation are
responsible for improving reader usefulness and factual grounding.

After validation, the publisher writes an immutable release containing the Markdown pages and
`.okf-wiki.json`, then atomically moves the publication pointer to that complete release. Metadata
records every repository ID, exact revision, Effective Source Ignores, Skill digest, model identity,
page hashes, generation time, and whole Wiki content digest. Readers observe either the previous
complete Wiki or the new complete Wiki. A reserved top-level `viz/` directory holds optional
visualization artifacts and is not treated as wiki pages.

## Security and limits

Every Repository Snapshot is materialized from an exact clean commit and treated as untrusted data.
Repository-provided instructions, Skills, plugins, and prompt-like files are available only as
source evidence; they do not alter product policy. Source and Producer Skill mounts are read-only,
only the Staging Wiki is writable, and repository builds, tests, package managers, scripts, plugins,
arbitrary host shell execution, and repository-triggered network tools are not available.

Model content is sent only through the provider selected by the PydanticAI model string. Configure
that provider's credentials through its supported process environment; credentials are not copied
into the Repository Snapshot Set, Producer Skill, Staging Wiki, or publication metadata.

`wiki-run` exposes request, token, tool-call, retry, request-timeout, tool-timeout, wall-clock,
source-size, Wiki-size, and staging-write limits. Exhausted limits are explicit failures and leave
the previous publication unchanged.

## Deterministic and live evaluation

The default evaluation uses committed deterministic fixtures and requires no live model:

```bash
uv run --locked okf-wiki wiki-eval /absolute/path/to/new-evaluation-output
```

Live evaluation requires an explicit model and repository manifest whose cases point to clean local
repositories and exact revisions. The repository includes an
[example manifest](src/okf_wiki/wiki_evaluation_repositories.json):

```bash
OPENAI_API_KEY=... uv run --locked okf-wiki wiki-eval \
  /absolute/path/to/new-live-evaluation-output \
  --model openai:gpt-5-mini \
  --manifest /absolute/path/to/repositories.json
```

Automated evaluation measures mechanical and lexical signals, cost, latency, and material
stability. Completed live Wikis still require the semantic review records accepted by `--review`
before the report can recommend retaining the current design or opening a capability ticket. The
evaluation command does not turn those signals into a claim of semantic proof.

The retained greenfield API investigation is available in
[docs/research/pydanticai-greenfield-repo-to-wiki.md](docs/research/pydanticai-greenfield-repo-to-wiki.md).

## Development checks

```bash
uv lock --check
uv sync --locked
uv run --locked pytest -m "not package_release"
uv run --locked pytest -m package_release tests/test_package_release.py
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked ty check src tests
git diff --check
```

### Git hooks (prek)

This repo uses [prek](https://prek.j178.dev/) (fast pre-commit-compatible hook runner) with
[`.pre-commit-config.yaml`](.pre-commit-config.yaml):

| Stage | Hooks |
|---|---|
| **pre-commit** | trailing whitespace / YAML-TOML sanity, **ruff check --fix**, **ruff format**, **ty check** |
| **pre-push** | **pytest** with `-m "not package_release"` |
| **CI / manual** | full suite including `package_release` |

**Why tests are not on pre-commit:** unit tests already take seconds to tens of seconds and grow with
the suite; putting them on every commit slows small docs/config commits without catching more than
ruff/ty for pure style mistakes. **pre-push** still blocks a broken unit suite before remote share.
`package_release` builds wheels and is intentionally **not** a local hook (CI only).

One-time setup after clone:

```bash
uv sync --locked
uv run --locked prek install -t pre-commit -t pre-push
# optional: warm hook envs
uv run --locked prek prepare-hooks
```

Useful commands:

```bash
uv run --locked prek run -a              # all pre-commit hooks on the whole tree
uv run --locked prek run ty-check -a
uv run --locked prek run pytest-unit -a  # same as pre-push tests, without pushing
uv run --locked prek uninstall           # remove hooks
```

Skip once when needed: `PREK_ALLOW_NO_CONFIG=0 git commit --no-verify` (use sparingly).

The normal pytest run includes the tracked product-documentation local-link gate.
