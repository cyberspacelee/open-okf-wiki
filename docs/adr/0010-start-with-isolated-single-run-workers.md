# Start with isolated single-run workers

The first production topology assigns each Production Run to one isolated Run Worker with a local SQLite ledger, staging area, deterministic Scheduler, and process-local Agent concurrency. Multiple repositories run in separate workers, avoiding a shared distributed control plane until same-run cross-node execution, writer contention, high availability, tenant isolation, or centralized operational state makes PostgreSQL and a queue necessary.
