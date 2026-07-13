import json
import sqlite3
import subprocess
import sys
import tracemalloc
from pathlib import Path

import pytest

from okf_wiki.provenance import ConceptProvenanceStore
from okf_wiki.run_events import append_entity_event
from okf_wiki.state_schema import MIGRATIONS, migrate_state
from okf_wiki.verification import AcceptanceDecision, VerificationStore
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


AFFECTED_EVIDENCE = f"evidence:{'a' * 64}"
STABLE_EVIDENCE = f"evidence:{'b' * 64}"
AFFECTED_CLAIM = f"claim:{'c' * 64}"
STABLE_CLAIM = f"claim:{'d' * 64}"
AFFECTED_CONCEPT = f"concept:{'e' * 64}"
STABLE_CONCEPT = f"concept:{'f' * 64}"
MOVED_EVIDENCE = f"evidence:{'7' * 64}"
MOVED_CLAIM = f"claim:{'8' * 64}"
MOVED_CONCEPT = f"concept:{'9' * 64}"
ADDED_EVIDENCE = f"evidence:{'1' * 64}"
ADDED_CLAIM = f"claim:{'2' * 64}"
ADDED_CONCEPT = f"concept:{'3' * 64}"


def seed_replay_events(database: Path) -> None:
    verification = VerificationStore(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES ('run-1', 'project-1', '.', ?, '.', '.', 'verifying', '{}', ?, ?)""",
            ("a" * 40, "2026-07-13T00:00:00+00:00", "2026-07-13T00:00:00+00:00"),
        )
    verification.stage("run-1", "candidate-accepted", "task-1", {})
    verification.record_decision(
        "run-1", "candidate-accepted", AcceptanceDecision(outcome="accepted")
    )
    with sqlite3.connect(database) as connection:
        append_entity_event(
            connection,
            "run-1",
            "claim",
            "claim:1",
            None,
            "supported",
            candidate_id="candidate-accepted",
        )
        append_entity_event(
            connection,
            "run-1",
            "concept",
            "concept:1",
            None,
            "active",
            candidate_id="candidate-accepted",
        )
    verification.stage("run-1", "candidate-rejected", "task-2", {})
    verification.record_decision(
        "run-1", "candidate-rejected", AcceptanceDecision(outcome="rejected")
    )
    with sqlite3.connect(database) as connection:
        append_entity_event(connection, "run-1", "claim", "claim:1", "supported", "stale")
        connection.execute("CREATE TABLE model_messages (payload TEXT NOT NULL)")
        connection.execute("INSERT INTO model_messages VALUES ('invent an ordering and rationale')")
        connection.execute(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('run-1', 'review_required', 'published', ?, ?)""",
            (
                "2000-01-01T00:00:00+00:00",
                json.dumps({"entity_id": "run-1", "entity_type": "production_run"}),
            ),
        )
        connection.execute("UPDATE runs SET state = 'published' WHERE id = 'run-1'")


def impact_unit(unit_id: str, revision: str, path: str, digest: str) -> dict[str, str | None]:
    return {
        "id": unit_id,
        "source_id": "docs",
        "revision": revision,
        "path": path,
        "kind": "file",
        "digest": digest,
        "label": None,
    }


def source_unit(unit_id: str, revision: str, path: str, digest: str) -> dict[str, str]:
    return {
        "source_id": "docs",
        "revision": revision,
        "path": path,
        "source_unit": unit_id,
        "source_unit_kind": "file",
        "content_digest": digest,
    }


