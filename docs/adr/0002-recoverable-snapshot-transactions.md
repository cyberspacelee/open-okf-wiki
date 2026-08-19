# Recoverable snapshot transactions

Run lifecycle is committed as a versioned snapshot in `run.json`. There is no write-ahead event journal. Recovery reads the run snapshot (and tails for inspect), not lead-state + progress. A dead `pid` on a still-running snapshot is treated as paused.

The current Run view is `run.json` format 3. The pinned production plan is written once to `plan.json`. Agent process tails are replaceable files under `agents/`. There is no retained event log, no telemetry WAL, and no ledger. `updates()` is a live view stream. Opening any other Run format fails closed; a human preserves evidence and deletes stale `.okf-wiki` Run state. The Published Wiki is independent.

Publication retains its separate rename journal because installing the Candidate changes a different filesystem lifetime and cannot share an atomic commit with Run state. A Workspace publication lease serializes the journal and filesystem swap across instances and processes. If installation is durable but the Run terminal snapshot is not, recovery projects the committed publication into that snapshot. Only after the Run terminal transition is durable is the active journal acknowledged into a per-Run audit archive. Archived journals remain evidence but are excluded from future recovery, so a later full-generation Run is never checked against an earlier Published Wiki digest.

Live agent telemetry overwrites the agent file. Heartbeats and tool tails do not rewrite `run.json`. A dead `pid` on a still-running snapshot is recovered as paused.
