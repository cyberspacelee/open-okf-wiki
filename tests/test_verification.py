import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path

import asyncio
import pytest
from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.bundle import verification_blockers
from okf_wiki.knowledge_contracts import WorkerProposal
from okf_wiki.verifier import VerifierAgent
from okf_wiki.verification import (
    REQUIRED_PERSPECTIVES,
    AcceptanceDecision,
    AcceptancePolicy,
    VerificationStore,
    VerificationFinding,
    VerificationTarget,
)


def finding(
    perspective: str,
    *,
    verdict: str = "pass",
    severity: str = "info",
) -> VerificationFinding:
    return VerificationFinding.model_validate(
        {
            "target_id": "candidate-1",
            "perspective": perspective,
            "verdict": verdict,
            "severity": severity,
            "evidence": ["evidence-1"],
            "rationale": f"{perspective}: {verdict}",
        }
    )


def test_acceptance_policy_requires_every_perspective_without_model_voting() -> None:
    policy = AcceptancePolicy()
    passed = tuple(finding(perspective) for perspective in REQUIRED_PERSPECTIVES)

    assert policy.decide(structural_valid=True, findings=passed).outcome == "accepted"
    assert policy.decide(structural_valid=True, findings=passed[:-1]).outcome == (
        "revision_required"
    )
    assert (
        policy.decide(
            structural_valid=True,
            findings=(*passed[:-1], finding("risk", verdict="fail", severity="critical")),
        ).outcome
        == "rejected"
    )
    assert (
        policy.decide(
            structural_valid=True,
            findings=(
                *passed[:2],
                finding("contradiction", verdict="disputed", severity="warning"),
                *passed[3:],
            ),
        ).outcome
        == "review_required"
    )
    assert (
        policy.decide(
            structural_valid=True,
            findings=passed,
            risk_categories=("security",),
        ).outcome
        == "review_required"
    )


def test_verification_store_persists_staged_candidate_findings_and_decision(tmp_path) -> None:
    store = VerificationStore(tmp_path / "runs.db")
    store.stage("run-1", "candidate-1", "task-1", {"claims": ["claim-1"]})
    stored_findings = tuple(finding(perspective) for perspective in REQUIRED_PERSPECTIVES)
    store.record_findings("run-1", "candidate-1", stored_findings)
    decision = AcceptancePolicy().decide(structural_valid=True, findings=stored_findings)
    store.record_decision("run-1", "candidate-1", decision)

    assert store.get_findings("run-1", "candidate-1") == list(stored_findings)
    assert store.get_decision("run-1", "candidate-1") == decision


