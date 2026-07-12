import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime


def _migration_1(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            repository TEXT NOT NULL,
            revision TEXT NOT NULL,
            publish_dir TEXT NOT NULL,
            staging_dir TEXT NOT NULL,
            state TEXT NOT NULL,
            coverage_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS run_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES runs(id),
            previous_state TEXT,
            state TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}'
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS coverage_obligations (
            id TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES runs(id),
            source TEXT NOT NULL,
            role TEXT NOT NULL,
            path TEXT NOT NULL,
            source_unit TEXT NOT NULL,
            kind TEXT NOT NULL,
            priority TEXT NOT NULL,
            disposition TEXT NOT NULL,
            reason TEXT,
            span TEXT NOT NULL,
            text TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        )"""
    )
    connection.execute(
        """CREATE TRIGGER IF NOT EXISTS run_events_no_update
        BEFORE UPDATE ON run_events BEGIN
            SELECT RAISE(ABORT, 'Run Events are immutable');
        END"""
    )
    connection.execute(
        """CREATE TRIGGER IF NOT EXISTS run_events_no_delete
        BEFORE DELETE ON run_events BEGIN
            SELECT RAISE(ABORT, 'Run Events are immutable');
        END"""
    )


def _migration_2(connection: sqlite3.Connection) -> None:
    run_columns = {row[1] for row in connection.execute("PRAGMA table_info(runs)")}
    if "source_set_json" not in run_columns:
        connection.execute("ALTER TABLE runs ADD COLUMN source_set_json TEXT")
    obligation_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(coverage_obligations)")
    }
    if "details" not in obligation_columns:
        connection.execute(
            "ALTER TABLE coverage_obligations ADD COLUMN details TEXT NOT NULL DEFAULT '{}'"
        )


def _migration_3(connection: sqlite3.Connection) -> None:
    statements = (
        """CREATE TABLE IF NOT EXISTS accepted_candidates (
            run_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL,
            PRIMARY KEY (run_id, candidate_id)
        )""",
        """CREATE TABLE IF NOT EXISTS accepted_evidence (
            run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            revision TEXT NOT NULL,
            path TEXT NOT NULL,
            source_unit TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            digest TEXT NOT NULL,
            evidence_kind TEXT NOT NULL,
            authority TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS accepted_claims (
            run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            statement TEXT NOT NULL,
            modality TEXT NOT NULL,
            conditions_json TEXT NOT NULL,
            epistemic_status TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS claim_evidence (
            run_id TEXT NOT NULL,
            claim_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            PRIMARY KEY (run_id, claim_id, evidence_id),
            FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id),
            FOREIGN KEY (run_id, evidence_id) REFERENCES accepted_evidence(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS claim_links (
            run_id TEXT NOT NULL,
            claim_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            target_claim_id TEXT NOT NULL,
            PRIMARY KEY (run_id, claim_id, kind, target_claim_id),
            FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id),
            FOREIGN KEY (run_id, target_claim_id) REFERENCES accepted_claims(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS accepted_concepts (
            run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            aliases_json TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_claims (
            run_id TEXT NOT NULL,
            concept_id TEXT NOT NULL,
            claim_id TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (run_id, concept_id, claim_id),
            FOREIGN KEY (run_id, concept_id) REFERENCES accepted_concepts(run_id, id),
            FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS concept_relations (
            run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            subject_concept_id TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object_concept_id TEXT NOT NULL,
            PRIMARY KEY (run_id, id),
            FOREIGN KEY (run_id, subject_concept_id)
                REFERENCES accepted_concepts(run_id, id),
            FOREIGN KEY (run_id, object_concept_id)
                REFERENCES accepted_concepts(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS relation_evidence (
            run_id TEXT NOT NULL,
            relation_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            PRIMARY KEY (run_id, relation_id, evidence_id),
            FOREIGN KEY (run_id, relation_id) REFERENCES concept_relations(run_id, id),
            FOREIGN KEY (run_id, evidence_id) REFERENCES accepted_evidence(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS page_plans (
            run_id TEXT NOT NULL,
            concept_id TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT NOT NULL,
            PRIMARY KEY (run_id, concept_id),
            FOREIGN KEY (run_id, concept_id) REFERENCES accepted_concepts(run_id, id)
        )""",
        """CREATE TABLE IF NOT EXISTS obligation_claims (
            run_id TEXT NOT NULL,
            obligation_id TEXT NOT NULL,
            claim_id TEXT NOT NULL,
            PRIMARY KEY (run_id, obligation_id, claim_id),
            FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id)
        )""",
    )
    for statement in statements:
        connection.execute(statement)


def _migration_4(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS verification_candidates (
            run_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            proposal_json TEXT NOT NULL,
            status TEXT NOT NULL,
            decision_json TEXT,
            PRIMARY KEY (run_id, candidate_id)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS verification_findings (
            run_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL,
            perspective TEXT NOT NULL,
            finding_json TEXT NOT NULL,
            PRIMARY KEY (run_id, candidate_id, perspective),
            FOREIGN KEY (run_id, candidate_id)
                REFERENCES verification_candidates(run_id, candidate_id)
        )"""
    )


def _migration_5(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS analysis_tasks (
            run_id TEXT NOT NULL REFERENCES runs(id),
            id TEXT NOT NULL,
            state TEXT NOT NULL,
            obligation_ids_json TEXT NOT NULL,
            source_id TEXT NOT NULL,
            repository TEXT NOT NULL,
            revision TEXT NOT NULL,
            allowed_paths_json TEXT NOT NULL,
            agent_role TEXT NOT NULL,
            allowed_tools_json TEXT NOT NULL,
            prompt TEXT NOT NULL,
            budgets_json TEXT NOT NULL,
            receipt_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS scheduler_control (
            run_id TEXT PRIMARY KEY REFERENCES runs(id),
            replan_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            warning TEXT
        )"""
    )


MIGRATIONS = (_migration_1, _migration_2, _migration_3, _migration_4, _migration_5)
CURRENT_STATE_SCHEMA_VERSION = len(MIGRATIONS)


def _migrate(
    connection: sqlite3.Connection,
    migrations: tuple[Callable[[sqlite3.Connection], None], ...],
    schema_name: str,
) -> int:
    current_version = len(migrations)
    connection.execute("SAVEPOINT workspace_schema")
    try:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )"""
        )
        versions = [
            row[0]
            for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ]
        if versions and versions[-1] > current_version:
            raise ValueError(f"{schema_name} uses newer schema version {versions[-1]}")
        if versions and versions != list(range(1, versions[-1] + 1)):
            raise ValueError(f"State schema versions are not contiguous: {versions}")
        for version, migration in enumerate(migrations, 1):
            if version in versions:
                continue
            migration(connection)
            connection.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, datetime.now(UTC).isoformat()),
            )
    except Exception:
        connection.execute("ROLLBACK TO workspace_schema")
        connection.execute("RELEASE workspace_schema")
        raise
    connection.execute("RELEASE workspace_schema")
    return current_version


def migrate_state(
    connection: sqlite3.Connection,
    migrations: tuple[Callable[[sqlite3.Connection], None], ...] = MIGRATIONS,
) -> int:
    return _migrate(connection, migrations, "Workspace state")


def _worker_audit_migration_1(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS worker_candidates (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            obligation_ids_json TEXT NOT NULL,
            source_id TEXT NOT NULL,
            revision TEXT NOT NULL,
            status TEXT NOT NULL,
            proposal_json TEXT,
            errors_json TEXT NOT NULL,
            error_type TEXT,
            trajectory_json TEXT NOT NULL,
            retry_count INTEGER NOT NULL,
            usage_json TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            gateway_id TEXT NOT NULL,
            model TEXT NOT NULL,
            response_model TEXT NOT NULL,
            provider_url TEXT,
            prompt_version TEXT NOT NULL,
            tool_version TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )


WORKER_AUDIT_MIGRATIONS = (_worker_audit_migration_1,)


def migrate_worker_audit(
    connection: sqlite3.Connection,
    migrations: tuple[Callable[[sqlite3.Connection], None], ...] = WORKER_AUDIT_MIGRATIONS,
) -> int:
    return _migrate(connection, migrations, "Worker audit")
