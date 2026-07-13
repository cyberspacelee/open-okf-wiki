import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore
from okf_wiki.knowledge_contracts import WorkerProposal, WorkerRunResult
from okf_wiki.provenance import ConceptProvenanceStore
from okf_wiki.run_events import append_entity_event
from okf_wiki.verification import (
    REQUIRED_PERSPECTIVES,
    AcceptanceDecision,
    VerificationFinding,
    VerificationStore,
)
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


def build_run(database: Path) -> tuple[str, str]:
    knowledge = AcceptedKnowledgeStore(database)
    revision = "a" * 40
    source_set = {
        "digest": "source-set-1",
        "sources": [
            {
                "id": "docs",
                "revision": revision,
                "role": "documentation",
                "repository": ".",
                "tree_digest": "sha256:" + "1" * 64,
            }
        ],
        "source_universe": [
            {
                "source_id": "docs",
                "revision": revision,
                "path": "guide.md",
                "source_unit": "file:guide.md",
                "source_unit_kind": "file",
                "digest": "sha256:" + "1" * 64,
            }
        ],
    }
    with sqlite3.connect(database) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES ('run-1', 'project-1', '.', ?, '.', '.', 'verifying', ?, ?, ?)""",
            (
                revision,
                json.dumps(source_set),
                "2026-07-13T00:00:00+00:00",
                "2026-07-13T00:00:00+00:00",
            ),
        )
        connection.execute(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text, details)
               VALUES ('obligation-1', 'run-1', 'docs', 'documentation', 'guide.md',
                       'file:guide.md', 'document', 'major', 'open', NULL, '{}', 'Guide', '{}')"""
        )
        connection.execute(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text, details)
               VALUES ('obligation-blocked', 'run-1', 'docs', 'documentation', 'guide.md',
                       'file:guide.md', 'document', 'supporting', 'blocked', 'Missing input',
                       '{}', 'Blocked guide', '{}')"""
        )
        append_entity_event(
            connection,
            "run-1",
            "coverage_obligation",
            "obligation-blocked",
            "open",
            "blocked",
        )

    verification = VerificationStore(database)
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "task-1",
            "obligation_ids": ["obligation-1"],
            "evidence": [
                {
                    "id": "evidence-a",
                    "source_id": "docs",
                    "path": "guide.md",
                    "revision": revision,
                    "start_line": 3,
                    "end_line": 4,
                    "digest": f"sha256:{hashlib.sha256(b'defining').hexdigest()}",
                },
                {
                    "id": "evidence-b",
                    "source_id": "docs",
                    "path": "guide.md",
                    "revision": revision,
                    "start_line": 8,
                    "end_line": 8,
                    "digest": f"sha256:{hashlib.sha256(b'supporting').hexdigest()}",
                },
            ],
            "claims": [
                {
                    "id": "claim-a",
                    "text": "A Workspace represents one product.",
                    "evidence_ids": ["evidence-a"],
                },
                {
                    "id": "claim-b",
                    "text": "A Workspace can include documentation.",
                    "epistemic_status": "disputed",
                    "conflicts_with": ["claim-a"],
                    "supersedes": ["claim-a"],
                    "evidence_ids": ["evidence-b"],
                },
            ],
            "concepts": [
                {
                    "id": "concept-a",
                    "name": "Workspace",
                    "description": "One product knowledge scope.",
                    "claim_ids": ["claim-a", "claim-b"],
                    "defining_claim_ids": ["claim-a"],
                    "supporting_claim_ids": ["claim-b"],
                    "status": "active",
                }
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": "obligation-1",
                    "disposition": "covered",
                    "reason": "Accepted claims cover it.",
                    "evidence_ids": ["evidence-a"],
                }
            ],
        }
    )
    candidate = WorkerRunResult(
        status="accepted", candidate_id="candidate-accepted", proposal=proposal, errors=[]
    )
    verification.stage("run-1", "candidate-accepted", "task-1", proposal.model_dump(mode="json"))
    findings = tuple(
        VerificationFinding(
            target_id="candidate-accepted",
            perspective=perspective,
            verdict="pass",
            severity="info",
            evidence=("evidence-a",),
            rationale=f"{perspective} passed",
        )
        for perspective in REQUIRED_PERSPECTIVES
    )
    verification.record_findings("run-1", "candidate-accepted", findings)
    verification.record_decision(
        "run-1", "candidate-accepted", AcceptanceDecision(outcome="accepted")
    )
    receipt = knowledge.accept("run-1", candidate)
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-1'").fetchone()[0]
        )
        page = connection.execute(
            "SELECT path FROM page_plans WHERE run_id = 'run-1' AND concept_id = ?",
            (receipt.concept_ids[0],),
        ).fetchone()[0]
        source_set["bundle_manifest"] = {page: "3" * 64}
        connection.execute(
            "UPDATE runs SET state = 'review_required', source_set_json = ? WHERE id = 'run-1'",
            (json.dumps(source_set),),
        )

    verification.stage(
        "run-1",
        "candidate-rejected",
        "task-2",
        proposal.model_dump(mode="json"),
    )
    verification.record_findings(
        "run-1",
        "candidate-rejected",
        (
            VerificationFinding(
                target_id="concept-a",
                target_type="concept",
                perspective="contradiction",
                verdict="fail",
                severity="critical",
                evidence=("evidence-a",),
                rationale="The rejected candidate contradicted accepted knowledge.",
            ),
        ),
    )
    verification.record_decision(
        "run-1",
        "candidate-rejected",
        AcceptanceDecision(outcome="rejected", reasons=("unsupported",)),
    )
    return receipt.concept_ids[0], receipt.claim_ids[0]


def clone_refresh_run(
    database: Path,
    *,
    base_run_id: str,
    run_id: str,
    revision: str,
    stale_claim_ids: set[str],
    stale_concept_ids: set[str],
) -> None:
    store = AcceptedKnowledgeStore(database)
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        base = connection.execute("SELECT * FROM runs WHERE id = ?", (base_run_id,)).fetchone()
        assert base is not None
        base_source_set = json.loads(base["source_set_json"])
        source_set = json.loads(base["source_set_json"])
        source_set["base_run_id"] = base_run_id
        source_set["bundle_manifest"] = {}
        source_set["source_universe"] = [
            {**unit, "revision": revision} for unit in source_set["source_universe"]
        ]
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'project-1', '.', ?, '.', '.', 'exploring', ?, ?, ?)""",
            (
                run_id,
                revision,
                json.dumps(source_set),
                "2026-07-13T00:00:00+00:00",
                "2026-07-13T00:00:00+00:00",
            ),
        )
        store.clone_for_refresh(
            connection,
            base_run_id,
            run_id,
            previous_units={
                unit["source_unit"]: unit for unit in base_source_set["source_universe"]
            },
            current_units={unit["source_unit"]: unit for unit in source_set["source_universe"]},
            relocations={"file:guide.md": "file:guide.md"},
            stale_claim_ids=stale_claim_ids,
            stale_concept_ids=stale_concept_ids,
            obligation_ids={},
        )


