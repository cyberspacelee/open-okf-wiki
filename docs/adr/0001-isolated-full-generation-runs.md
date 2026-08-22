# Isolated full-generation runs

Every Run starts from an empty Candidate and generates a Wiki from Sources
pinned for that Run. A Workspace has one addressable current Run at
`.okf-wiki/run/`; no Run list or historical Run lookup exists. The Published
Wiki is output, not generation input.

This rejects incremental refresh of `wiki/` from a prior Run so evidence
freshness does not depend on hidden history.

Paused and failed Runs retain the current directory for explicit resume or
cancel. Successful and cancelled Runs remove it. Starting a Run deletes the
legacy `.okf-wiki/runs/` layout instead of migrating it.
