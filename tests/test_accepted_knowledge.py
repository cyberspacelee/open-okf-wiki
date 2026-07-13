import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Literal

import pytest

from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore
from okf_wiki.knowledge_contracts import WorkerProposal as ContractWorkerProposal
from okf_wiki.worker import WorkerProposal, WorkerRunResult


def add_run(
    path: Path,
    run_id: str,
    *,
    source_path: str = "guide.md",
    disposition: str = "open",
) -> None:
    source_set = {
        "source_universe": [
            {
                "path": source_path,
                "revision": "a" * 40,
                "source_id": "source-1",
                "source_unit": f"file:{source_path}",
                "source_unit_kind": "file",
            }
        ]
    }
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO runs VALUES (?, 'project-1', ?)",
            (run_id, json.dumps(source_set)),
        )
        connection.execute(
            "INSERT INTO coverage_obligations VALUES ('obligation-1', ?, 'major', ?, NULL)",
            (run_id, disposition),
        )
        connection.execute(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES (?, NULL, 'preparing', '2026-07-11T00:00:00+00:00', '{}')""",
            (run_id,),
        )


def make_ledger(path: Path, *, disposition: str = "open") -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                source_set_json TEXT NOT NULL
            );
            CREATE TABLE coverage_obligations (
                id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                priority TEXT NOT NULL,
                disposition TEXT NOT NULL,
                reason TEXT,
                PRIMARY KEY (run_id, id)
            );
            CREATE TABLE run_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES runs(id),
                previous_state TEXT,
                state TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
    add_run(path, "run-1", disposition=disposition)


def test_control_plane_import_does_not_load_pydantic_ai() -> None:
    assert WorkerProposal is ContractWorkerProposal
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import okf_wiki.accepted_knowledge; "
            "assert 'pydantic_ai' not in sys.modules",
        ],
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr


def candidate(
    candidate_id: str,
    *,
    status: Literal["accepted", "rejected"] = "accepted",
    path: str = "guide.md",
    concept_name: str = "Worker Agent",
    disposition: Literal["covered", "deferred"] = "covered",
    grounded: bool = True,
) -> WorkerRunResult:
    text = "Workers only read fixed snapshots."
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "task-1",
            "obligation_ids": ["obligation-1"],
            "evidence": [
                {
                    "id": "worker-evidence-1",
                    "source_id": "source-1",
                    "path": path,
                    "revision": "a" * 40,
                    "start_line": 3,
                    "end_line": 3,
                    "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                },
                *(
                    [
                        {
                            "id": "disposition-evidence",
                            "source_id": "source-1",
                            "path": path,
                            "revision": "a" * 40,
                            "start_line": 4,
                            "end_line": 4,
                            "digest": f"sha256:{hashlib.sha256(b'other').hexdigest()}",
                        }
                    ]
                    if not grounded
                    else []
                ),
            ],
            "claims": [
                {
                    "id": "worker-claim-1",
                    "text": text,
                    "evidence_ids": ["worker-evidence-1"],
                }
            ],
            "concepts": [
                {
                    "id": "worker-concept-1",
                    "name": concept_name,
                    "description": "A bounded source investigator.",
                    "claim_ids": ["worker-claim-1"],
                }
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": "obligation-1",
                    "disposition": disposition,
                    "reason": "The accepted claim covers it.",
                    "evidence_ids": ["worker-evidence-1" if grounded else "disposition-evidence"],
                }
            ],
        }
    )
    return WorkerRunResult(
        status=status,
        candidate_id=candidate_id,
        proposal=proposal,
        errors=[] if status == "accepted" else ["rejected upstream"],
    )


def ordered_candidate(
    candidate_id: str, claim_order: list[str], concept_name: str = "Worker Agent"
) -> WorkerRunResult:
    text = "Workers only read fixed snapshots."
    claims = {
        "claim-a": {
            "id": "claim-a",
            "text": text,
            "evidence_ids": ["evidence-1"],
        },
        "claim-b": {
            "id": "claim-b",
            "text": "Workers have bounded scope.",
            "evidence_ids": ["evidence-1"],
        },
    }
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "task-ordered",
            "obligation_ids": ["obligation-1"],
            "evidence": [
                {
                    "id": "evidence-1",
                    "source_id": "source-1",
                    "path": "guide.md",
                    "revision": "a" * 40,
                    "start_line": 3,
                    "end_line": 3,
                    "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                }
            ],
            "claims": [claims[claim_id] for claim_id in claim_order],
            "concepts": [
                {
                    "id": "concept-ordered",
                    "name": concept_name,
                    "description": "A bounded source investigator.",
                    "claim_ids": claim_order,
                }
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": "obligation-1",
                    "disposition": "covered",
                    "reason": "Accepted claims cover it.",
                    "evidence_ids": ["evidence-1"],
                }
            ],
        }
    )
    return WorkerRunResult(
        status="accepted", candidate_id=candidate_id, proposal=proposal, errors=[]
    )


def test_accepted_candidate_is_queryable_with_stable_ids_and_page_plan(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)

    first = knowledge.accept("run-1", candidate("candidate-1"))
    repeated = knowledge.accept("run-1", candidate("candidate-2"))

    assert first.claim_ids == repeated.claim_ids
    assert first.concept_ids == repeated.concept_ids
    claim = knowledge.get_claim("run-1", first.claim_ids[0])
    assert claim is not None
    assert claim["statement"] == "Workers only read fixed snapshots."
    assert claim["evidence"][0]["source_unit"] == "file:guide.md"
    assert claim["evidence"][0]["evidence_kind"] == "source_span"
    assert claim["evidence"][0]["authority"] == "source_snapshot"
    concept = knowledge.get_concept("run-1", first.concept_ids[0])
    assert concept is not None
    assert concept["canonical_name"] == "Worker Agent"
    assert concept["defining_claim_ids"] == list(first.claim_ids)
    assert [item["canonical_name"] for item in knowledge.find_concepts("run-1", "")] == [
        "Worker Agent"
    ]
    assert knowledge.get_coverage_summary("run-1") == {"covered": 1}
    events = knowledge.get_obligation_events("run-1", "obligation-1")
    assert [(event["previous_state"], event["state"]) for event in events] == [("open", "covered")]
    assert knowledge.get_page_plan("run-1", first.concept_ids[0])["path"].startswith(
        "concepts/worker-agent-"
    )
    assert "Workers only read fixed snapshots." in knowledge.derive_concept_page(
        "run-1", first.concept_ids[0]
    )
    assert "A bounded source investigator." not in knowledge.derive_concept_page(
        "run-1", first.concept_ids[0]
    )


def test_claim_and_concept_events_are_atomic_and_keep_candidate_attribution(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TRIGGER reject_claim_event BEFORE INSERT ON run_events
               WHEN NEW.state = 'supported'
                AND json_extract(NEW.details, '$.entity_type') = 'claim'
               BEGIN SELECT RAISE(ABORT, 'seeded entity event failure'); END"""
        )

    with pytest.raises(sqlite3.IntegrityError, match="seeded entity event failure"):
        knowledge.accept("run-1", candidate("candidate-1"))

    assert knowledge.list_claims("run-1") == []
    assert knowledge.list_concepts("run-1") == []
    assert knowledge.get_coverage_summary("run-1") == {"open": 1}

    with sqlite3.connect(database) as connection:
        connection.execute("DROP TRIGGER reject_claim_event")
    receipt = knowledge.accept("run-1", candidate("candidate-1"))
    with sqlite3.connect(database) as connection:
        events = [
            (row[0], row[1], row[2], json.loads(row[3])["candidate_id"])
            for row in connection.execute(
                """SELECT previous_state, state, occurred_at, details FROM run_events
                   WHERE json_extract(details, '$.entity_type') IN ('claim', 'concept')
                   ORDER BY sequence"""
            )
        ]

    assert [(previous, current, candidate_id) for previous, current, _, candidate_id in events] == [
        (None, "supported", "candidate-1"),
        (None, "active", "candidate-1"),
    ]
    assert all(occurred_at.endswith("+00:00") for _, _, occurred_at, _ in events)
    assert receipt.claim_ids and receipt.concept_ids


