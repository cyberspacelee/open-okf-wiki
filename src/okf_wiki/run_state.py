import json
import sqlite3
from datetime import UTC, datetime

from .run_events import append_run_event


RUN_TRANSITIONS = {
    "preparing": {"exploring", "failed", "cancelled"},
    "exploring": {"verifying", "failed", "cancelled"},
    "verifying": {"exploring", "rendering", "failed", "cancelled"},
    "rendering": {"checking", "failed", "cancelled"},
    "checking": {"review_required", "failed", "cancelled"},
    "review_required": {"publishing", "failed", "cancelled"},
    "publishing": {"published", "failed"},
}


class RunTransitionError(ValueError):
    pass


def transition_run(
    connection: sqlite3.Connection,
    run_id: str,
    previous_state: str,
    next_state: str,
    *,
    coverage: dict | None = None,
    error: str | None = None,
    details: dict | None = None,
) -> None:
    if next_state not in RUN_TRANSITIONS.get(previous_state, set()):
        raise RunTransitionError(
            f"Illegal Production Run transition: {previous_state} -> {next_state}"
        )
    event_details = dict(details or {})
    if error:
        event_details["error"] = error
    changed = connection.execute(
        """UPDATE runs
           SET state = ?, coverage_json = COALESCE(?, coverage_json), error = ?, updated_at = ?
           WHERE id = ? AND state = ?""",
        (
            next_state,
            json.dumps(coverage, sort_keys=True) if coverage is not None else None,
            error,
            datetime.now(UTC).isoformat(),
            run_id,
            previous_state,
        ),
    )
    if changed.rowcount != 1:
        raise RunTransitionError(f"Run {run_id} is not in {previous_state}")
    append_run_event(connection, run_id, previous_state, next_state, event_details)
