# Treat manual retry as a new run with frozen inputs

When automatic provider or bounded child retries are exhausted, a human-triggered retry creates a new Wiki Run rather than resuming the failed run. The Host persists a small immutable, secret-free terminal run record containing the exact resolved inputs needed to reproduce the attempt. By default the retry reuses the failed run's exact Repository Snapshot Set revisions, Skill Version or Skill Fork revision, model, limits, and explicit user answers, while receiving a new run identity and fresh planning/context; it does not reuse old message history, staging, or partial receipts. Following a newer branch revision requires an explicitly new Wiki Run, and durable checkpoint recovery remains a separate future design.

This keeps retry behavior reproducible and prevents stale or partial evidence from silently entering a later publication, while preserving an explicit human escape hatch after bounded automation fails.
