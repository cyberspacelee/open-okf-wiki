# Open OKF Wiki (v2)

A portable, skill-driven harness that turns one or more Git repositories into
a **thin, evidence-anchored repository Wiki** plus agent onboarding files
(AGENTS.md managed block, CONTEXT.md draft, ADR stubs). Any host coding agent
— Claude Code, Codex, Amp, … — orchestrates by following `SKILL.md`; every
guarantee that matters is enforced by deterministic Python scripts, not by
prompt discipline.

The Wiki is a semantic routing layer, not a source mirror: it carries only
knowledge that is expensive to rebuild by search (architecture, invariants,
failure propagation, task entry points) and every claim cites a real, opened
source location. See [CONTEXT.md](CONTEXT.md) for vocabulary and
[docs/adr/](docs/adr/) for the five decisions that shape the design.

## Requirements

- `git`
- [`uv`](https://docs.astral.sh/uv/) on PATH (Python 3.12+ resolved
  automatically; core scripts have zero third-party dependencies)

## Quick start

Point your coding agent at this repo's skill and a target workspace:

> Read skills/repo-wiki/SKILL.md and follow it to produce a wiki for this
> repository.

Claude Code users get the skill auto-discovered via the committed
`.claude/skills/repo-wiki` symlink. Other agents reach it through
[AGENTS.md](AGENTS.md), which points at the same SKILL.md.

Under the hood the agent drives one CLI:

```bash
uv run skills/repo-wiki/scripts/okf.py init --lang zh     # create workspace
uv run skills/repo-wiki/scripts/okf.py source add <path-or-url> --name api
uv run skills/repo-wiki/scripts/okf.py state init         # open a run
uv run skills/repo-wiki/scripts/okf.py state status --json
uv run skills/repo-wiki/scripts/okf.py validate
uv run skills/repo-wiki/scripts/okf.py publish
```

A single Git repository with no config is an implicit workspace (one source,
no citation prefix). Multiple repositories are registered with `source add`;
citations then carry the source name (`api/src/main.ts#L12`) and a synthesize
phase verifies cross-source connections from both ends before root pages are
written.

## How it works

```text
inspect → survey(×N sources) → synthesize(multi-source) → write → derive → review → publish
```

- **State Gate** — `.okf-wiki/state.json` is the only source of truth for
  progress, mutated only by `okf.py state`. Completing a target runs
  validation first and refuses to advance on failure; a subagent's "done" is
  a claim, the gate is the arbiter. Any session, any host, any model resumes
  with `state status`.
- **Evidence anchoring** — citations must resolve to real files and line
  ranges the writer actually opened; fabricated rationale and unverifiable
  claims block publication. Honest gaps are first-class
  (`coverage: partial` + a Gaps section), invented prose is not.
- **Thin-wiki budget** — content that fails the Grep Test (rebuildable with
  grep + reading a few files) is rejected in review; pages scale with
  domains, not directories.
- **Proposals, never auto-applied** — AGENTS.md content is generated only
  inside a version-stamped managed block, CONTEXT.md terms are drafted with
  synonym clusters left for human ratification, ADR stubs carry evidence but
  leave rationale to humans. Everything lands in `.okf-wiki/proposals/` for
  review.
- **Transactional publish** — `publish` regenerates the index, re-validates
  every page, computes a digest, and swaps `wiki/` atomically, keeping the
  previous Wiki until the next publish.

## Layout

```text
skills/repo-wiki/
  SKILL.md              # host-agent SOP: re-anchor protocol + phase dispatch
  references/           # writing contract + per-phase instructions (loaded on entry)
  scripts/okf.py        # init | source | state | validate | db | publish
  scripts/_*.py         # deterministic kernel (146 tests)
  assets/templates/     # page skeletons (overview / architecture / domain)
  evals/                # tiered eval harness (see below)
docs/adr/               # why it is built this way
AGENTS.md, CONTEXT.md   # this repo's own onboarding + vocabulary
```

In a consumer workspace: commit `wiki/` and any applied proposals; ignore
`.okf-wiki/` (run state, drafts, candidate — all reproducible).

## Testing and evals

```bash
# unit: 146 tests, sub-second
cd skills/repo-wiki/scripts && uv run --with pytest pytest tests/ -q

# tier-1: deterministic CLI-contract e2e, no LLM, CI-safe
./skills/repo-wiki/evals/run_cli_e2e.sh

# tier-2: a real host agent runs the skill on a two-repo Java fixture
# (feign + spring-cloud-openfeign), then a deterministic grader checks
# outcomes: page budget, 0 validation errors, sampled citations resolve
# against real source (anti-fabrication), managed-block proposals per source
WIKI_EVAL=1 ./skills/repo-wiki/evals/run_live_eval.sh tmp/okf-java-eval codex
uv run skills/repo-wiki/evals/grade_run.py <workspace>
```

Optional database evidence (`okf.py db`) targets openGauss/PostgreSQL,
read-only, with credentials resolved from a workspace `.env`; it is the only
command with a third-party dependency (psycopg, declared inline via PEP 723).

## Status

v2 is a ground-up restart on an orphan branch; the v1 Pi-extension host lives
on `master`. Verified end-to-end by an unassisted Codex run over the Java
fixture (7 phases, 15 targets, one gate rejection self-repaired, 0 validation
errors). Portability target: Claude Code, Codex, Amp.
