import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime


_MAX_IMPACT_TEXT = 2_000


def _valid_impact_unit_sql(column: str) -> str:
    required = ("id", "source_id", "revision", "path", "kind")
    required_sql = " AND ".join(
        f"json_type({column}, '$.{key}') = 'text' "
        f"AND length(json_extract({column}, '$.{key}')) BETWEEN 1 AND {_MAX_IMPACT_TEXT}"
        for key in required
    )
    digest = f"json_extract({column}, '$.digest')"
    return f"""json_type({column}) = 'object' AND {required_sql} AND
        (json_type({column}, '$.digest') IS NULL
         OR json_type({column}, '$.digest') = 'null'
         OR (json_type({column}, '$.digest') = 'text' AND (
             (length({digest}) = 64 AND {digest} NOT GLOB '*[^0-9a-f]*')
             OR (length({digest}) = 71 AND substr({digest}, 1, 7) = 'sha256:'
                 AND substr({digest}, 8) NOT GLOB '*[^0-9a-f]*')))) AND
        (json_type({column}, '$.label') IS NULL
         OR json_type({column}, '$.label') = 'null'
         OR json_type({column}, '$.label') = 'text')"""


def _normalized_impact_unit_sql(column: str) -> str:
    digest = f"json_extract({column}, '$.digest')"
    return f"""json_object(
        'id', json_extract({column}, '$.id'),
        'source_id', json_extract({column}, '$.source_id'),
        'revision', json_extract({column}, '$.revision'),
        'path', json_extract({column}, '$.path'),
        'kind', json_extract({column}, '$.kind'),
        'digest', CASE WHEN length({digest}) = 64
                    THEN 'sha256:' || {digest} ELSE {digest} END,
        'label', CASE WHEN json_type({column}, '$.label') = 'text'
                   AND length(json_extract({column}, '$.label')) > 0
                 THEN substr(json_extract({column}, '$.label'), 1, {_MAX_IMPACT_TEXT})
                 ELSE NULL END
    )"""


def _impact_change_insert_sql(
    status: str,
    status_order: int,
    path: str,
    before: str,
    after: str,
) -> str:
    active = "COALESCE(raw.after_json, raw.before_json)"
    graph_unit = "raw.after_json" if status == "added" else "raw.before_json"
    graph_run = "NEW.id" if status == "added" else "metadata.graph_run_id"
    paired = (
        f" AND {_valid_impact_unit_sql('raw.before_json')}"
        f" AND {_valid_impact_unit_sql('raw.after_json')}"
        if status in {"changed", "moved"}
        else ""
    )
    return f"""INSERT OR IGNORE INTO run_impact_changes
        (run_id, status, status_order, position, before_json, after_json,
         node_id, node_entity_id, node_label, graph_run_id, source_id, source_unit)
        SELECT NEW.id, '{status}', {status_order}, CAST(raw.position AS INTEGER),
               CASE WHEN raw.before_json IS NULL THEN NULL
                 ELSE {_normalized_impact_unit_sql("raw.before_json")} END,
               CASE WHEN raw.after_json IS NULL THEN NULL
                 ELSE {_normalized_impact_unit_sql("raw.after_json")} END,
               'source-unit:{status}:' || json_extract({active}, '$.id'),
               json_extract({active}, '$.id'),
               substr(COALESCE(
                   NULLIF(json_extract({active}, '$.label'), ''),
                   json_extract({active}, '$.path')
               ), 1, {_MAX_IMPACT_TEXT}),
               {graph_run},
               json_extract({graph_unit}, '$.source_id'),
               json_extract({graph_unit}, '$.id')
          FROM (
              SELECT item.key AS position, {before} AS before_json, {after} AS after_json
                FROM json_each(
                    CASE WHEN json_valid(NEW.source_set_json)
                      THEN NEW.source_set_json ELSE '{{}}' END,
                    '{path}'
                ) AS item
               WHERE item.type = 'object' AND typeof(item.key) = 'integer'
          ) AS raw
          JOIN run_impact_metadata metadata ON metadata.run_id = NEW.id
         WHERE {_valid_impact_unit_sql(active)}{paired};"""


