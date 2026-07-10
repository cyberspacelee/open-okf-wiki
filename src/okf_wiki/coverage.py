import json
import sqlite3
from datetime import UTC, datetime


DISPOSITIONS = {"blocked", "covered", "deferred", "excluded", "failed", "open"}


def obligation_rows(connection: sqlite3.Connection, run_id: str) -> list[dict]:
    return [
        {
            **dict(row),
            "span": json.loads(row["span"]),
            **json.loads(row["details"]),
        }
        for row in connection.execute(
            """SELECT id, source, role, path, source_unit, kind, priority, disposition,
                      reason, span, text, details
               FROM coverage_obligations WHERE run_id = ? ORDER BY id""",
            (run_id,),
        )
    ]


def summarize_obligations(obligations: list[dict], sources: list[dict] | None = None) -> dict:
    sources = sources or []
    summary = {
        "total": len(obligations),
        "major": sum(item["priority"] == "major" for item in obligations),
        "supporting": sum(item["priority"] == "supporting" for item in obligations),
        **{
            disposition: sum(item["disposition"] == disposition for item in obligations)
            for disposition in sorted(DISPOSITIONS)
        },
    }
    for output, field in {
        "by_source": "source",
        "by_role": "role",
        "by_priority": "priority",
    }.items():
        groups = {}
        values = {item[field] for item in obligations}
        if field == "source":
            values.update(source["id"] for source in sources)
        elif field == "role":
            values.update(source["role"] for source in sources)
        else:
            values.update(("major", "supporting"))
        for value in sorted(values):
            members = [item for item in obligations if item[field] == value]
            groups[value] = {
                "dispositions": {
                    disposition: sum(item["disposition"] == disposition for item in members)
                    for disposition in sorted({item["disposition"] for item in members})
                },
                "total": len(members),
            }
        summary[output] = groups
    return summary


def major_blockers(coverage: dict) -> int:
    dispositions = coverage.get("by_priority", {}).get("major", {}).get("dispositions", {})
    return sum(dispositions.get(state, 0) for state in ("blocked", "failed", "open"))


def refresh_run_coverage(connection: sqlite3.Connection, run_id: str) -> dict:
    row = connection.execute("SELECT source_set_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown Production Run: {run_id}")
    source_set = json.loads(row["source_set_json"])
    sources = source_set["sources"]
    obligations = obligation_rows(connection, run_id)
    coverage = summarize_obligations(obligations, sources)
    for source in sources:
        source["coverage"] = summarize_obligations(
            [item for item in obligations if item["source"] == source["id"]], [source]
        )
    connection.execute(
        """UPDATE runs SET coverage_json = ?, source_set_json = ?, updated_at = ?
           WHERE id = ?""",
        (
            json.dumps(coverage, sort_keys=True),
            json.dumps(source_set, sort_keys=True),
            datetime.now(UTC).isoformat(),
            run_id,
        ),
    )
    return coverage
