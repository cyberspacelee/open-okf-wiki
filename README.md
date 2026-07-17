# OKF Wiki

OKF Wiki turns a pinned Repository Snapshot Set into a source-grounded Markdown Wiki. A single
PydanticAI Agent follows an exact Skill Version, writes pages into an isolated Staging Wiki, and
returns either a typed Complete result or bounded Needs Input questions. Python keeps every source
and the Skill read-only, validates the finished Markdown mechanically, and publishes the whole Wiki
atomically.

The product vocabulary is defined in [CONTEXT.md](CONTEXT.md), and the execution boundaries are
recorded in the [architecture decisions](docs/adr/).

## Requirements

| Need | Detail |
|---|---|
| **Python** | 3.14 |
| **Git** | Local clean checkouts (no clone/fetch by the product) |
| **uv** | [docs.astral.sh/uv](https://docs.astral.sh/uv/) for install and `uv run` |
| **Host OS for Wiki Run** | Portable hosts with absolute non-overlapping roots, exclusive create, and same-volume directory rename ([ADR 0017](docs/adr/0017-portable-host-filesystem-and-directory-rename-publication.md)). Linux is CI-proven; Windows is in product scope but **not yet covered by in-repo Windows CI smoke**—report gaps if you hit Host FS issues there. |

Wiki Run staging and publication use a **portable Host filesystem policy**: configured roots
must be absolute and non-overlapping; Host-controlled path components must not be symbolic
links (or detectable reparse points where the Host can detect them); single-file handoffs use
temporary file then replace; publication exposes a complete validated tree as a **real directory**
at the Published Wiki path via same-volume directory rename (not a producer-managed symlink).
Cross-volume publication/releases layouts fail closed at prepare. Concurrent Wiki Runs against
the same Published Wiki path fail closed under an exclusive publication lock. Legacy symlink
publications are not auto-migrated—clear the path and full-Generate again. Default operating
mode is full Generate into empty Staging; failures are re-run as separate Wiki Runs (Manual Retry
or a new generate), not resume. `okf-wiki init` and editing YAML / `.env` work on any platform
where Python runs.

## Install

```bash
uv sync --locked
uv run --locked okf-wiki --help
```

| Command | Purpose |
|---|---|
| `init` | Initialize a project directory and write `wiki-run.yaml` |
| `wiki-run` | Generate or refresh a Wiki |
| `wiki-retry` | Manual Retry Run from a failed or cancelled Wiki Run Record |
| `tui` | Line-oriented interactive run operator (TTY) |
| `viz` | Static HTML Wiki Visualization from a Published Wiki |
| `wiki-eval` | Deterministic or live producer evaluation |
| `skill-fork` | Editable copy of a Skill Version |
| `skill-inspect` | Validate a Skill directory and report its content digest |

This release is CLI-only: no product web app. Optional Wiki Visualization is static HTML under
`viz/` (browser or `file://`); it is not a run dashboard.

## Quick start

```bash
# 1) Credentials (untracked). Prefer next to the YAML or in the project directory.
cp .env.example .env
# Edit .env — at least OPENAI_API_KEY=...
# For OpenAI-compatible gateways also set OPENAI_BASE_URL=https://…/v1

# 2a) Initialize in the current directory
uv run --locked okf-wiki init \
  --source /absolute/path/to/repository \
  --source-id application

# 2b) Or initialize a dedicated project directory (created if missing)
uv run --locked okf-wiki init ./my-wiki-project \
  --source /absolute/path/to/repository \
  --source-id application
cd ./my-wiki-project   # if you used 2b

# 3) Edit wiki-run.yaml (model, repos, ignores) and .env

# 4) Generate — defaults to ./wiki-run.yaml when --config is omitted
uv run --locked okf-wiki wiki-run

# 5) Optional: static HTML + link graph of the Published Wiki
uv run --locked okf-wiki viz ./.okf-wiki/wiki
```

`init` never calls the model. `wiki-run` and `tui` load `./wiki-run.yaml` by default when you omit
`--config` and do not pass direct source flags. Re-init with `--force` to replace an existing YAML.

## Provider environment

Copy [.env.example](.env.example) to an untracked `.env`:

```bash
cp .env.example .env
```

For `wiki-run` / `tui`, the CLI loads `.env` **beside the YAML** when present; otherwise from the
current directory. Process environment always wins. `PYTHON_DOTENV_DISABLED=1` skips local `.env`.

### OpenAI and OpenAI-compatible APIs

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | API key (most gateways; some local servers may omit it) |
| `OPENAI_BASE_URL` | Chat Completions base URL (usually ends with `/v1`) |
| `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` | Optional OpenAI org/project |

Model identity stays `openai:<served-model-name>` even on third-party gateways:

```bash
# Stock OpenAI
OPENAI_API_KEY=sk-...

# Compatible gateway (vLLM, LiteLLM, OpenRouter-style proxy, DeepSeek, local server, …)
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://openrouter.ai/api/v1
# YAML / CLI: model: openai:your-served-model-id
```

### Product defaults (non-secret)

YAML and CLI override these when set:

| Variable | Purpose |
|---|---|
| `OKF_WIKI_MODEL` | Default model identity (`provider:name`) |
| `OKF_WIKI_MAX_TOKENS` | Per-completion max output tokens |
| `OKF_WIKI_TEMPERATURE` | Sampling temperature |
| `OKF_WIKI_CONTEXT_TARGET_TOKENS` | Compaction / operational context target |
| `OKF_WIKI_INPUT_TOKENS_LIMIT` | Run-level cumulative input budget |
| `OKF_WIKI_OUTPUT_TOKENS_LIMIT` | Run-level cumulative output budget |
| `OKF_WIKI_TOTAL_TOKENS_LIMIT` | Run-level cumulative total budget |
| `OKF_WIKI_REQUEST_TIMEOUT_SECONDS` | Provider request timeout |

`.env.example` also lists Anthropic, Google, Azure OpenAI, and OpenRouter variables for other
Pydantic AI provider prefixes.

**Secrets never go in Wiki Run YAML.** Keys, tokens, and headers there are rejected. Credentials are
not copied into prompts, run records, staging, or publication metadata.

Invalid YAML or limits now report **field-level messages** (not a bare “configuration is invalid”).
Provider transport failures that look secret-bearing remain withheld.

## Initialize a project (`okf-wiki init`)

```bash
# Current directory → ./wiki-run.yaml
uv run --locked okf-wiki init

# Target directory (created if missing) → <dir>/wiki-run.yaml
uv run --locked okf-wiki init ./my-wiki-project

# Prefill repository + model
uv run --locked okf-wiki init ./my-wiki-project \
  --source /absolute/path/to/repository \
  --source-id application \
  --model openai:gpt-5-mini

# Pin branch or exact revision for the prefilled source
uv run --locked okf-wiki init --source ./repo --branch main
uv run --locked okf-wiki init --source ./repo --revision "$(git -C ./repo rev-parse HEAD)"

# Custom YAML name under the init directory
uv run --locked okf-wiki init ./my-wiki-project --config run.yaml

# Replace existing YAML
uv run --locked okf-wiki init ./my-wiki-project --force
```

| Argument | Meaning |
|---|---|
| `directory` (positional, optional) | Project root to initialize; default: current directory |
| `--config` | YAML path; relative paths are under the init directory (default: `wiki-run.yaml`) |
| `--source` / `--source-id` / `--branch` / `--revision` | Prefill first repository entry |
| `--model` | Model string written into YAML (else `OKF_WIKI_MODEL` or `openai:gpt-5-mini`) |
| `--force` | Overwrite existing config |

Success JSON includes `config`, `directory`, and short `next` steps. After init:

1. Edit `repositories` (paths, `branch` or `revision`, optional `ignore`).
2. Confirm `staging` / `publication` (defaults under `.okf-wiki/` beside the YAML).
3. Set `model` and optional `limits` / `write_visualization`.
4. Put credentials in `.env` beside the YAML.
5. From the project directory: `okf-wiki wiki-run` or `okf-wiki tui`.

### YAML contents

Start from [examples/wiki-run.yaml](examples/wiki-run.yaml) if useful. YAML holds **non-secret**
settings only. Paths are relative to the YAML file.

```yaml
version: 1
operation: generate   # or refresh

# String form:
model: openai:gpt-5-mini
# Object form (optional sampling / output caps):
# model:
#   identity: openai:qwen2.5-72b-instruct
#   max_tokens: 8192
#   temperature: 0.2
#   timeout: 120

staging: .okf-wiki/staging
publication: .okf-wiki/wiki
write_visualization: false

repositories:
  - id: application
    path: ../path/to/application
    branch: main
    apply_default_source_ignores: true   # default when omitted
    ignore: []                           # additive fnmatch patterns

# Omitted limit keys still take OKF_WIKI_* env defaults, then product defaults
limits:
  context_target_tokens: 100000
  input_tokens_limit: 250000
  output_tokens_limit: 100000
  total_tokens_limit: 350000
  request_timeout_seconds: 120
```

Each repository selects exactly one local `branch` or exact `revision`. Branches freeze to a full
commit before model work. Repository IDs are unique lowercase hyphen-case names.

**Default Source Ignores** (`node_modules`, `dist`, `.venv`, caches, …) apply when
`apply_default_source_ignores` is true. User `ignore` entries are additive only. Set
`apply_default_source_ignores: false` for full manual control. No gitignore import and no `!`
re-includes. Tests stay in the Snapshot by default. **Effective Source Ignores** are frozen into
the Wiki Run Record and publication metadata for Manual Retry.

The product reads existing clean local checkouts; it does not clone, fetch, or pull.

## Generate a Wiki

### YAML mode (recommended)

```bash
# From the project directory (./wiki-run.yaml):
uv run --locked okf-wiki wiki-run

# Explicit path:
uv run --locked okf-wiki wiki-run --config ./wiki-run.yaml
```

Optional: `--write-visualization` / `--no-write-visualization` when not set in YAML.

### Direct CLI (single repository)

Requires source, `--source-revision`, `--staging`, and `--publication` (no default YAML). Source
must be a clean Git tree; staging must be empty and not overlap source, Skill, or publication.

```bash
SOURCE=/absolute/path/to/repository
REVISION=$(git -C "$SOURCE" rev-parse HEAD)

OPENAI_API_KEY=... uv run --locked okf-wiki wiki-run "$SOURCE" \
  --source-revision "$REVISION" \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

Success is one JSON object (`Complete` + manifest + change summary). Needs Input returns
`status: needs_input` without publishing. Operational failures return `ok: false` with a type and
secret-safe message; the previous Published Wiki is left unchanged.

## Refresh a Published Wiki

Same application seam: copy the current **real-directory** Published Wiki into a new empty staging
tree (prior pages are non-authoritative context), then re-run the semantic loop against newer
snapshots. Success replaces the complete Published Wiki under the same directory-rename
publication rules as Generate. Refresh is whole-wiki re-evaluation—not mechanical page-level
incremental updates from source diffs.

```bash
# YAML: operation: refresh and a fresh empty staging path, then:
uv run --locked okf-wiki wiki-run --config ./wiki-run.yaml

# Direct:
NEW_REVISION=$(git -C "$SOURCE" rev-parse HEAD)
OPENAI_API_KEY=... uv run --locked okf-wiki wiki-run "$SOURCE" \
  --refresh \
  --source-revision "$NEW_REVISION" \
  --staging /absolute/path/to/new-empty-refresh-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

Refresh needs a Host-owned real-directory publication from a successful Generate (with
`.okf-wiki.json` metadata). If the Published Wiki path is still a legacy producer-managed
**symlink**, the Host refuses and does not migrate it—delete or clear the path and full-Generate
again. Summaries report page adds/changes/removes; provenance can still publish when content is
unchanged but revision/ignores or Skill digest changed.

## Interactive TUI

Line-oriented operator status (plan/branches/receipts)—not a web UI:

```bash
uv run --locked okf-wiki tui                 # ./wiki-run.yaml by default
uv run --locked okf-wiki tui --config ./wiki-run.yaml
```

Non-TTY is rejected; automation should use `wiki-run` JSON.

## Wiki Visualization

Deterministic static HTML (page browser + link graph) from a Published Wiki. No model call; does not
modify Markdown pages.

```bash
uv run --locked okf-wiki viz /absolute/path/to/published-wiki
# default artifacts: <publication>/viz/index.html and graph.json
```

Or `write_visualization: true` / `--write-visualization` on `wiki-run`. Visualization failure never
unpublishes a successful Wiki.

## Manual Retry

After automatic provider retries are exhausted, start a new run from a secret-free Wiki Run Record:

```bash
uv run --locked okf-wiki wiki-retry /path/to/run-record.json \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki
```

## Producer Skills and Wiki Templates

Every run freezes one Producer Skill digest. The bundled Skill holds the semantic workflow,
Generate / Refresh / review guidance, and adaptable overview, architecture, module, flow, and
concept templates. Host policy (ignores, mounts, budgets) is not part of the Skill.

```bash
uv run --locked okf-wiki skill-fork ./my-producer-skill
uv run --locked okf-wiki skill-inspect ./my-producer-skill

uv run --locked okf-wiki wiki-run "$SOURCE" \
  --source-revision "$REVISION" \
  --skill ./my-producer-skill \
  --skill-digest SKILL_DIGEST \
  --staging /absolute/path/to/empty-staging \
  --publication /absolute/path/to/published-wiki \
  --model openai:gpt-5-mini
```

A selected Skill directory whose contents no longer match its digest is rejected before model work.

## Source Citations, validation, and publication

Pages need YAML frontmatter with a non-empty `title`. Citations:

```markdown
[Source](repo:src/example.py#L10-L20)
# multi-repo:
[Source](repo:application/src/example.py#L10-L20)
```

Before publish, the Host checks mechanical invariants (manifest match, links, citations, limits,
no symlinks/temp files, etc.). Citation checks prove spans exist—not semantic entailment.

Publication writes a complete release under a sibling releases directory plus `.okf-wiki.json`, then
exposes it as the Published Wiki via same-volume directory rename (a real directory at the stable
path, not a symlink pointer). Metadata records repository IDs, revisions, Effective Source Ignores, Skill digest, model,
page hashes, and content digest. Reserved top-level `viz/` is not part of the semantic page set.

## Security and limits

Snapshots are exact clean commits treated as untrusted data. Repository agent files and Skills are
evidence only—they do not change product policy. Source and Skill mounts are read-only; only Staging
is writable. No repository builds, package managers, host shell, or repo-triggered network tools.

Limits cover requests, tokens, tools, retries, timeouts, wall-clock, source size, Wiki size, and
staging writes. Exhausted limits fail closed and leave the previous publication unchanged.

## Deterministic and live evaluation

```bash
# Fixtures only (no live model):
uv run --locked okf-wiki wiki-eval /absolute/path/to/new-evaluation-output

# Live (explicit model + local clean repos in a manifest):
OPENAI_API_KEY=... uv run --locked okf-wiki wiki-eval \
  /absolute/path/to/new-live-evaluation-output \
  --model openai:gpt-5-mini \
  --manifest /absolute/path/to/repositories.json
```

Example live manifest: [wiki_evaluation_repositories.json](src/okf_wiki/wiki_evaluation_repositories.json).

Design notes: [docs/research/pydanticai-greenfield-repo-to-wiki.md](docs/research/pydanticai-greenfield-repo-to-wiki.md).

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

[prek](https://prek.j178.dev/) via [`.pre-commit-config.yaml`](.pre-commit-config.yaml):

| Stage | Hooks |
|---|---|
| **pre-commit** | whitespace / YAML-TOML, **ruff check --fix**, **ruff format**, **ty check** |
| **pre-push** | **pytest** `-m "not package_release"` |
| **CI / manual** | full suite including `package_release` |

```bash
uv sync --locked
uv run --locked prek install -t pre-commit -t pre-push
uv run --locked prek prepare-hooks   # optional warm
uv run --locked prek run -a
```

Skip once only when needed: `git commit --no-verify` (use sparingly).

The normal pytest run includes the tracked product-documentation local-link gate.