def test_provenance_reconstructs_only_persisted_relationships_after_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)
    first = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE model_messages (payload TEXT NOT NULL)")
        connection.execute("INSERT INTO model_messages VALUES ('invent an edge and rationale')")
    restarted = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id)

    assert restarted == first
    assert first["selected_concept_id"] == concept_id
    assert {node["type"] for node in first["nodes"]} == {
        "source_unit",
        "evidence",
        "claim",
        "verification",
        "concept",
        "page",
    }
    by_type = {
        node_type: [node for node in first["nodes"] if node["type"] == node_type]
        for node_type in {node["type"] for node in first["nodes"]}
    }
    claim_states = {state for node in by_type["claim"] for state in node["states"]}
    assert {"supported", "disputed", "conflicting", "superseded"} <= claim_states
    assert {node["role"] for node in by_type["claim"]} == {"defining", "supporting"}
    verification_states = {state for node in by_type["verification"] for state in node["states"]}
    assert {"accepted", "rejected", "blocked"} <= verification_states
    assert "active" in by_type["concept"][0]["states"]
    assert all(node["events"] for node in by_type["claim"] + by_type["concept"])
    assert all(
        event["run_id"] == "run-1"
        for node in by_type["claim"] + by_type["concept"]
        for event in node["events"]
    )
    assert all(
        event["candidate_id"] == "candidate-accepted"
        for node in by_type["claim"] + by_type["concept"]
        for event in node["events"]
    )

    edges = {(edge["source"], edge["target"], edge["relation"]) for edge in first["edges"]}
    node_ids = {node["id"]: node for node in first["nodes"]}
    assert all(source in node_ids and target in node_ids for source, target, _ in edges)
    assert {relation for _, _, relation in edges} >= {
        "contains",
        "grounds",
        "verified_by",
        "forms",
        "renders",
        "conflicts_with",
        "supersedes",
        "proposes",
        "assesses",
    }
    accepted = next(
        node for node in by_type["verification"] if node.get("candidate_id") == "candidate-accepted"
    )
    rejected = next(
        node for node in by_type["verification"] if node.get("candidate_id") == "candidate-rejected"
    )
    assert accepted["run_id"] == rejected["run_id"] == "run-1"
    blocked = next(node for node in by_type["verification"] if node["decision"] == "blocked")
    assert blocked["obligation_id"] == "obligation-blocked"
    assert blocked["id"] == "verification:run-1:obligation:obligation-blocked"
    assert rejected["metadata"]["findings"][0]["target_id"] == "concept-a"
    assert rejected["metadata"]["findings"][0]["rationale"].startswith("The rejected")
    assert rejected["metadata"]["findings"][0]["evidence"] == ["evidence-a"]
    assert (rejected["id"], concept_id, "proposes") in edges
    assert (rejected["id"], concept_id, "forms") not in edges
    assert (concept_id, rejected["id"], "assesses") in edges

    page = by_type["page"][0]
    assert page["run_id"] == "run-1"
    assert page["revision"] == "a" * 40
    assert page["digest"] == "sha256:" + "3" * 64


