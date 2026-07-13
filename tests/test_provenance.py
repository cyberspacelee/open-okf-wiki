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
                    "status": "stale",
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
        connection.execute("UPDATE runs SET state = 'review_required' WHERE id = 'run-1'")

    verification.stage("run-1", "candidate-rejected", "task-2", {"obligation_ids": []})
    verification.record_findings(
        "run-1",
        "candidate-rejected",
        (
            VerificationFinding(
                target_id=receipt.claim_ids[0],
                target_type="claim",
                perspective="contradiction",
                verdict="fail",
                severity="critical",
                evidence=(receipt.claim_ids[0],),
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
    assert "stale" in by_type["concept"][0]["states"]
    assert all(node["events"] for node in by_type["claim"] + by_type["concept"])
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
    }


def test_provenance_bounds_nodes_and_edges_without_dangling_edges(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    concept_id, _ = build_run(database)

    snapshot = ConceptProvenanceStore(database).snapshot("run-1", concept_id=concept_id, limit=5)

    assert len(snapshot["nodes"]) == 5
    assert snapshot["bounds"]["truncated"] is True
    node_ids = {node["id"] for node in snapshot["nodes"]}
    assert len(snapshot["edges"]) <= 10
    assert all(
        edge["source"] in node_ids and edge["target"] in node_ids for edge in snapshot["edges"]
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