def test_verification_decision_event_is_atomic_and_attributed(tmp_path: Path) -> None:
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
    store.stage("run-1", "candidate-1", "task-1", {})
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TRIGGER reject_verification_event BEFORE INSERT ON run_events
               WHEN json_extract(NEW.details, '$.entity_type') = 'verification_candidate'
               BEGIN SELECT RAISE(ABORT, 'seeded verification event failure'); END"""
        )

    decision = AcceptanceDecision(outcome="rejected", reasons=("critical conflict",))
    with pytest.raises(sqlite3.IntegrityError, match="seeded verification event failure"):
        store.record_decision("run-1", "candidate-1", decision)
    assert store.get_decision("run-1", "candidate-1") is None

    with sqlite3.connect(database) as connection:
        connection.execute("DROP TRIGGER reject_verification_event")
    store.record_decision("run-1", "candidate-1", decision)
    with sqlite3.connect(database) as connection:
        event = connection.execute(
            """SELECT previous_state, state, details FROM run_events
               WHERE json_extract(details, '$.entity_type') = 'verification_candidate'"""
        ).fetchone()

    assert event is not None
    assert event[:2] == ("staged", "rejected")
    assert json.loads(event[2])["candidate_id"] == "candidate-1"


def test_later_accepted_candidate_supersedes_historical_review_finding(tmp_path) -> None:
    store = VerificationStore(tmp_path / "runs.db")
    disputed = finding("contradiction", verdict="disputed", severity="warning")
    store.stage(
        "run-1",
        "candidate-review",
        "task-1",
        {"obligation_ids": ["obligation-1"]},
    )
    store.record_findings("run-1", "candidate-review", (disputed,))
    store.record_decision(
        "run-1",
        "candidate-review",
        AcceptanceDecision(outcome="review_required"),
    )
    store.stage(
        "run-1",
        "candidate-accepted",
        "task-2",
        {"obligation_ids": ["obligation-1"]},
    )
    store.record_findings(
        "run-1",
        "candidate-accepted",
        tuple(finding(perspective) for perspective in REQUIRED_PERSPECTIVES),
    )
    store.record_decision(
        "run-1",
        "candidate-accepted",
        AcceptanceDecision(outcome="accepted"),
    )

    records = store.list_run_findings("run-1")

    historical = next(item for item in records if item["candidate_id"] == "candidate-review")
    assert historical["blocking"] is False


def test_risk_only_review_uses_policy_reason_instead_of_pass_findings(tmp_path) -> None:
    database = tmp_path / "runs.db"
    store = VerificationStore(database)
    store.stage(
        "run-1",
        "candidate-risk",
        "task-1",
        {"obligation_ids": ["obligation-1"]},
    )
    store.record_findings(
        "run-1",
        "candidate-risk",
        tuple(finding(perspective) for perspective in REQUIRED_PERSPECTIVES),
    )
    store.record_decision(
        "run-1",
        "candidate-risk",
        AcceptanceDecision(
            outcome="review_required",
            reasons=("high-risk knowledge: security",),
        ),
    )

    records = store.list_run_findings("run-1")

    assert all(item["active_review"] for item in records)
    assert not any(item["blocking"] for item in records)
    assert verification_blockers(database, "run-1") == [
        "candidate-risk:acceptance_policy:high-risk knowledge: security"
    ]


def test_fresh_verifier_agents_reread_original_snapshot_evidence(tmp_path) -> None:
    repository = tmp_path / "source"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
    credential = "gateway-secret-credential"
    text = f"Permissions require an administrator. Credential: {credential}."
    accepted_text = "Permissions do not require an administrator."
    (repository / "guide.md").write_text(f"# Guide\n\n{text}\n", encoding="utf-8")
    (repository / "implementation.md").write_text(
        f"# Implementation\n\n{accepted_text}\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "guide.md", "implementation.md"], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=repository, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "task-1",
            "obligation_ids": ["obligation-1"],
            "evidence": [
                {
                    "id": "evidence-1",
                    "source_id": "source-1",
                    "path": "guide.md",
                    "revision": revision,
                    "start_line": 3,
                    "end_line": 3,
                    "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                }
            ],
            "claims": [{"id": "claim-1", "text": text, "evidence_ids": ["evidence-1"]}],
            "concepts": [
                {
                    "id": "concept-1",
                    "name": "Permissions",
                    "description": "Access rules.",
                    "claim_ids": ["claim-1"],
                }
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": "obligation-1",
                    "disposition": "covered",
                    "reason": "Grounded.",
                    "evidence_ids": ["evidence-1"],
                }
            ],
        }
    )
    target = VerificationTarget(
        run_id="run-1",
        candidate_id="candidate-1",
        proposal=proposal,
        sources=(
            {
                "id": "source-1",
                "repository": repository,
                "revision": revision,
                "role": "requirements",
            },
            {
                "id": "source-2",
                "repository": repository,
                "revision": revision,
                "role": "implementation",
            },
        ),
        obligations=(
            {
                "id": "obligation-1",
                "source_id": "source-1",
                "path": "guide.md",
                "source_unit": "unit-1",
                "kind": "requirement",
                "priority": "major",
                "text": "Document the permissions requirement.",
            },
        ),
        accepted_claims=(
            {
                "id": "claim:accepted",
                "subject": "permissions",
                "predicate": "requires",
                "statement": "Permissions do not require an administrator.",
                "modality": "asserted",
                "conditions": [],
                "epistemic_status": "supported",
                "evidence": [
                    {
                        "id": "evidence-accepted",
                        "source_id": "source-2",
                        "revision": revision,
                        "path": "implementation.md",
                        "source_unit": "unit-2",
                        "start_line": 3,
                        "end_line": 3,
                        "digest": (f"sha256:{hashlib.sha256(accepted_text.encode()).hexdigest()}"),
                        "evidence_kind": "source_span",
                        "authority": "source_snapshot",
                    }
                ],
                "conflicts_with": [],
                "supersedes": [],
            },
        ),
        accepted_concepts=(
            {
                "id": "concept:accepted",
                "canonical_name": "Access Control",
                "aliases": ["Permissions"],
                "description": "Existing access rules.",
                "status": "active",
                "defining_claim_ids": ["claim:accepted"],
                "supporting_claim_ids": [],
            },
        ),
        risk_categories=("permissions",),
    )
    prompts: list[dict] = []

    def verify(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        assert not any(isinstance(message, ModelResponse) for message in messages)
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        prompts.append(json.loads(str(prompt)))
        perspective = prompts[-1]["perspective"]
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "target_id": "candidate-1",
                        "perspective": perspective,
                        "verdict": "pass",
                        "severity": "info",
                        "evidence": (
                            ["evidence-1", "evidence-accepted"]
                            if perspective == "contradiction"
                            else ["evidence-1"]
                        ),
                        "rationale": "The original evidence supports the bounded target.",
                    },
                    perspective,
                )
            ],
            usage=RequestUsage(input_tokens=7, output_tokens=3),
            model_name="verifier-response-model",
        )

    audit = tmp_path / "semantic-audit.db"
    verifier_model = FunctionModel(verify)
    verifier = VerifierAgent(
        verifier_model,
        audit_path=audit,
        model_name="verifier-assigned-model",
        secrets=(credential,),
    )

    async def run_verifiers():
        return await asyncio.gather(
            verifier.verify("evidence_entailment", target),
            verifier.verify("coverage", target),
            verifier.verify("contradiction", target),
            verifier.verify("concept_boundary", target),
            verifier.verify("risk", target),
        )

    results = asyncio.run(run_verifiers())

    assert [result.perspective for result in results] == list(REQUIRED_PERSPECTIVES)
    assert len(prompts) == 5
    assert all(
        prompt["evidence"][0]["text"]
        == "Permissions require an administrator. Credential: [REDACTED CREDENTIAL]."
        for prompt in prompts
    )
    assert credential not in json.dumps(prompts)
    assert all("messages" not in prompt for prompt in prompts)
    by_perspective = {prompt["perspective"]: prompt["target"] for prompt in prompts}
    assert by_perspective["coverage"]["obligations"][0]["text"] == (
        "Document the permissions requirement."
    )
    assert by_perspective["contradiction"]["accepted_claims"][0]["id"] == ("claim:accepted")
    assert by_perspective["contradiction"]["source_roles"] == {
        "source-1": "requirements",
        "source-2": "implementation",
    }
    assert by_perspective["concept_boundary"]["accepted_concepts"][0]["id"] == ("concept:accepted")
    contradiction_evidence = next(
        prompt["evidence"] for prompt in prompts if prompt["perspective"] == "contradiction"
    )
    assert {item["id"] for item in contradiction_evidence} == {
        "evidence-1",
        "evidence-accepted",
    }
    assert (
        next(item["text"] for item in contradiction_evidence if item["id"] == "evidence-accepted")
        == accepted_text
    )

    def explode(_messages: list[ModelRequest | ModelResponse], _info: AgentInfo) -> ModelResponse:
        raise ValueError(f"gateway rejected {credential}")

    with pytest.raises(
        RuntimeError,
        match=r"ValueError: gateway rejected \[REDACTED CREDENTIAL\]",
    ):
        asyncio.run(
            VerifierAgent(
                FunctionModel(explode),
                audit_path=audit,
                model_name="verifier-assigned-model",
                secrets=(credential,),
            ).verify("evidence_entailment", target)
        )
    with sqlite3.connect(audit) as connection:
        rows = list(
            connection.execute(
                """SELECT status, usage_json, retry_count, model, error
                   FROM agent_invocations WHERE role = 'verifier'
                   ORDER BY created_at, id"""
            )
        )
    accepted_rows = [row for row in rows if row[0] == "accepted"]
    failed_row = next(row for row in rows if row[0] == "failed")
    assert len(accepted_rows) == 5
    assert all(json.loads(row[1])["total_tokens"] == 10 for row in accepted_rows)
    assert all(row[2:4] == (0, verifier_model.model_name) for row in accepted_rows)
    assert failed_row[3:] == (
        "verifier-assigned-model",
        "ValueError: gateway rejected [REDACTED CREDENTIAL]",
    )
    assert credential.encode() not in audit.read_bytes()