def _impact_trigger_sql(name: str, event: str) -> str:
    guarded = "CASE WHEN json_valid(NEW.source_set_json) THEN NEW.source_set_json ELSE '{}' END"
    affected = "\n".join(
        f"""INSERT OR IGNORE INTO run_impact_affected
            SELECT NEW.id, '{entity_type}', item.value
              FROM json_each({guarded}, '{path}') AS item
             WHERE item.type = 'text'
               AND length(item.value) BETWEEN 1 AND {_MAX_IMPACT_TEXT};"""
        for entity_type, path in (
            ("claim", "$.refresh.reverify_claims"),
            ("concept", "$.refresh.reverify_concepts"),
            ("page", "$.refresh.rerender_pages"),
        )
    )
    changes = "\n".join(
        (
            _impact_change_insert_sql(
                "changed",
                0,
                "$.refresh.diff.changed",
                "json_extract(item.value, '$.before')",
                "json_extract(item.value, '$.after')",
            ),
            _impact_change_insert_sql(
                "moved",
                1,
                "$.refresh.diff.moved",
                "json_extract(item.value, '$.before')",
                "json_extract(item.value, '$.after')",
            ),
            _impact_change_insert_sql(
                "added",
                2,
                "$.refresh.diff.added",
                "NULL",
                "item.value",
            ),
            _impact_change_insert_sql(
                "removed",
                3,
                "$.refresh.diff.removed",
                "item.value",
                "NULL",
            ),
        )
    )
    return f"""CREATE TRIGGER IF NOT EXISTS {name}
        AFTER {event} ON runs
        BEGIN
            DELETE FROM run_impact_changes WHERE run_id = NEW.id;
            DELETE FROM run_impact_affected WHERE run_id = NEW.id;
            DELETE FROM run_impact_metadata WHERE run_id = NEW.id;
            INSERT INTO run_impact_metadata
                (run_id, mode, fallback_reason, base_run_id, graph_run_id,
                 changed_count, moved_count, added_count, removed_count)
                SELECT NEW.id,
                       CASE json_extract(value, '$.refresh.mode')
                         WHEN 'incremental' THEN 'incremental'
                         WHEN 'full' THEN 'full'
                         ELSE 'full'
                       END,
                       CASE
                         WHEN json_type(value, '$.refresh.fallback_reason') = 'text'
                              AND length(json_extract(
                                  value, '$.refresh.fallback_reason'
                              )) > 0
                           THEN substr(json_extract(
                               value, '$.refresh.fallback_reason'
                           ), 1, {_MAX_IMPACT_TEXT})
                       END,
                       CASE
                         WHEN json_type(value, '$.base_run_id') = 'text'
                              AND length(json_extract(value, '$.base_run_id'))
                                  BETWEEN 1 AND {_MAX_IMPACT_TEXT}
                           THEN json_extract(value, '$.base_run_id')
                       END,
                       CASE
                         WHEN json_type(value, '$.base_run_id') = 'text'
                              AND EXISTS (
                                  SELECT 1 FROM runs base
                                   WHERE base.id = json_extract(value, '$.base_run_id')
                              )
                           THEN json_extract(value, '$.base_run_id')
                         ELSE NEW.id
                       END,
                       0, 0, 0, 0
                  FROM (SELECT {guarded} AS value);
            {affected}
            {changes}
            UPDATE run_impact_metadata
               SET changed_count = (
                       SELECT COUNT(*) FROM run_impact_changes
                        WHERE run_id = NEW.id AND status = 'changed'
                   ),
                   moved_count = (
                       SELECT COUNT(*) FROM run_impact_changes
                        WHERE run_id = NEW.id AND status = 'moved'
                   ),
                   added_count = (
                       SELECT COUNT(*) FROM run_impact_changes
                        WHERE run_id = NEW.id AND status = 'added'
                   ),
                   removed_count = (
                       SELECT COUNT(*) FROM run_impact_changes
                        WHERE run_id = NEW.id AND status = 'removed'
                   )
             WHERE run_id = NEW.id;
            UPDATE run_impact_changes
               SET graph_run_id = NEW.id
             WHERE status != 'added'
               AND run_id IN (
                   SELECT run_id FROM run_impact_metadata
                    WHERE base_run_id = NEW.id
               );
            UPDATE run_impact_metadata
               SET graph_run_id = NEW.id
             WHERE base_run_id = NEW.id;
        END"""


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


def _migration_6(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS run_impact_metadata (
            run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
            mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
            fallback_reason TEXT,
            base_run_id TEXT,
            graph_run_id TEXT NOT NULL,
            changed_count INTEGER NOT NULL,
            moved_count INTEGER NOT NULL,
            added_count INTEGER NOT NULL,
            removed_count INTEGER NOT NULL
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS run_impact_changes (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('changed', 'moved', 'added', 'removed')),
            status_order INTEGER NOT NULL,
            position INTEGER NOT NULL,
            before_json TEXT,
            after_json TEXT,
            node_id TEXT NOT NULL,
            node_entity_id TEXT NOT NULL,
            node_label TEXT NOT NULL,
            graph_run_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_unit TEXT NOT NULL,
            PRIMARY KEY (run_id, status, position)
        )"""
    )
    connection.execute(
        """CREATE INDEX IF NOT EXISTS run_impact_changes_lookup
           ON run_impact_changes (run_id, graph_run_id, source_id, source_unit)"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS run_impact_affected (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('claim', 'concept', 'page')),
            entity_id TEXT NOT NULL,
            PRIMARY KEY (run_id, entity_type, entity_id)
        )"""
    )
    connection.execute(_impact_trigger_sql("runs_normalize_impact_after_insert", "INSERT"))
    connection.execute(
        _impact_trigger_sql(
            "runs_normalize_impact_after_source_set_update",
            "UPDATE OF source_set_json",
        )
    )


def _migration_7(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS query_audit (
            id TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            usage_json TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            cited_claim_ids_json TEXT NOT NULL,
            cited_evidence_ids_json TEXT NOT NULL
        )"""
    )


def _migration_8(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS source_investigation_audit (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            source_set_digest TEXT NOT NULL,
            model TEXT NOT NULL,
            usage_json TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            source_ids_json TEXT NOT NULL,
            citations_json TEXT NOT NULL
        )"""
    )


MIGRATIONS = (
    _migration_1,
    _migration_2,
    _migration_3,
    _migration_4,
    _migration_5,
    _migration_6,
    _migration_7,
    _migration_8,
)
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


def _worker_audit_migration_2(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS agent_invocations (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('planner', 'verifier')),
            status TEXT NOT NULL,
            usage_json TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            retry_count INTEGER NOT NULL,
            model TEXT NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )


WORKER_AUDIT_MIGRATIONS = (_worker_audit_migration_1, _worker_audit_migration_2)


def migrate_worker_audit(
    connection: sqlite3.Connection,
    migrations: tuple[Callable[[sqlite3.Connection], None], ...] = WORKER_AUDIT_MIGRATIONS,
) -> int:
    return _migrate(connection, migrations, "Worker audit")
