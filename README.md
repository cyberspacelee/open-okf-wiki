# Open OKF Wiki v1

A skill-driven producer for thin, evidence-anchored repository Wikis. Agents
follow skills/repo-wiki/SKILL.md; deterministic Python gates bind Git revisions,
validate phase artifacts, bind independent review to a candidate digest and
publish OKF v0.2 generations.

## Install

Prerequisites: Git, [uv](https://docs.astral.sh/uv/) and Node.js for the skills
installer. Until this release reaches the default branch, clone its published
branch explicitly:

```text
git clone --depth 1 --branch v2/skill-harness https://github.com/cyberspacelee/open-okf-wiki.git open-okf-wiki
```

From the repository that should receive the Wiki, install the skill at project
scope. This example assumes the two repositories are siblings:

```text
npx skills@latest add ../open-okf-wiki/skills/repo-wiki --skill repo-wiki -y
```

The installer detects supported agents; use `--agent <name>` only to target one.
Codex and Pi discover project skills under `.agents/skills/`; Pi also supports
`.pi/skills/`, while Grok Build uses `.grok/skills/` or a configured skill path.
Add `--copy` where symlink privileges are unavailable. A copied install is a
versioned bundle, not a development link: reinstall it after upgrading this
repository and commit its `skills-lock.json` entry. Verify that the harness
resolves `repo-wiki` to the intended path when discovery scopes overlap.
Before starting a Run on another machine, update the installed skill. A current
Run reports contract `artifact-loop-routing-closure`; another contract identifies a
stale bundle or legacy Run. Preserve that Workspace for forensics and start from
a new hub after reinstalling rather than resuming or migrating it.

The runtime bundle and kernel are host- and model-neutral. Set the actual
installed directory once for the commands below:

```bash
REPO_WIKI_SKILL=.agents/skills/repo-wiki  # Codex or Pi
# REPO_WIKI_SKILL=.pi/skills/repo-wiki    # Pi native scope
# REPO_WIKI_SKILL=.grok/skills/repo-wiki  # Grok Build
```

A Run pins each Git Source at its HEAD commit. Live worktrees may be dirty or
move afterwards; workers read the Pin. Commit the installed skill and lock
file, or keep local agent files out of the source. A typical local-only
`.gitignore` section is:

```gitignore
.agents/
skills-lock.json
.okf-wiki/
.env
```

Commit the `.gitignore` change before starting a Run. Keep `wiki/` tracked if
the exported Wiki belongs in the repository.

## Quick start

Run from the directory that should own the Wiki. Initialization creates an
empty Workspace; it never assumes that the current directory is a Source:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py workspace init --lang zh --freshness-days 90
uv run $REPO_WIKI_SKILL/scripts/okf.py workspace show --json
```

The Workspace policy is complete and strict. These defaults bound every
evidence response and all host-agent phases:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py workspace init --lang zh \
  --max-active-children 4 --max-children-per-run 128 \
  --search-max-results 100 --search-max-output-bytes 65536 \
  --read-default-lines 200 --read-max-lines 1000 \
  --read-max-output-bytes 262144
```

Change policy only between Runs with `workspace configure`; `run start`
snapshots it and records the installed skill bundle digest. The portable policy
is always the scheduling target. A harness-native cap is an additional guard,
not part of the kernel:

| Harness | Skill discovery | Concurrency enforcement |
| --- | --- | --- |
| Codex | `.agents/skills/` | Map the Run value to the project/session native cap below. |
| [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md) | `.agents/skills/` or `.pi/skills/` | Its optional [reference subagent extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) currently caps parallel tasks at four; lower Run values remain coordinator-enforced. |
| [Grok Build](https://docs.x.ai/build/features/skills-plugins-marketplaces) | `.grok/skills/` or configured paths | [Subagents are native](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md), but no numeric hard cap is documented; the coordinator enforces the Run value. |

Codex native-cap example:

```toml
# .codex/config.toml
[agents]
max_concurrent_threads_per_session = 4
```

The skill uses a four-slot rolling window by default: a freed slot is refilled
immediately. Evidence research, page writing, repairs and reviews share that
one window; children never spawn descendants.

Register every clean Git Source explicitly. `link` registers a local
worktree — paths outside the Workspace are mounted automatically under
`<workspace>/<name>/` (symlink on POSIX, junction on Windows); `clone`
materializes a Git URL in the same place. `workspace.json` lives at the hub
root.
Source names preserve letter case, while names that differ only by case are
rejected for Windows portability. The Workspace is always a separate hub;
register the intended repository from a named child or external path:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py source add link ../app --name app
uv run $REPO_WIKI_SKILL/scripts/okf.py source add link ../services/API --name API
uv run $REPO_WIKI_SKILL/scripts/okf.py source add clone https://github.com/example/web.git --name Web --ref main
uv run $REPO_WIKI_SKILL/scripts/okf.py source list --json
```

The producer never copies a Git source into a private snapshot: linked
sources are read through their hub mount, workers read a Pin at the recorded
commit, and citations resolve from Git's object database.

OpenGauss is optional. Store the URL in the operating-system environment or
in a workspace-root `.env`; the operating-system value wins. Configuration and
Run state retain only the variable name, never credentials.
Only `opengauss://` connection URLs are accepted. They remain deployment
configuration and Catalog provenance. Plan, page and publication evidence uses
stable logical resources such as `appdb/orders`; the PostgreSQL wire-protocol
conversion is internal.

```dotenv
APP_DATABASE_URL=opengauss://user:password@host:5432/database
```

Inspect the live schema before selecting tables:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py db tables --url-env APP_DATABASE_URL --json
uv run $REPO_WIKI_SKILL/scripts/okf.py db describe orders --url-env APP_DATABASE_URL --json
uv run $REPO_WIKI_SKILL/scripts/okf.py source add opengauss --name appdb --url-env APP_DATABASE_URL --schema public --table orders --table customers
```

After `run start`, `catalog tables` / `catalog describe` read the captured
catalog (table and column comments included) without reconnecting. Workers
use those commands, not `state.json`, `catalog.json` or Catalog paths from a
dispatch packet.

Start the Run, then ask the coding agent to use the `repo-wiki` skill and resume
from status. Run IDs are internal and require no user-supplied session:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py run start
uv run $REPO_WIKI_SKILL/scripts/okf.py run status --json
```

The host agent runs one explicit loop until Publication or a real external
block. `run status` derives the next phase from fixed Plan, progress,
Composition, draft and review Artifacts. One long-lived planner owns the
cross-Source model in readable `plan.md` plus strict `plan-ledger.json`; focused
workers write bounded evidence notes. After Composition approval, `page prepare
<page-id>` creates one bounded packet for each independent writer. One fresh
reviewer checks the complete Candidate. Validation and review defects return to
the loop.

PowerShell 7 can consume every JSON command without inline Python:

```powershell
$status = uv run $env:REPO_WIKI_SKILL/scripts/okf.py run status --json | ConvertFrom-Json
$status.next_actions
```

After a distinct reviewer approves the candidate:

```text
uv run $REPO_WIKI_SKILL/scripts/okf.py publication publish
uv run $REPO_WIKI_SKILL/scripts/okf.py publication export --to wiki
uv run $REPO_WIKI_SKILL/scripts/okf.py validate --published
```

The authoritative publication is
.okf-wiki/publication/generations/<digest>, selected through current.json.
wiki/ is an explicit recoverable export suitable for Git. This file/pointer
design behaves consistently on Windows, Linux and macOS without symlinks.

## Guarantees

- Grep Test keeps the Wiki a routing layer rather than a source mirror.
- Citations are plain `path#Lx-Ly` locators resolved against the Run's
  recorded Git commit; line ranges must exist at that revision.
- Frontmatter is parsed as bounded YAML with duplicate keys and aliases
  rejected, then validated by Pydantic.
- Page types and planned Diagram Specs are machine-readable; Mermaid diagram
  declarations, basic structure, accessibility fields and adjacent evidence
  captions are gated.
- generated, verified, status and stale_after make lifecycle and trust
  machine-readable.
- Drafts and logical links use stable page IDs; physical paths and generated
  Navigation Indexes are bound from the Composition Map when the complete
  Candidate is prepared for review.
- One living Plan and progress file persist analysis and next actions across
  context compression. There are no Attempt or checkpoint histories.
- One immutable Run Policy bounds compact JSON evidence output, active and total
  child fan-out; search/read continuation prevents rescanning after truncation.
- One independent Wiki review binds Plan, Composition, drafts and Candidate to
  an exact digest; every change requires a new complete-bundle review whose
  packet points to the fixed prior review Artifact.
- Every Run must close Source Area, Domain and Concept coverage; empty Plans,
  Compositions and Candidates are rejected.
- Root index.md contains only okf_version 0.2; nested indexes and log.md have
  no frontmatter. Candidate and Publication both contain the deterministic
  navigation tree.
- OpenGauss catalog access is read-only and selected-table only; canonical
  resources contain no credentials. Run state stores catalog identity;
  column bodies and comments live under
  `.okf-wiki/catalogs/<source>-<short-hash>/`; the manifest retains and verifies
  the full content hash.
- Source-facing AGENTS, CONTEXT and ADR changes remain proposals requiring
  human ratification.

## Quality checks

Cross-platform deterministic QA:

    uv run --with pytest --with pydantic --with PyYAML --with "psycopg[binary]" pytest -q skills/repo-wiki/scripts/tests
    uv run skills/repo-wiki/evals/run_cli_e2e.py

The live agent eval and grader are under skills/repo-wiki/evals. They inspect
the current generation, not a legacy mutable wiki directory. The shipped live
eval adapters cover Codex and Claude; that adapter list is test tooling scope,
not a restriction on skill runtime hosts or models.

## Layout

    skills/repo-wiki/SKILL.md
    skills/repo-wiki/references/
    skills/repo-wiki/assets/templates/
    skills/repo-wiki/scripts/okf.py
    workspace.json
    <source-name>/
    .okf-wiki/runs/<internal-run-id>/index/
    .okf-wiki/runs/<internal-run-id>/work/
    .okf-wiki/pins/<run-id>/<name>/
    .okf-wiki/catalogs/<source>-<short-hash>/catalog.json
    .okf-wiki/catalogs/<source>-<short-hash>/tables/<table>.json
    .okf-wiki/publication/generations/<digest>/
    wiki/

No prior-version state or CLI compatibility is provided.