def seed_incremental_impact(database: Path) -> None:
    VerificationStore(database)
    old_revision = "a" * 40
    new_revision = "b" * 40
    old_digest = "1" * 64
    new_digest = "2" * 64
    stable_digest = "3" * 64
    base_source_set = {
        "source_universe": [
            source_unit("file:changed", old_revision, "changed.md", old_digest),
            source_unit("file:moved", old_revision, "old.md", stable_digest),
            source_unit("file:removed", old_revision, "removed.md", old_digest),
            source_unit("file:stable", old_revision, "stable.md", stable_digest),
        ]
    }
    refresh = {
        "mode": "incremental",
        "fallback_reason": None,
        "new_source_units": ["file:added"],
        "reverify_claims": [AFFECTED_CLAIM],
        "reverify_concepts": [AFFECTED_CONCEPT],
        "rerender_pages": ["concepts/affected.md"],
        "relocations": {"file:moved": "file:moved-new"},
        "diff": {
            "added": [impact_unit("file:added", new_revision, "added.md", new_digest)],
            "changed": [
                {
                    "kind": "changed",
                    "before": impact_unit("file:changed", old_revision, "changed.md", old_digest),
                    "after": impact_unit("file:changed", new_revision, "changed.md", new_digest),
                }
            ],
            "moved": [
                {
                    "kind": "moved",
                    "before": impact_unit("file:moved", old_revision, "old.md", stable_digest),
                    "after": impact_unit("file:moved-new", new_revision, "new.md", stable_digest),
                }
            ],
            "removed": [impact_unit("file:removed", old_revision, "removed.md", old_digest)],
            "by_source": {},
        },
    }
    current_source_set = {
        "base_run_id": "run-base",
        "refresh": refresh,
        "source_universe": [
            source_unit("file:changed", new_revision, "changed.md", new_digest),
            source_unit("file:moved-new", new_revision, "new.md", stable_digest),
            source_unit("file:added", new_revision, "added.md", new_digest),
            source_unit("file:stable", new_revision, "stable.md", stable_digest),
        ],
    }
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'project-1', '.', ?, '.', '.', ?, ?, ?, ?)""",
            [
                (
                    "run-base",
                    old_revision,
                    "published",
                    json.dumps(base_source_set),
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
                (
                    "run-2",
                    new_revision,
                    "exploring",
                    json.dumps(current_source_set),
                    "2026-07-13T01:00:00+00:00",
                    "2026-07-13T01:00:00+00:00",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO accepted_evidence VALUES (?, ?, 'docs', ?, ?, ?, 1, 2, ?, 'direct', 'primary')",
            [
                (
                    "run-base",
                    AFFECTED_EVIDENCE,
                    old_revision,
                    "changed.md",
                    "file:changed",
                    f"sha256:{old_digest}",
                ),
                (
                    "run-base",
                    STABLE_EVIDENCE,
                    old_revision,
                    "stable.md",
                    "file:stable",
                    f"sha256:{stable_digest}",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO accepted_claims VALUES (?, ?, '', '', ?, 'must', '[]', 'supported')",
            [
                ("run-base", AFFECTED_CLAIM, "Changed behavior."),
                ("run-base", STABLE_CLAIM, "Stable behavior."),
            ],
        )
        connection.executemany(
            "INSERT INTO claim_evidence VALUES ('run-base', ?, ?)",
            [
                (AFFECTED_CLAIM, AFFECTED_EVIDENCE),
                (STABLE_CLAIM, STABLE_EVIDENCE),
            ],
        )
        connection.executemany(
            "INSERT INTO accepted_concepts VALUES ('run-base', ?, ?, '[]', '', 'active')",
            [
                (AFFECTED_CONCEPT, "Affected Concept"),
                (STABLE_CONCEPT, "Stable Concept"),
            ],
        )
        connection.executemany(
            "INSERT INTO concept_claims VALUES ('run-base', ?, ?, 'defining')",
            [
                (AFFECTED_CONCEPT, AFFECTED_CLAIM),
                (STABLE_CONCEPT, STABLE_CLAIM),
            ],
        )
        connection.executemany(
            "INSERT INTO page_plans VALUES ('run-base', ?, ?, ?)",
            [
                (AFFECTED_CONCEPT, "concepts/affected.md", "Affected Concept"),
                (STABLE_CONCEPT, "concepts/stable.md", "Stable Concept"),
            ],
        )


def test_replay_uses_persisted_sequence_and_timestamps_without_model_reasoning(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_replay_events(database)

    first = ConceptProvenanceStore(database).replay("run-1")
    restarted = ConceptProvenanceStore(database).replay("run-1")

    assert restarted == first
    assert [event["sequence"] for event in first["events"]] == sorted(
        event["sequence"] for event in first["events"]
    )
    assert first["events"][-1]["occurred_at"] == "2000-01-01T00:00:00+00:00"
    assert {event["stage"] for event in first["events"]} == {
        "proposed",
        "verified",
        "accepted",
        "rejected",
        "stale",
        "published",
    }
    assert "invent" not in json.dumps(first)


def test_replay_exposes_persisted_incremental_changes_affected_relations_and_stable_knowledge(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)

    replay = ConceptProvenanceStore(database).replay("run-2", impact_limit=50)
    impact = replay["impact"]

    assert impact["mode"] == "incremental"
    assert impact["fallback_reason"] is None
    assert impact["summary"]["changes"] == {
        "added": 1,
        "changed": 1,
        "moved": 1,
        "removed": 1,
    }
    assert {(node["type"], node["entity_id"], node["status"]) for node in impact["nodes"]} >= {
        ("source_unit", "file:added", "added"),
        ("source_unit", "file:changed", "changed"),
        ("source_unit", "file:moved-new", "moved"),
        ("source_unit", "file:removed", "removed"),
        ("evidence", AFFECTED_EVIDENCE, "affected"),
        ("claim", AFFECTED_CLAIM, "affected"),
        ("concept", AFFECTED_CONCEPT, "affected"),
        ("page", "concepts/affected.md", "affected"),
        ("claim", STABLE_CLAIM, "stable"),
        ("concept", STABLE_CONCEPT, "stable"),
        ("page", "concepts/stable.md", "stable"),
    }
    changed = next(node for node in impact["nodes"] if node["status"] == "changed")
    assert changed["before"]["digest"] == f"sha256:{'1' * 64}"
    assert changed["after"]["digest"] == f"sha256:{'2' * 64}"
    assert {(edge["source"], edge["relation"], edge["target"]) for edge in impact["edges"]} >= {
        (
            "source-unit:changed:file:changed",
            "contains",
            AFFECTED_EVIDENCE,
        ),
        (AFFECTED_EVIDENCE, "grounds", AFFECTED_CLAIM),
        (AFFECTED_CLAIM, "forms", AFFECTED_CONCEPT),
        (AFFECTED_CONCEPT, "renders", "page:concepts/affected.md"),
    }


def test_replay_paths_follow_moved_base_and_added_current_source_units(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    with sqlite3.connect(database) as connection:
        connection.executemany(
            "INSERT INTO accepted_evidence VALUES (?, ?, 'docs', ?, ?, ?, 1, 2, ?, 'direct', 'primary')",
            [
                (
                    "run-base",
                    MOVED_EVIDENCE,
                    "a" * 40,
                    "old.md",
                    "file:moved",
                    f"sha256:{'3' * 64}",
                ),
                (
                    "run-2",
                    ADDED_EVIDENCE,
                    "b" * 40,
                    "added.md",
                    "file:added",
                    f"sha256:{'2' * 64}",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO accepted_claims VALUES (?, ?, '', '', ?, 'must', '[]', 'supported')",
            [
                ("run-base", MOVED_CLAIM, "Moved behavior remains stable."),
                ("run-2", ADDED_CLAIM, "Added behavior."),
            ],
        )
        connection.executemany(
            "INSERT INTO claim_evidence VALUES (?, ?, ?)",
            [
                ("run-base", MOVED_CLAIM, MOVED_EVIDENCE),
                ("run-2", ADDED_CLAIM, ADDED_EVIDENCE),
            ],
        )
        connection.executemany(
            "INSERT INTO accepted_concepts VALUES (?, ?, ?, '[]', '', 'active')",
            [
                ("run-base", MOVED_CONCEPT, "Moved Concept"),
                ("run-2", ADDED_CONCEPT, "Added Concept"),
            ],
        )
        connection.executemany(
            "INSERT INTO concept_claims VALUES (?, ?, ?, 'defining')",
            [
                ("run-base", MOVED_CONCEPT, MOVED_CLAIM),
                ("run-2", ADDED_CONCEPT, ADDED_CLAIM),
            ],
        )
        connection.executemany(
            "INSERT INTO page_plans VALUES (?, ?, ?, ?)",
            [
                ("run-base", MOVED_CONCEPT, "concepts/moved.md", "Moved Concept"),
                ("run-2", ADDED_CONCEPT, "concepts/added.md", "Added Concept"),
            ],
        )

    impact = ConceptProvenanceStore(database).replay("run-2", impact_limit=50, path_limit=50)[
        "impact"
    ]
    paths = {path["source"]["id"]: path for path in impact["paths"]}

    moved = paths["source-unit:moved:file:moved-new"]
    assert [
        moved[stage]["entity_id"] for stage in ("source", "evidence", "claim", "concept", "page")
    ] == [
        "file:moved-new",
        MOVED_EVIDENCE,
        MOVED_CLAIM,
        MOVED_CONCEPT,
        "concepts/moved.md",
    ]
    assert [moved[stage]["status"] for stage in ("evidence", "claim", "concept", "page")] == [
        "stable",
        "stable",
        "stable",
        "stable",
    ]
    added = paths["source-unit:added:file:added"]
    assert [
        added[stage]["entity_id"] for stage in ("source", "evidence", "claim", "concept", "page")
    ] == [
        "file:added",
        ADDED_EVIDENCE,
        ADDED_CLAIM,
        ADDED_CONCEPT,
        "concepts/added.md",
    ]
    assert [added[stage]["status"] for stage in ("evidence", "claim", "concept", "page")] == [
        "affected",
        "affected",
        "affected",
        "affected",
    ]
    assert impact["summary"]["affected"] == {
        "evidence": 2,
        "claims": 2,
        "concepts": 2,
        "pages": 2,
    }
    assert {(node["type"], node["entity_id"], node["status"]) for node in impact["nodes"]} >= {
        ("evidence", ADDED_EVIDENCE, "affected"),
        ("claim", ADDED_CLAIM, "affected"),
        ("concept", ADDED_CONCEPT, "affected"),
        ("page", "concepts/added.md", "affected"),
    }
    assert (
        next(node for node in impact["nodes"] if node["entity_id"] == MOVED_CLAIM)["status"]
        == "stable"
    )


def test_replay_paginates_events_and_impact_without_dangling_edges(tmp_path: Path) -> None:
    event_database = tmp_path / "events.db"
    seed_replay_events(event_database)
    with sqlite3.connect(event_database) as connection:
        connection.executemany(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('run-1', 'supported', 'supported', ?, ?)""",
            [
                (
                    f"2026-07-13T02:{index // 60:02d}:{index % 60:02d}+00:00",
                    json.dumps({"entity_id": f"claim:{index}", "entity_type": "claim"}),
                )
                for index in range(120)
            ],
        )
    store = ConceptProvenanceStore(event_database)
    first = store.replay("run-1", event_limit=25)
    second = store.replay("run-1", event_limit=25, event_offset=25)

    assert first["event_bounds"] == {
        "limit": 25,
        "offset": 0,
        "previous_offset": None,
        "next_offset": 25,
        "total": 128,
        "truncated": True,
    }
    assert second["event_bounds"]["previous_offset"] == 0
    assert {event["sequence"] for event in first["events"]}.isdisjoint(
        event["sequence"] for event in second["events"]
    )
    with pytest.raises(ValueError, match="event_limit must be between"):
        store.replay("run-1", event_limit=101)

    impact_database = tmp_path / "impact.db"
    seed_incremental_impact(impact_database)
    impact_store = ConceptProvenanceStore(impact_database)
    impact_first = impact_store.replay("run-2", impact_limit=5)["impact"]
    impact_second = impact_store.replay("run-2", impact_limit=5, impact_offset=5)["impact"]

    assert impact_first["bounds"]["next_offset"] == 5
    assert impact_second["bounds"]["previous_offset"] == 0
    assert {node["id"] for node in impact_first["nodes"]}.isdisjoint(
        node["id"] for node in impact_second["nodes"]
    )
    assert all(
        edge["source"] in {node["id"] for node in page["nodes"]}
        and edge["target"] in {node["id"] for node in page["nodes"]}
        for page in (impact_first, impact_second)
        for edge in page["edges"]
    )
    with pytest.raises(ValueError, match="impact_offset must be non-negative"):
        impact_store.replay("run-2", impact_offset=-1)