def test_knowledge_summary_requires_page_plans_with_or_without_caller_transaction(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)
    knowledge.accept("run-1", candidate("candidate-1"))
    with sqlite3.connect(database) as connection:
        connection.execute("DELETE FROM page_plans WHERE run_id = 'run-1'")

    with pytest.raises(ValueError, match="Missing page plan"):
        knowledge.knowledge_summary("run-1")
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        with pytest.raises(ValueError, match="Missing page plan"):
            knowledge.knowledge_summary("run-1", connection)


def test_omitted_claim_roles_are_order_independent_and_page_plan_follows_rename(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)

    first = knowledge.accept("run-1", ordered_candidate("candidate-a", ["claim-a", "claim-b"]))
    reordered = knowledge.accept(
        "run-1",
        ordered_candidate("candidate-b", ["claim-b", "claim-a"], "Bounded Worker"),
    )

    assert reordered.concept_ids == first.concept_ids
    assert knowledge.get_page_plan("run-1", reordered.concept_ids[0])["path"].startswith(
        "concepts/bounded-worker-"
    )


def test_rejected_candidate_cannot_change_coverage_or_accepted_knowledge(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)

    receipt = knowledge.accept("run-1", candidate("candidate-1", status="rejected"))

    assert receipt.status == "rejected"
    assert receipt.claim_ids == ()
    assert receipt.concept_ids == ()
    assert knowledge.find_concepts("run-1", "Worker") == []
    assert knowledge.get_coverage_summary("run-1") == {"open": 1}


