import hashlib
import json
import subprocess

import asyncio
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.knowledge_contracts import WorkerProposal
from okf_wiki.verifier import VerifierAgent
from okf_wiki.verification import (
    REQUIRED_PERSPECTIVES,
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


def test_fresh_verifier_agents_reread_original_snapshot_evidence(tmp_path) -> None:
    repository = tmp_path / "source"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
    text = "Permissions require an administrator."
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
            ]
        )

    verifier = VerifierAgent(FunctionModel(verify))

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
    assert all(prompt["evidence"][0]["text"] == text for prompt in prompts)
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