def test_replay_preserves_persisted_full_analysis_reason(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-2'").fetchone()[0]
        )
        source_set["refresh"]["mode"] = "full"
        source_set["refresh"]["fallback_reason"] = "Source Unit relocation is ambiguous"
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-2'",
            (json.dumps(source_set),),
        )

    impact = ConceptProvenanceStore(database).replay("run-2")["impact"]

    assert impact["mode"] == "full"
    assert impact["fallback_reason"] == "Source Unit relocation is ambiguous"
    assert impact["summary"]["affected"] == {
        "evidence": 2,
        "claims": 2,
        "concepts": 2,
        "pages": 2,
    }
    assert impact["summary"]["stable"] == {
        "evidence": 0,
        "claims": 0,
        "concepts": 0,
        "pages": 0,
    }


def test_full_analysis_without_fallback_does_not_claim_stable_knowledge(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-2'").fetchone()[0]
        )
        source_set["refresh"]["mode"] = "full"
        source_set["refresh"]["fallback_reason"] = None
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-2'",
            (json.dumps(source_set),),
        )

    impact = ConceptProvenanceStore(database).replay("run-2")["impact"]

    assert impact["summary"]["affected"] == {
        "evidence": 2,
        "claims": 2,
        "concepts": 2,
        "pages": 2,
    }
    assert impact["summary"]["stable"] == {
        "evidence": 0,
        "claims": 0,
        "concepts": 0,
        "pages": 0,
    }
    assert all(
        node["status"] == "affected" for node in impact["nodes"] if node["type"] != "source_unit"
    )