def test_evidence_relocation_and_concept_rename_preserve_semantic_ids(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    add_run(database, "run-2", source_path="moved-guide.md")
    knowledge = AcceptedKnowledgeStore(database)

    first = knowledge.accept("run-1", candidate("candidate-1"))
    moved = knowledge.accept(
        "run-2",
        candidate("candidate-2", path="moved-guide.md", concept_name="Bounded Worker"),
    )

    assert moved.claim_ids == first.claim_ids
    assert moved.concept_ids == first.concept_ids
    claim = knowledge.get_claim("run-2", moved.claim_ids[0])
    concept = knowledge.get_concept("run-2", moved.concept_ids[0])
    assert claim is not None and len(claim["evidence"]) == 1
    assert claim["evidence"][0]["path"] == "moved-guide.md"
    assert concept is not None and concept["canonical_name"] == "Bounded Worker"


def test_terminal_obligation_overwrite_rejects_before_knowledge_mutation(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database, disposition="excluded")
    knowledge = AcceptedKnowledgeStore(database)

    with pytest.raises(ValueError, match="excluded -> covered"):
        knowledge.accept("run-1", candidate("candidate-1"))

    assert knowledge.find_concepts("run-1", "") == []
    assert knowledge.get_coverage_summary("run-1") == {"excluded": 1}
    assert knowledge.get_obligation_events("run-1", "obligation-1") == []


def test_obligation_event_failure_rolls_back_accepted_knowledge(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TRIGGER reject_coverage_event BEFORE INSERT ON run_events
               WHEN json_extract(NEW.details, '$.entity_type') = 'coverage_obligation'
               BEGIN SELECT RAISE(ABORT, 'seeded coverage event failure'); END"""
        )

    with pytest.raises(sqlite3.IntegrityError, match="seeded coverage event failure"):
        knowledge.accept("run-1", candidate("candidate-1"))

    assert knowledge.find_concepts("run-1", "") == []
    assert knowledge.get_coverage_summary("run-1") == {"open": 1}
    assert knowledge.get_obligation_events("run-1", "obligation-1") == []


def test_cross_candidate_links_resolve_stable_ids_and_reject_unknown_targets(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)
    first = knowledge.accept("run-1", candidate("candidate-1"))
    text = "Bounded Workers read Source Snapshots."

    def linked(target_claim: str, target_concept: str, candidate_id: str) -> WorkerRunResult:
        proposal = WorkerProposal.model_validate(
            {
                "task_id": "task-linked",
                "obligation_ids": ["obligation-1"],
                "evidence": [
                    {
                        "id": "evidence-linked",
                        "source_id": "source-1",
                        "path": "guide.md",
                        "revision": "a" * 40,
                        "start_line": 3,
                        "end_line": 3,
                        "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                    }
                ],
                "claims": [
                    {
                        "id": "claim-linked",
                        "text": text,
                        "conflicts_with": [target_claim],
                        "supersedes": [target_claim],
                        "evidence_ids": ["evidence-linked"],
                    }
                ],
                "concepts": [
                    {
                        "id": "concept-linked",
                        "name": "Bounded Worker",
                        "description": "A bounded worker.",
                        "claim_ids": ["claim-linked"],
                    }
                ],
                "relations": [
                    {
                        "subject_concept_id": "concept-linked",
                        "predicate": "refines",
                        "object_concept_id": target_concept,
                        "evidence_ids": ["evidence-linked"],
                    }
                ],
                "dispositions": [
                    {
                        "obligation_id": "obligation-1",
                        "disposition": "covered",
                        "reason": "Accepted claim covers it.",
                        "evidence_ids": ["evidence-linked"],
                    }
                ],
            }
        )
        return WorkerRunResult(
            status="accepted", candidate_id=candidate_id, proposal=proposal, errors=[]
        )

    second = knowledge.accept(
        "run-1", linked(first.claim_ids[0], first.concept_ids[0], "candidate-2")
    )

    linked_claim = knowledge.get_claim("run-1", second.claim_ids[0])
    assert linked_claim is not None
    assert linked_claim["conflicts_with"] == [first.claim_ids[0]]
    assert linked_claim["supersedes"] == [first.claim_ids[0]]
    assert (
        knowledge.get_relations("run-1", second.concept_ids[0])[0]["object_concept_id"]
        == first.concept_ids[0]
    )

    with pytest.raises(ValueError, match="Unknown external Claim"):
        knowledge.accept(
            "run-1",
            linked(f"claim:{'f' * 64}", first.concept_ids[0], "candidate-bad"),
        )
    assert knowledge.find_concepts("run-1", "Bounded Worker") != []


def test_invalid_dispositions_are_rejected_before_authoritative_mutation(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)

    for invalid in (
        candidate("major-deferred", disposition="deferred"),
        candidate("ungrounded-covered", grounded=False),
    ):
        with pytest.raises(ValueError):
            knowledge.accept("run-1", invalid)

    assert knowledge.find_concepts("run-1", "") == []
    assert knowledge.get_coverage_summary("run-1") == {"open": 1}


def test_acceptance_preserves_concept_roles_conflicts_and_supersession(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"
    make_ledger(database)
    knowledge = AcceptedKnowledgeStore(database)
    text = "Workers only read fixed snapshots."
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "task-1",
            "obligation_ids": ["obligation-1"],
            "evidence": [
                {
                    "id": "evidence-1",
                    "source_id": "source-1",
                    "path": "guide.md",
                    "revision": "a" * 40,
                    "start_line": 3,
                    "end_line": 3,
                    "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                }
            ],
            "claims": [
                {
                    "id": "claim-old",
                    "subject": "Worker Agent",
                    "predicate": "reads",
                    "text": "Workers read working trees.",
                    "evidence_ids": ["evidence-1"],
                },
                {
                    "id": "claim-current",
                    "subject": "Worker Agent",
                    "predicate": "reads",
                    "text": text,
                    "epistemic_status": "disputed",
                    "conflicts_with": ["claim-old"],
                    "evidence_ids": ["evidence-1"],
                },
                {
                    "id": "claim-replacement",
                    "subject": "Source Snapshot",
                    "predicate": "replaces",
                    "text": "Fixed snapshots replace working-tree reads.",
                    "supersedes": ["claim-old"],
                    "evidence_ids": ["evidence-1"],
                },
            ],
            "concepts": [
                {
                    "id": "concept-worker",
                    "name": "Worker Agent",
                    "aliases": ["Bounded Worker"],
                    "description": "A bounded source investigator.",
                    "claim_ids": ["claim-current", "claim-replacement"],
                    "defining_claim_ids": ["claim-current"],
                    "supporting_claim_ids": ["claim-replacement"],
                    "status": "disputed",
                },
                {
                    "id": "concept-snapshot",
                    "name": "Source Snapshot",
                    "description": "A fixed source view.",
                    "claim_ids": ["claim-old"],
                },
            ],
            "relations": [
                {
                    "subject_concept_id": "concept-worker",
                    "predicate": "reads",
                    "object_concept_id": "concept-snapshot",
                    "evidence_ids": ["evidence-1"],
                }
            ],
            "dispositions": [
                {
                    "obligation_id": "obligation-1",
                    "disposition": "covered",
                    "reason": "Accepted claims cover it.",
                    "evidence_ids": ["evidence-1"],
                }
            ],
        }
    )

    receipt = knowledge.accept(
        "run-1",
        WorkerRunResult(
            status="accepted", candidate_id="candidate-semantic", proposal=proposal, errors=[]
        ),
    )

    worker = knowledge.find_concepts("run-1", "Worker")[0]
    assert worker["aliases"] == ["Bounded Worker"]
    assert knowledge.find_concepts("run-1", "Bounded")[0]["id"] == worker["id"]
    assert worker["status"] == "disputed"
    assert len(worker["defining_claim_ids"]) == 1
    assert len(worker["supporting_claim_ids"]) == 1
    defining = knowledge.get_claim("run-1", worker["defining_claim_ids"][0])
    supporting = knowledge.get_claim("run-1", worker["supporting_claim_ids"][0])
    assert defining is not None and defining["epistemic_status"] == "disputed"
    assert len(defining["conflicts_with"]) == 1
    assert supporting is not None and supporting["supersedes"] == defining["conflicts_with"]
    relation = knowledge.get_relations("run-1", worker["id"])[0]
    assert relation["predicate"] == "reads"
    assert len(relation["evidence_ids"]) == 1
    assert len(knowledge.get_conflicts("run-1", worker["id"])) == 1
    assert len(knowledge.get_claims_for_obligation("run-1", "obligation-1")) == 3
    assert receipt.concept_ids
    worker_page = knowledge.derive_concept_page("run-1", worker["id"])
    assert "Workers only read fixed snapshots." not in worker_page
    assert "Fixed snapshots replace working-tree reads." in worker_page
    assert f"<!-- claims: {supporting['id']} -->" in worker_page