def test_refresh_records_only_real_stale_transitions_and_rebuilds_recursive_lineage(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)
    with sqlite3.connect(database) as connection:
        claim_rows = list(
            connection.execute(
                "SELECT id, epistemic_status FROM accepted_claims WHERE run_id = 'run-1'"
            )
        )
    claim_ids = {row[0] for row in claim_rows}
    claim_id, initial_claim_state = next(
        (row[0], row[1]) for row in claim_rows if row[1] == "supported"
    )
    clone_refresh_run(
        database,
        base_run_id="run-1",
        run_id="run-2",
        revision="b" * 40,
        stale_claim_ids=claim_ids,
        stale_concept_ids={concept_id},
    )
    clone_refresh_run(
        database,
        base_run_id="run-2",
        run_id="run-3",
        revision="c" * 40,
        stale_claim_ids=claim_ids,
        stale_concept_ids={concept_id},
    )

    first = ConceptProvenanceStore(database).snapshot("run-3", concept_id=concept_id)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE model_messages (payload TEXT NOT NULL)")
        connection.execute("INSERT INTO model_messages VALUES ('invent hidden reasoning')")
    restarted = ConceptProvenanceStore(database).snapshot("run-3", concept_id=concept_id)

    assert restarted == first
    claim = next(node for node in first["nodes"] if node["id"] == claim_id)
    concept = next(node for node in first["nodes"] if node["id"] == concept_id)
    assert [
        (event["run_id"], event["state"], event["candidate_id"]) for event in claim["events"]
    ] == [
        ("run-1", initial_claim_state, "candidate-accepted"),
        ("run-2", "stale", None),
    ]
    assert [
        (event["run_id"], event["state"], event["candidate_id"]) for event in concept["events"]
    ] == [
        ("run-1", "active", "candidate-accepted"),
        ("run-2", "stale", None),
    ]
    accepted = next(
        node for node in first["nodes"] if node.get("candidate_id") == "candidate-accepted"
    )
    assert accepted["run_id"] == "run-1"
    assert any(
        edge["source"] == accepted["id"]
        and edge["target"] == concept_id
        and edge["relation"] == "forms"
        for edge in first["edges"]
    )
    assert not any(node["type"] == "page" for node in first["nodes"])
    assert not any(edge["relation"] == "renders" for edge in first["edges"])

    with sqlite3.connect(database) as connection:
        events = [
            (row[0], json.loads(row[1]))
            for row in connection.execute(
                "SELECT run_id, details FROM run_events WHERE run_id IN ('run-2', 'run-3')"
            )
        ]
    assert events
    assert all(run_id == "run-2" for run_id, _details in events)
    assert all("candidate_id" not in details for _run_id, details in events)