def test_replay_bounds_transport_labels_and_fallback_reason(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    long_text = "🧠" * 2_001
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-2'").fetchone()[0]
        )
        source_set["refresh"]["mode"] = "full"
        source_set["refresh"]["fallback_reason"] = long_text
        source_set["refresh"]["diff"]["changed"][0]["before"]["label"] = long_text
        source_set["refresh"]["diff"]["changed"][0]["after"]["label"] = long_text
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-2'",
            (json.dumps(source_set),),
        )
        connection.execute(
            "UPDATE accepted_claims SET statement = ? WHERE id = ?",
            (long_text, AFFECTED_CLAIM),
        )
        connection.execute(
            "UPDATE accepted_concepts SET canonical_name = ? WHERE id = ?",
            (long_text, AFFECTED_CONCEPT),
        )
        connection.execute(
            "UPDATE page_plans SET title = ? WHERE concept_id = ?",
            (long_text, AFFECTED_CONCEPT),
        )
        append_entity_event(
            connection,
            "run-base",
            "claim",
            AFFECTED_CLAIM,
            None,
            "supported",
            candidate_id="candidate-long-label",
        )

    replay = ConceptProvenanceStore(database).replay("run-2", impact_limit=50, path_limit=50)
    labels = [event["entity_label"] for event in replay["events"]]
    labels.extend(node["label"] for node in replay["impact"]["nodes"])
    labels.extend(
        path[stage]["label"]
        for path in replay["impact"]["paths"]
        for stage in ("source", "evidence", "claim", "concept", "page")
    )

    assert replay["impact"]["fallback_reason"] == long_text[:2_000]
    assert long_text[:2_000] in labels
    assert all(0 < len(label) <= 2_000 for label in labels)
    changed = next(node for node in replay["impact"]["nodes"] if node["status"] == "changed")
    assert changed["label"] == long_text[:2_000]
    assert changed["before"]["label"] == changed["after"]["label"] == long_text[:2_000]


