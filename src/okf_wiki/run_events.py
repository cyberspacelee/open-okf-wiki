import json
import sqlite3
from datetime import UTC, datetime


def append_run_event(
    connection: sqlite3.Connection,
    run_id: str,
    previous_state: str | None,
    state: str,
    details: dict | None = None,
) -> None:
    connection.execute(
        """INSERT INTO run_events (run_id, previous_state, state, occurred_at, details)
           VALUES (?, ?, ?, ?, ?)""",
        (
            run_id,
            previous_state,
            state,
            datetime.now(UTC).isoformat(),
            json.dumps(details or {}, sort_keys=True),
        ),
    )


def append_entity_event(
    connection: sqlite3.Connection,
    run_id: str,
    entity_type: str,
    entity_id: str,
    previous_state: str | None,
    state: str,
    *,
    candidate_id: str | None = None,
) -> None:
    details = {"entity_id": entity_id, "entity_type": entity_type}
    if candidate_id is not None:
        details["candidate_id"] = candidate_id
    append_run_event(connection, run_id, previous_state, state, details)