def test_page_requires_current_manifest_even_when_a_page_plan_exists(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)
    rendered = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id)
    assert any(node["type"] == "page" for node in rendered["nodes"])

    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-1'").fetchone()[0]
        )
        source_set["bundle_manifest"] = {}
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-1'",
            (json.dumps(source_set),),
        )

    planned = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id)
    assert planned["concepts"][0]["page"] is None
    assert not any(node["type"] == "page" for node in planned["nodes"])
    assert not any(edge["relation"] == "renders" for edge in planned["edges"])


def test_entity_and_finding_types_prevent_cross_type_provenance_edges(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    concept_id, claim_id = build_run(database)
    with sqlite3.connect(database) as connection:
        append_entity_event(connection, "run-1", "concept", claim_id, "active", "stale")
        append_entity_event(
            connection,
            "run-1",
            "verification_candidate",
            claim_id,
            "staged",
            "rejected",
        )
        append_entity_event(connection, "run-1", "claim", concept_id, "supported", "stale")
        append_entity_event(
            connection,
            "run-1",
            "verification_candidate",
            concept_id,
            "staged",
            "rejected",
        )
        append_entity_event(
            connection,
            "run-1",
            "claim",
            "candidate-accepted",
            "supported",
            "stale",
        )
        append_entity_event(
            connection,
            "run-1",
            "concept",
            "candidate-accepted",
            "active",
            "stale",
        )
        proposal = connection.execute(
            """SELECT proposal_json FROM verification_candidates
               WHERE run_id = 'run-1' AND candidate_id = 'candidate-rejected'"""
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO verification_candidates
               VALUES ('run-1', 'candidate-wrong-target', 'task-3', ?, 'rejected', ?)""",
            (
                proposal,
                AcceptanceDecision(
                    outcome="rejected", reasons=("wrong target type",)
                ).model_dump_json(),
            ),
        )
        finding = VerificationFinding(
            target_id=concept_id,
            target_type="claim",
            perspective="contradiction",
            verdict="fail",
            severity="critical",
            evidence=("evidence-a",),
            rationale="The ID belongs to a Concept, not a Claim.",
        )
        connection.execute(
            """INSERT INTO verification_findings
               VALUES ('run-1', 'candidate-wrong-target', 'contradiction', ?)""",
            (finding.model_dump_json(),),
        )

    snapshot = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id)
    claim = next(node for node in snapshot["nodes"] if node["id"] == claim_id)
    concept = next(node for node in snapshot["nodes"] if node["id"] == concept_id)
    accepted = next(
        node for node in snapshot["nodes"] if node.get("candidate_id") == "candidate-accepted"
    )
    wrong = next(
        node for node in snapshot["nodes"] if node.get("candidate_id") == "candidate-wrong-target"
    )

    assert {event["entity_type"] for event in claim["events"]} == {"claim"}
    assert {event["entity_type"] for event in concept["events"]} == {"concept"}
    assert {event["entity_type"] for event in accepted["events"]} == {"verification_candidate"}
    assert not any(
        edge["source"] == concept_id
        and edge["target"] == wrong["id"]
        and edge["relation"] == "assesses"
        for edge in snapshot["edges"]
    )


def test_provenance_bounds_nodes_and_edges_without_dangling_edges(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)

    snapshot = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id, limit=5)

    assert len(snapshot["nodes"]) == 5
    assert snapshot["bounds"]["truncated"] is True
    assert snapshot["bounds"]["offset"] == 0
    assert snapshot["bounds"]["next_offset"] == 5
    assert snapshot["bounds"]["previous_offset"] is None
    assert snapshot["bounds"]["filtered_total_nodes"] == snapshot["bounds"]["total_nodes"]
    assert snapshot["bounds"]["filtered_total_edges"] == snapshot["bounds"]["total_edges"]
    node_ids = {node["id"] for node in snapshot["nodes"]}
    assert len(snapshot["edges"]) <= 200
    assert all(
        edge["source"] in node_ids and edge["target"] in node_ids for edge in snapshot["edges"]
    )


def test_provenance_filters_before_paginating_and_all_pages_are_reachable(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)
    extras = [f"claim:{index:064x}" for index in range(220)]
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """INSERT INTO accepted_claims
               VALUES ('run-1', ?, 'source', 'states', ?, 'asserted', '[]', ?)""",
            [
                (
                    claim_id,
                    f"Extra persisted Claim {index}",
                    "disputed" if index % 2 else "supported",
                )
                for index, claim_id in enumerate(extras)
            ],
        )
        connection.executemany(
            "INSERT INTO concept_claims VALUES ('run-1', ?, ?, 'supporting')",
            [(concept_id, claim_id) for claim_id in extras],
        )

    store = ConceptProvenanceStore(database)
    first = store.snapshot("run-1", concept_id=concept_id, limit=100, node_types=("claim",))
    second = store.snapshot(
        "run-1", concept_id=concept_id, limit=100, offset=100, node_types=("claim",)
    )
    third = store.snapshot(
        "run-1", concept_id=concept_id, limit=100, offset=200, node_types=("claim",)
    )
    blocked = store.snapshot("run-1", concept_id=concept_id, limit=1, states=("blocked",))

    assert [len(page["nodes"]) for page in (first, second, third)] == [100, 100, 22]
    assert all(node["type"] == "claim" for page in (first, second, third) for node in page["nodes"])
    assert len({node["id"] for page in (first, second, third) for node in page["nodes"]}) == 222
    assert first["bounds"] == {
        "limit": 100,
        "offset": 0,
        "previous_offset": None,
        "next_offset": 100,
        "total_nodes": first["bounds"]["total_nodes"],
        "total_edges": first["bounds"]["total_edges"],
        "filtered_total_nodes": 222,
        "filtered_total_edges": 2,
        "truncated": True,
    }
    assert second["bounds"]["previous_offset"] == 0
    assert second["bounds"]["next_offset"] == 200
    assert third["bounds"]["previous_offset"] == 100
    assert third["bounds"]["next_offset"] is None
    assert blocked["nodes"][0]["states"] == ["blocked"]
    assert blocked["bounds"]["filtered_total_nodes"] == 1
    assert all(
        len(page["nodes"]) <= 200 and len(page["edges"]) <= 200
        for page in (first, second, third, blocked)
    )
    assert all(
        edge["source"] in {node["id"] for node in page["nodes"]}
        and edge["target"] in {node["id"] for node in page["nodes"]}
        for page in (first, second, third, blocked)
        for edge in page["edges"]
    )


def test_workspace_application_rebuilds_provenance_from_its_database(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("project-1")
    concept_id, _ = build_run(application.database_path)

    first = application.concept_provenance(concept_id=concept_id, limit=20)
    restarted = WorkspaceApplication(workspace).concept_provenance(
        run_id="run-1", concept_id=concept_id, limit=20
    )
    status = WorkspaceApplication(workspace).run_status("run-1")

    assert restarted == first
    assert first["run_id"] == "run-1"
    assert status["events"] == []
    assert {
        event["entity_type"]
        for event in status["entity_events"]
        if event.get("candidate_id") == "candidate-accepted"
    } >= {"claim", "concept", "verification_candidate"}


def test_empty_workspace_still_enforces_provenance_bounds(tmp_path: Path) -> None:
    application = WorkspaceApplication(tmp_path / "workspace")
    application.initialize("project-1")

    with pytest.raises(WorkspaceError, match="limit must be between"):
        application.concept_provenance(limit=0)

    with pytest.raises(WorkspaceError, match="offset must be non-negative"):
        application.concept_provenance(offset=-1)

    with pytest.raises(WorkspaceError, match="Unknown provenance node type"):
        application.concept_provenance(node_types=("message",))