def test_proposed_event_and_candidate_are_committed_atomically(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    store = VerificationStore(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                created_at, updated_at)
               VALUES ('run-1', 'project-1', '.', ?, '.', '.', 'verifying', ?, ?)""",
            ("a" * 40, "2026-07-13T00:00:00+00:00", "2026-07-13T00:00:00+00:00"),
        )
        connection.execute(
            """CREATE TRIGGER reject_proposed_event BEFORE INSERT ON run_events
               WHEN NEW.state = 'staged'
               BEGIN SELECT RAISE(ABORT, 'seeded proposed event failure'); END"""
        )

    with pytest.raises(sqlite3.IntegrityError, match="seeded proposed event failure"):
        store.stage("run-1", "candidate-1", "task-1", {})

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT 1 FROM verification_candidates").fetchone() is None
        assert connection.execute("SELECT 1 FROM run_events").fetchone() is None


def test_workspace_rebuilds_bounded_replay_from_its_database(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("project-1")
    seed_incremental_impact(application.database_path)

    first = application.concept_replay(event_limit=20, impact_limit=5)
    restarted = WorkspaceApplication(workspace).concept_replay(
        run_id="run-2", event_limit=20, impact_limit=5
    )

    assert restarted == first
    assert first["run_id"] == "run-2"
    assert len(first["impact"]["nodes"]) == 5
    with pytest.raises(WorkspaceError, match="impact_limit must be between"):
        application.concept_replay(impact_limit=0)


def test_empty_workspace_replay_preserves_requested_bounds(tmp_path: Path) -> None:
    application = WorkspaceApplication(tmp_path / "workspace")
    application.initialize("project-1")

    replay = application.concept_replay(
        event_limit=25,
        event_offset=50,
        impact_limit=50,
        impact_offset=100,
        path_limit=25,
        path_offset=50,
    )

    assert replay["event_bounds"] == {
        "limit": 25,
        "offset": 50,
        "previous_offset": 25,
        "next_offset": None,
        "total": 0,
        "truncated": True,
    }
    assert replay["impact"]["bounds"]["previous_offset"] == 50
    assert replay["impact"]["bounds"]["truncated"] is True
    assert replay["impact"]["path_bounds"]["previous_offset"] == 25
    assert replay["impact"]["path_bounds"]["truncated"] is True


def test_replay_locates_an_event_or_entity_across_server_pages(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_replay_events(database)
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('run-1', 'supported', 'supported', ?, ?)""",
            [
                (
                    f"2026-07-13T03:{index // 60:02d}:{index % 60:02d}+00:00",
                    json.dumps(
                        {
                            "entity_id": "claim:target" if index == 77 else f"claim:{index}",
                            "entity_type": "claim",
                        }
                    ),
                )
                for index in range(120)
            ],
        )
        target_sequence = connection.execute(
            """SELECT sequence FROM run_events
               WHERE json_extract(details, '$.entity_id') = 'claim:target'"""
        ).fetchone()[0]
    store = ConceptProvenanceStore(database)

    by_sequence = store.replay("run-1", event_limit=10, event_sequence=target_sequence)
    by_entity = store.replay("run-1", event_limit=10, entity_type="claim", entity_id="claim:target")

    for located in (by_sequence, by_entity):
        assert located["located_event_sequence"] == target_sequence
        assert located["event_bounds"]["offset"] > 0
        assert target_sequence in {event["sequence"] for event in located["events"]}


