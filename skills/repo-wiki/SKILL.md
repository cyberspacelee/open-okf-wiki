---
name: repo-wiki
description: Generate or incrementally refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wiki, architecture map, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from immutable source snapshots. The host agent
orchestrates; `scripts/okf.py` owns source freezing, state transitions,
validation, review binding, publication and rollback. Never edit state JSON.

Requires Git, Python 3.12+ and `uv` on PATH. Commands below work from Bash,
PowerShell and cmd when run from the workspace root. `<skill>` is this
directory.

## Re-anchor first

On entry, resume, or uncertainty:

1. Run `uv run <skill>/scripts/okf.py run status --json`.
2. If a run exists, read `references/<current_phase>.md` and perform only its
   listed `next_actions`.
3. If no workspace exists, run `workspace init`; if no run exists, run
   `run start --producer repo-wiki/<model> --session <unique-session>`.

Completed targets are immutable unless review reopens them. Disk state wins
over conversation memory.

## Sources

`workspace init --lang en|zh --freshness-days 90` adds the current Git repo as
`self`. Add more sources explicitly:

```text
uv run <skill>/scripts/okf.py source add --kind git --name api C:\src\api
uv run <skill>/scripts/okf.py source add --kind git --name web https://host/web.git
uv run <skill>/scripts/okf.py source add --kind postgres --name appdb --url-env DATABASE_URL --schema public --table orders --table customers
```

Formal runs reject dirty/untracked Git sources, submodules and paths that
cannot be represented on Windows. Each run reads a content-addressed snapshot,
never the live worktree. PostgreSQL sources are read-only and include only
explicitly selected tables; credentials never enter state or citations.

## Phases

The fixed order is inspect -> survey -> synthesize (multi-Git only) -> plan ->
write -> derive -> review -> publish. Read the matching reference before work.

For every target:

```text
uv run <skill>/scripts/okf.py task start <phase>:<name>
# write exactly the artifact path reported by run status
uv run <skill>/scripts/okf.py task complete <phase>:<name>
```

Completion validates the artifact and advances only on success. Give workers
the target spec, frozen snapshot path, reference path and exact output path.
Workers return short receipts; artifact content stays on disk. Without worker
sessions, execute targets serially.

The plan phase is mandatory. It assigns every finding once, bounds page count,
and enables page-level reuse. A page is reused only when its plan entry is
identical, all cited file hashes are unchanged, and `stale_after` has not
passed. Changed evidence reopens only affected work; no heuristic source read
tracking is used.

## Review and publish

Review must run in a session different from the producer:

```text
uv run <skill>/scripts/okf.py review start --actor repo-wiki/<reviewer> --session <new-session>
uv run <skill>/scripts/okf.py review submit --report <review.json>
uv run <skill>/scripts/okf.py publication publish
uv run <skill>/scripts/okf.py publication export --to wiki
```

`publish` installs an immutable generation and atomically replaces the small
`current.json` pointer. `wiki/` is an explicit, recoverable export for Git; it
is not the live publication boundary. Use `publication rollback` to switch to
the previous generation.

The review stamp is `machine-confirmed`. After explicit human inspection,
upgrade selected pages in a new generation:

```text
uv run <skill>/scripts/okf.py verify --actor human:<identity> --page overview.md
```

Reserved `index.md` and `log.md` are generated only by publish. Never author
them in Candidate.
