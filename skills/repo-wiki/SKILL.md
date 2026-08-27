---
name: repo-wiki
description: Generate or incrementally refresh a thin, evidence-anchored repository Wiki and human-reviewed onboarding proposals. Use for codebase Wiki, architecture map, onboarding documentation, AGENTS.md or CONTEXT.md proposals, and resuming an existing Wiki run.
---

# Repo Wiki

Produce an OKF v0.2 Wiki from Git revisions and selected database catalogs.
The host is a coordinator; `scripts/okf.py` owns revisions, state transitions,
validation, review binding, publication and rollback. Never edit state JSON.

Requires Git, Python 3.12+ and `uv` on PATH. Commands below work from Bash,
PowerShell and cmd when run from the workspace root. `<skill>` is this
directory.

## Coordinator contract

Workers read Source, draft and Candidate bodies. The coordinator reads only
`run status --json`, `task start <id> --json` dispatch packets, worker Handoffs
of at most 10 lines and 2 KiB, and validator issue lists.

Every content target runs in a worker session, including inspect. Give the
worker the dispatch packet as paths, never pasted contents. The worker writes
the exact artifact path and returns its path, finding ids when present, and gap
count. A host without worker sessions stops and reports that requirement; the
coordinator never takes over content work.

## Re-anchor

On entry, resume, or uncertainty:

1. Run `uv run <skill>/scripts/okf.py run status --json`.
2. If a run exists, perform only its listed `next_actions`.
3. If no workspace exists, run `workspace init`. If it has no Sources, add
   them explicitly. If no run exists, run
   `run start --producer repo-wiki/<model> --session <unique-session>`.

Completed targets are immutable unless review reopens them. Disk state wins
over conversation memory.

## Sources

`workspace init --lang en|zh --freshness-days 90` creates an empty Workspace.
Add every Source explicitly. `link` registers a Git worktree already mounted
inside the Workspace. `clone` creates one worktree under `.okf-wiki/sources`.
Source names preserve ASCII letter case; case-insensitive duplicates fail:

```text
uv run <skill>/scripts/okf.py source add link .\API --name API
uv run <skill>/scripts/okf.py source add clone https://host/web.git --name web --ref main
uv run <skill>/scripts/okf.py source add postgres --name appdb --url-env DATABASE_URL --schema public --table orders --table customers
```

Link targets outside the Workspace fail; mount them into the Workspace first.
Formal runs reject dirty Git sources, submodules and non-portable paths, then
record HEAD. Workers read the mounted worktree while gates require HEAD and
cleanliness to remain unchanged. Citations resolve from the recorded Git
object. PostgreSQL catalogs include only selected tables and credentials never
enter state or citations.

## Phases

The fixed order is inspect -> survey -> synthesize (multi-Git only) -> plan ->
write -> derive -> review -> publish. Read the matching reference before work.

For every target listed by status:

```text
uv run <skill>/scripts/okf.py task start <phase>:<name> --json
# dispatch one worker with the returned packet
uv run <skill>/scripts/okf.py task complete <phase>:<name>
```

Completion validates the artifact and advances only on success. Relay rejected
issues to the same worker as a repair task. Artifact content stays on disk.

The plan phase assigns every finding once and enables page reuse. Page count
follows the Grep Test, not a fixed quota. Reuse requires an identical plan,
unchanged cited Git blobs and an unexpired `stale_after`.

## Review and publish

Start review, dispatch its packet to a fresh worker session, then submit the
worker's report:

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