def test_replay_entity_locator_uses_type_and_id_as_one_identity(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_replay_events(database)
    with sqlite3.connect(database) as connection:
        append_entity_event(
            connection,
            "run-1",
            "verification_candidate",
            "run-1",
            None,
            "staged",
            candidate_id="run-1",
        )
        candidate_sequence = connection.execute(
            """SELECT sequence FROM run_events
               WHERE json_extract(details, '$.entity_type') = 'verification_candidate'
                 AND json_extract(details, '$.entity_id') = 'run-1'"""
        ).fetchone()[0]
        run_sequence = connection.execute(
            """SELECT sequence FROM run_events
               WHERE json_extract(details, '$.entity_type') = 'production_run'
                 AND json_extract(details, '$.entity_id') = 'run-1'"""
        ).fetchone()[0]
    store = ConceptProvenanceStore(database)

    candidate = store.replay(
        "run-1",
        event_limit=10,
        entity_type="verification_candidate",
        entity_id="run-1",
    )
    production_run = store.replay(
        "run-1", event_limit=10, entity_type="production_run", entity_id="run-1"
    )

    assert candidate["located_event_sequence"] == candidate_sequence
    assert production_run["located_event_sequence"] == run_sequence
    with pytest.raises(ValueError, match="both entity_type and entity_id"):
        store.replay("run-1", entity_id="run-1")
    with pytest.raises(ValueError, match="either event_sequence or an entity locator"):
        store.replay(
            "run-1",
            event_sequence=run_sequence,
            entity_type="production_run",
            entity_id="run-1",
        )


def test_replay_event_page_has_a_bounded_memory_cost_for_large_histories(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_replay_events(database)
    detail = "x" * 512
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('run-1', 'supported', 'supported', ?, ?)""",
            [
                (
                    "2026-07-13T04:00:00+00:00",
                    json.dumps(
                        {
                            "entity_id": f"claim:{index}",
                            "entity_type": "claim",
                            "padding": detail,
                        }
                    ),
                )
                for index in range(25_000)
            ],
        )

    tracemalloc.start()
    replay = ConceptProvenanceStore(database).replay("run-1", event_limit=10)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(replay["events"]) == 10
    assert replay["event_bounds"]["total"] == 25_008
    assert peak < 4_000_000


def test_impact_paths_keep_complete_propagation_visible_across_bounded_pages(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    second_evidence = f"evidence:{'6' * 64}"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """INSERT INTO accepted_evidence
               VALUES ('run-base', ?, 'docs', ?, 'changed.md', 'file:changed',
                       5, 6, ?, 'direct', 'primary')""",
            (second_evidence, "a" * 40, "sha256:" + "6" * 64),
        )
        connection.execute(
            "INSERT INTO claim_evidence VALUES ('run-base', ?, ?)",
            (AFFECTED_CLAIM, second_evidence),
        )
    store = ConceptProvenanceStore(database)

    first = store.replay("run-2", impact_limit=1, path_limit=1)["impact"]
    second = store.replay("run-2", impact_limit=1, path_limit=1, path_offset=1)["impact"]

    assert first["edges"] == []
    assert first["path_bounds"]["total"] == 2
    assert first["path_bounds"]["next_offset"] == 1
    assert second["path_bounds"]["previous_offset"] == 0
    assert {path["evidence"]["id"] for path in first["paths"]}.isdisjoint(
        path["evidence"]["id"] for path in second["paths"]
    )
    for page in (first, second):
        assert len(page["paths"]) == 1
        path = page["paths"][0]
        assert [
            path[stage]["type"] for stage in ("source", "evidence", "claim", "concept", "page")
        ] == ["source_unit", "evidence", "claim", "concept", "page"]


def test_impact_node_page_has_a_bounded_memory_cost_for_large_knowledge_models(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    statement = "Stable behavior " + "x" * 256
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """INSERT INTO accepted_claims
               VALUES ('run-base', ?, '', '', ?, 'must', '[]', 'supported')""",
            [(f"claim:{index:064x}", statement) for index in range(5_000)],
        )

    tracemalloc.start()
    impact = ConceptProvenanceStore(database).replay("run-2", impact_limit=10)["impact"]
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(impact["nodes"]) == 10
    assert impact["bounds"]["total_nodes"] == 5_012
    assert peak < 4_000_000


@pytest.mark.skipif(sys.platform != "linux", reason="VmHWM is available on Linux")
def test_impact_change_page_has_a_bounded_process_memory_cost_for_large_source_diffs(
    tmp_path: Path,
) -> None:
    child = """
import json
import sys
import time
from pathlib import Path

from okf_wiki.provenance import ConceptProvenanceStore

started = time.perf_counter()
impact = ConceptProvenanceStore(Path(sys.argv[1])).replay(
    "run-2", impact_limit=1, path_limit=1
)["impact"]
print(json.dumps({
    "added": impact["summary"]["changes"]["added"],
    "nodes": len(impact["nodes"]),
    "peak_rss_kib": int(next(
        line.split()[1]
        for line in Path("/proc/self/status").read_text().splitlines()
        if line.startswith("VmHWM:")
    )),
    "seconds": time.perf_counter() - started,
}))
"""
    results = {}
    for count in (1_000, 20_000, 40_000):
        database = tmp_path / f"runs-{count}.db"
        seed_incremental_impact(database)
        with sqlite3.connect(database) as connection:
            source_set = json.loads(
                connection.execute(
                    "SELECT source_set_json FROM runs WHERE id = 'run-2'"
                ).fetchone()[0]
            )
            source_set["refresh"]["diff"] = {
                "added": [
                    impact_unit(
                        f"file:added-{index}",
                        "b" * 40,
                        f"added/{index}.md",
                        f"{index:064x}",
                    )
                    for index in range(count)
                ],
                "changed": [],
                "moved": [],
                "removed": [],
                "by_source": {},
            }
            connection.execute(
                "UPDATE runs SET source_set_json = ? WHERE id = 'run-2'",
                (json.dumps(source_set),),
            )
        completed = subprocess.run(
            [sys.executable, "-c", child, str(database)],
            check=True,
            capture_output=True,
            text=True,
        )
        results[count] = json.loads(completed.stdout)

    assert results[40_000]["added"] == 40_000
    assert results[40_000]["nodes"] == 1
    assert results[20_000]["peak_rss_kib"] - results[1_000]["peak_rss_kib"] < 10 * 1024
    assert results[40_000]["peak_rss_kib"] - results[20_000]["peak_rss_kib"] < 4 * 1024
    assert results[40_000]["seconds"] < 1


def test_replay_treats_malformed_source_set_json_as_bounded_empty_impact(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    seed_incremental_impact(database)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE runs SET source_set_json = '{malformed' WHERE id = 'run-2'")

    replay = ConceptProvenanceStore(database).replay("run-2", impact_limit=1, path_limit=1)

    assert replay["lineage_run_ids"] == ["run-2"]
    assert replay["impact"]["summary"]["changes"] == {
        "added": 0,
        "changed": 0,
        "moved": 0,
        "removed": 0,
    }


def test_replay_marks_runs_that_predate_persisted_impact_tracking(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    with sqlite3.connect(database) as connection:
        migrate_state(connection, MIGRATIONS[:-1])
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES ('legacy', 'project-1', '.', ?, '.', '.', 'published', ?, ?, ?)""",
            (
                "a" * 40,
                json.dumps(
                    {
                        "refresh": {
                            "mode": "incremental",
                            "diff": {
                                "added": [
                                    impact_unit(
                                        "file:legacy",
                                        "a" * 40,
                                        "legacy.md",
                                        "1" * 64,
                                    )
                                ]
                            },
                        }
                    }
                ),
                "2026-07-13T00:00:00+00:00",
                "2026-07-13T00:00:00+00:00",
            ),
        )

    replay = ConceptProvenanceStore(database).replay("legacy")

    assert replay["lineage_run_ids"] == ["legacy"]
    assert replay["impact"]["mode"] == "full"
    assert replay["impact"]["fallback_reason"] == "Run predates persisted impact tracking"
    assert replay["impact"]["summary"]["changes"] == {
        "added": 0,
        "changed": 0,
        "moved": 0,
        "removed": 0,
    }


def test_workspace_rejects_overlong_run_lineage_without_recursion(tmp_path: Path) -> None:
    application = WorkspaceApplication(tmp_path / "workspace")
    application.initialize("project-1")
    with sqlite3.connect(application.database_path) as connection:
        connection.executemany(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'project-1', '.', ?, '.', '.', 'published', ?, ?, ?)""",
            [
                (
                    f"run-{index}",
                    f"{index:040x}"[-40:],
                    json.dumps({"base_run_id": f"run-{index - 1}"}) if index else "{}",
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                )
                for index in range(1_100)
            ],
        )

    with pytest.raises(WorkspaceError, match="lineage exceeds"):
        application.concept_replay(run_id="run-1099")


def test_workspace_rejects_a_run_lineage_cycle(tmp_path: Path) -> None:
    application = WorkspaceApplication(tmp_path / "workspace")
    application.initialize("project-1")
    with sqlite3.connect(application.database_path) as connection:
        connection.executemany(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'project-1', '.', ?, '.', '.', 'published', ?, ?, ?)""",
            [
                (
                    "run-a",
                    "a" * 40,
                    json.dumps({"base_run_id": "run-b"}),
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
                (
                    "run-b",
                    "b" * 40,
                    json.dumps({"base_run_id": "run-a"}),
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
            ],
        )

    with pytest.raises(WorkspaceError, match="lineage contains a cycle"):
        application.concept_replay(run_id="run-a")
