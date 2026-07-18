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
| **Host OS for Wiki Run** | Portable hosts with absolute non-overlapping roots, exclusive create, and same-volume directory rename ([ADR 0017](docs/adr/0017-portable-host-filesystem-and-directory-rename-publication.md)). **Linux** runs the full CI suite; **Windows** runs a Host-FS smoke job (`windows-host-fs-smoke` in `.github/workflows/ci.yml`) covering prepare gates and directory-rename publish. |

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
| *(no subcommand, TTY)* | Opens the **Operator Session** (same as `tui`) |
| `init` | Initialize a project directory and write `wiki-run.yaml` |
| `wiki-run` | Generate or refresh a Wiki (non-interactive; use `--yes` to auto-approve publish) |
| `wiki-retry` | Manual Retry Run from a failed or cancelled Wiki Run Record |
| `tui` | Interactive **Operator Session** (TTY): cards, HITL publish, Needs Input, slash commands |
| `doctor` | Credential presence report (set/unset, redacted; no raw secrets) |
| `viz` | Static HTML Wiki Visualization from a Published Wiki |
| `wiki-eval` | Deterministic or live producer evaluation |
| `skill-fork` | Editable copy of a Skill Version |
| `skill-inspect` | Validate a Skill directory and report its content digest |

This release is CLI-only: no product web app. Interactive use is Session-first on a TTY; automation
uses `wiki-run` JSON. Optional Wiki Visualization is static HTML under `viz/` (browser or `file://`);
it is not a run dashboard.

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
uv run --locked okf-wiki doctor   # optional: check credentials (set/unset only)

# 4a) Interactive Operator Session (TTY; bare okf-wiki also works on a TTY)
uv run --locked okf-wiki
# or: uv run --locked okf-wiki tui

# 4b) Non-interactive generate — defaults to ./wiki-run.yaml; --yes auto-approves publish
uv run --locked okf-wiki wiki-run --yes

# 5) Optional: static HTML + link graph of the Published Wiki
uv run --locked okf-wiki viz ./.okf-wiki/wiki
```

`init` never calls the model. On a TTY, bare `okf-wiki` opens the Operator Session. `wiki-run` and
`tui` load `./wiki-run.yaml` by default when you omit `--config` and do not pass direct source flags.
Re-init with `--force` to replace an existing YAML.

**Publication is human-gated by default.** After validation (and the Wiki Reviewer when enabled),
non-interactive `wiki-run` without `--yes` / `--yolo` ends in `awaiting_publication` (exit code **3**)
and does not change the Published Wiki. Interactive Session prompts approve/deny; YOLO/`--yes` only
auto-approves deferred publication (Host validation and locks still apply).

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
| `OPENAI_API_KEY` | API key (required for `openai:*` unless `OPENAI_BASE_URL` alone is set for local authless servers) |
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

### Other providers (preflight)

When the model prefix matches, these keys are required before a Wiki Run starts:

| Model prefix | Environment |
|---|---|
| `anthropic:` / `claude:` | `ANTHROPIC_API_KEY` |
| `google:` / `gemini:` / … | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |

```bash
uv run --locked okf-wiki doctor
# stderr: human summary; stdout: JSON with set/unset, length, source (no raw secrets)
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
| `OKF_WIKI_ERROR_DUMP` | Opt-in path/`1`/`auto` for secret-scrubbed failure diagnostics |

`.env.example` also lists Azure OpenAI and OpenRouter variables for other Pydantic AI prefixes.

**Secrets never go in Wiki Run YAML.** Keys, tokens, and headers there are rejected. Credentials are
not copied into prompts, run records, staging, or publication metadata.

Invalid YAML or limits report **field-level messages**. Operator-facing errors are secret-redacted but
otherwise kept readable (missing API keys are not collapsed to a generic withheld string). Residual
secret-like fragments after redaction may still be withheld.

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
4. Put credentials in `.env` beside the YAML; run `okf-wiki doctor` if unsure.
5. From the project directory: `okf-wiki` / `okf-wiki tui` (interactive), or
   `okf-wiki wiki-run --yes` (non-interactive publish).

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

# Optional separate model for the Host Wiki Reviewer (falls back to model above):
# reviewer_model: anthropic:claude-sonnet-4-6

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
# From the project directory (./wiki-run.yaml); --yes auto-approves publication:
uv run --locked okf-wiki wiki-run --yes

# Explicit path:
uv run --locked okf-wiki wiki-run --config ./wiki-run.yaml --yes

# Optional separate Reviewer model for this run:
uv run --locked okf-wiki wiki-run --yes --reviewer-model anthropic:claude-sonnet-4-6
```

Optional: `--write-visualization` / `--no-write-visualization` when not set in YAML.
Without `--yes` / `--yolo`, a successful Staging validation ends in **`awaiting_publication`**
(exit **3**); Staging is kept and the Published Wiki is unchanged until approval.

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
  --model openai:gpt-5-mini \
  --yes
```

Success is one JSON object (`Complete` + manifest + change summary) when publication is approved
(`--yes` / YOLO / interactive approve). Needs Input returns `status: needs_input` without publishing.
`awaiting_publication` returns exit **3** with JSON `run_status` (and does not publish). Operational
failures return `ok: false` with a type and secret-safe message; the previous Published Wiki is left
unchanged.

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
  --model openai:gpt-5-mini \
  --yes
```

Refresh needs a Host-owned real-directory publication from a successful Generate (with
`.okf-wiki.json` metadata). If the Published Wiki path is still a legacy producer-managed
**symlink**, the Host refuses and does not migrate it—delete or clear the path and full-Generate
again. Summaries report page adds/changes/removes; provenance can still publish when content is
unchanged but revision/ignores or Skill digest changed.

## Operator Session (interactive)

Session-first fullscreen TUI (Textual — scrollable chat view, bottom input, streaming model text
and Host cards). On a TTY, bare `okf-wiki` is the same as `tui`:

```bash
uv run --locked okf-wiki                     # TTY → Operator Session
uv run --locked okf-wiki tui                 # ./wiki-run.yaml by default
uv run --locked okf-wiki tui --config ./wiki-run.yaml
uv run --locked okf-wiki tui --yes           # start with YOLO auto-approve
```

Opens the Session shell **without** starting a Wiki Run. Type a goal (build mode) or `/run` to
start generate/refresh from config. Shows Host progress cards (plan, children, receipts,
compaction, validation, review, publish) and streams pydantic-ai model/tool events into the chat
view (no chain-of-thought dump). Publication is approve/deny unless YOLO is on. Needs Input answers
start a **new** Wiki Run with `explicit_answers` (does not resume the prior Semantic Workflow).

Useful slash commands:

| Command | Meaning |
|---|---|
| `/run` (`/start`) | Start a Wiki Run from Session config |
| `/yolo [on\|off]` | Toggle publication auto-approve only |
| `/mode build\|ask` | `build` starts Wiki Runs; `ask` records history only |
| `/usage` | Last Wiki Run id/status in this Session |
| `/doctor` | Credential presence (redacted) |
| `/sessions` | List Sessions (`*` = current) |
| `/new` | Start a new empty Session (Host config unchanged) |
| `/switch <id>` (`/resume`) | Switch Session; reloads history only (not Wiki Run graph) |
| `/quit` | Exit |

Sessions are stored under `.okf-wiki/sessions/` (history only—not Wiki Run graph resume). Non-TTY is
rejected for the Session entry; automation should use `wiki-run --yes` JSON.

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

Example live manifest: [wiki_evaluation_repositories.json](src/okf_wiki/evaluation/wiki_evaluation_repositories.json).

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
