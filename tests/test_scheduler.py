import asyncio
import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError
from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore
from okf_wiki.cli import create_run, initialize
from okf_wiki.knowledge_contracts import AnalysisTask, WorkerRunResult
from okf_wiki.planner import PlannerAgent
from okf_wiki.scheduler import PlannerLimits, PlannerReceipt, Scheduler
from okf_wiki.verification import (
    REQUIRED_PERSPECTIVES,
    VerificationFinding,
    VerificationStore,
    VerificationTarget,
)
from okf_wiki.worker import WorkerAgent


def make_run(tmp_path: Path, obligations: list[tuple[str, str, str]]) -> tuple[Path, str, str]:
    repository = tmp_path / "source"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
    (repository / "guide.md").write_text(
        "# Guide\n\nWorkers only read fixed snapshots.\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "guide.md"], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=repository, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    database = tmp_path / "runs.db"
    source_set = {
        "digest": "source-set",
        "producer_profile_id": "profile:test",
        "sources": [
            {
                "id": "source-1",
                "repository": str(repository),
                "revision": revision,
                "role": "requirements",
            }
        ],
        "source_universe": [
            {
                "source_id": "source-1",
                "revision": revision,
                "path": "guide.md",
                "source_unit": "unit-1",
                "source_unit_kind": "file",
            }
        ],
        "evidence": [],
    }
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        initialize(connection)
        create_run(
            connection,
            "run-1",
            "project-1",
            repository,
            revision,
            tmp_path / "published",
            tmp_path / "staging",
            source_set,
        )
        connection.executemany(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text, details)
               VALUES (?, 'run-1', 'source-1', 'requirements', 'guide.md', 'unit-1',
                       'normative_statement', ?, ?, NULL, ?, ?, '{}')""",
            [
                (obligation_id, priority, disposition, '{"start_line":3,"end_line":3}', text)
                for obligation_id, priority, disposition in obligations
                for text in [f"Requirement {obligation_id}"]
            ],
        )
    return database, revision, "run-1"


def planned_task(obligation_id: str, source_id: str = "source-1") -> dict:
    return {
        "obligation_ids": [obligation_id],
        "source_id": source_id,
        "allowed_paths": ["guide.md"],
        "agent_role": "extraction",
        "allowed_tools": ["list_paths", "search_text", "read_text"],
        "prompt": f"Investigate {obligation_id}.",
        "budgets": {},
    }


def worker_proposal(revision: str, task_id: str, obligation_id: str) -> dict:
    text = "Workers only read fixed snapshots."
    return {
        "task_id": task_id,
        "obligation_ids": [obligation_id],
        "evidence": [
            {
                "id": f"evidence-{obligation_id}",
                "source_id": "source-1",
                "path": "guide.md",
                "revision": revision,
                "start_line": 3,
                "end_line": 3,
                "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
            }
        ],
        "claims": [
            {
                "id": f"claim-{obligation_id}",
                "text": f"{text} ({obligation_id})",
                "evidence_ids": [f"evidence-{obligation_id}"],
            }
        ],
        "concepts": [
            {
                "id": f"concept-{obligation_id}",
                "name": f"Worker {obligation_id}",
                "description": "A bounded reader.",
                "claim_ids": [f"claim-{obligation_id}"],
            }
        ],
        "relations": [],
        "dispositions": [
            {
                "obligation_id": obligation_id,
                "disposition": "covered",
                "reason": "The claim is grounded.",
                "evidence_ids": [f"evidence-{obligation_id}"],
            }
        ],
    }


class StaticVerifier:
    def __init__(
        self,
        overrides: dict[str, tuple[str, str]] | None = None,
    ) -> None:
        self.overrides = overrides or {}
        self.targets: list[VerificationTarget] = []

    async def verify(self, perspective: str, target: VerificationTarget) -> VerificationFinding:
        self.targets.append(target)
        verdict, severity = self.overrides.get(perspective, ("pass", "info"))
        target_id = (
            target.proposal.obligation_ids[0] if perspective == "coverage" else target.candidate_id
        )
        return VerificationFinding.model_validate(
            {
                "target_id": target_id,
                "target_type": "obligation" if perspective == "coverage" else "candidate",
                "perspective": perspective,
                "verdict": verdict,
                "severity": severity,
                "evidence": [target.proposal.evidence[0].id],
                "rationale": f"{perspective}: {verdict}",
            }
        )


def test_scheduler_plans_from_bounded_persisted_state_and_records_task(tmp_path: Path) -> None:
    database, _revision, run_id = make_run(
        tmp_path,
        [
            ("supporting-open", "supporting", "open"),
            ("major-open", "major", "open"),
            ("major-covered", "major", "covered"),
        ],
    )
    seen: list[dict] = []
    planner_tools: list[str] = []

    def plan(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        seen.append(json.loads(str(prompt)))
        planner_tools.extend(tool.name for tool in info.function_tools)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name, {"tasks": [planned_task("major-open")]}, "plan"
                )
            ]
        )

    scheduler = Scheduler(
        database,
        PlannerAgent(FunctionModel(plan)),
        worker=None,
        limits=PlannerLimits(obligation_limit=2, max_tasks=2),
    )

    outcome = asyncio.run(scheduler.plan(run_id))

    assert outcome.status == "planned"
    assert [item["id"] for item in seen[0]["prioritized_obligations"]] == [
        "major-open",
        "supporting-open",
    ]
    assert seen[0]["source_set"] == [
        {
            "id": "source-1",
            "path_count": 1,
            "revision": seen[0]["source_set"][0]["revision"],
            "role": "requirements",
        }
    ]
    assert seen[0]["active_tasks"] == []
    assert seen[0]["receipts"] == []
    assert seen[0]["producer_profile_id"] == "profile:test"
    assert planner_tools == []
    task = scheduler.get_task(run_id, outcome.task_ids[0])
    assert task.state == "planned"
    assert task.obligation_ids == ("major-open",)
    assert task.agent_role == "extraction"
    assert task.allowed_tools == ("list_paths", "search_text", "read_text")
    assert [event.state for event in scheduler.task_events(run_id, task.task_id)] == ["planned"]


def test_source_summary_limit_does_not_hide_the_only_uncovered_source(tmp_path: Path) -> None:
    database, revision, run_id = make_run(
        tmp_path,
        [("source-1-covered", "major", "covered"), ("source-2-open", "major", "open")],
    )
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
        )
        source_set["sources"].append(
            {
                "id": "source-2",
                "repository": source_set["sources"][0]["repository"],
                "revision": revision,
                "role": "contracts",
            }
        )
        source_set["source_universe"].append(
            {
                "source_id": "source-2",
                "revision": revision,
                "path": "guide.md",
                "source_unit": "unit-2",
                "source_unit_kind": "file",
            }
        )
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = ?",
            (json.dumps(source_set), run_id),
        )
        connection.execute(
            """UPDATE coverage_obligations
               SET source = 'source-2', role = 'contracts', source_unit = 'unit-2'
               WHERE run_id = ? AND id = 'source-2-open'""",
            (run_id,),
        )
    seen: list[dict] = []

    def plan(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        seen.append(json.loads(str(prompt)))
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"tasks": [planned_task("source-2-open", "source-2")]},
                    "plan",
                )
            ]
        )

    scheduler = Scheduler(
        database,
        PlannerAgent(FunctionModel(plan)),
        worker=None,
        limits=PlannerLimits(source_limit=1),
    )

    outcome = asyncio.run(scheduler.plan(run_id))

    assert outcome.status == "planned"
    assert [source["id"] for source in seen[0]["source_set"]] == ["source-2"]


def test_analysis_task_state_machine_rejects_illegal_transition_atomically(tmp_path: Path) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    scheduler = Scheduler(
        database,
        PlannerAgent(
            TestModel(call_tools=[], custom_output_args={"tasks": [planned_task("obligation-1")]})
        ),
        worker=None,
    )
    outcome = asyncio.run(scheduler.plan(run_id))
    task_id = outcome.task_ids[0]

    with pytest.raises(ValueError, match="Illegal Analysis Task transition"):
        scheduler.transition_task(run_id, task_id, "submitted")

    assert scheduler.get_task(run_id, task_id).state == "planned"
    assert [event.state for event in scheduler.task_events(run_id, task_id)] == ["planned"]


def test_workers_run_in_parallel_and_acceptance_closes_persisted_obligations(
    tmp_path: Path,
) -> None:
    database, revision, run_id = make_run(
        tmp_path,
        [("obligation-1", "major", "open"), ("obligation-2", "major", "open")],
    )
    active = 0
    maximum = 0

    async def work(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal active, maximum
        prompt = next(
            str(part.content)
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        assignment = json.loads(prompt.rsplit("Task assignment: ", 1)[1])
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    worker_proposal(
                        revision, assignment["task_id"], assignment["obligation_ids"][0]
                    ),
                    "output",
                )
            ],
            usage=RequestUsage(input_tokens=10, output_tokens=5),
        )

    planner = PlannerAgent(
        TestModel(
            call_tools=[],
            custom_output_args={
                "tasks": [planned_task("obligation-1"), planned_task("obligation-2")]
            },
        )
    )
    worker = WorkerAgent(
        FunctionModel(work),
        audit_path=tmp_path / "worker.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=2,
    )
    scheduler = Scheduler(
        database,
        planner,
        worker,
        max_concurrency=2,
        verifier=StaticVerifier(),
    )

    outcome = asyncio.run(scheduler.advance(run_id))

    assert outcome.status == "complete"
    assert maximum == 2
    assert {scheduler.get_task(run_id, task_id).state for task_id in outcome.task_ids} == {
        "accepted"
    }
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"covered": 2}
    assert all(
        [event.state for event in scheduler.task_events(run_id, task_id)]
        == ["planned", "running", "submitted", "accepted"]
        for task_id in outcome.task_ids
    )
    with sqlite3.connect(database) as connection:
        coverage_json, source_set_json, state = connection.execute(
            "SELECT coverage_json, source_set_json, state FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
        coverage = json.loads(coverage_json)
        source_set = json.loads(source_set_json)
        assert coverage["covered"] == 2
        assert coverage["open"] == 0
        assert source_set["sources"][0]["coverage"]["covered"] == 2
        assert source_set["sources"][0]["coverage"]["open"] == 0
        assert state == "verifying"


def test_semantic_acceptance_runs_every_perspective_before_accepting(tmp_path: Path) -> None:
    database, revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    planner = PlannerAgent(
        TestModel(
            call_tools=[],
            custom_output_args={"tasks": [planned_task("obligation-1")]},
        )
    )
    verifier = StaticVerifier()
    planned = asyncio.run(Scheduler(database, planner, worker=None).plan(run_id))
    scheduler = Scheduler(
        database,
        planner,
        WorkerAgent(
            TestModel(
                call_tools=[],
                custom_output_args=worker_proposal(revision, planned.task_ids[0], "obligation-1"),
            ),
            audit_path=tmp_path / "worker.db",
            gateway_id="test",
            model_name="test",
            max_concurrency=1,
        ),
        verifier=verifier,
    )

    outcome = asyncio.run(scheduler.run_ready(run_id, planned.task_ids))

    assert outcome.status == "complete"
    assert [target.candidate_id for target in verifier.targets]
    assert verifier.targets[0].obligations[0].text == "Requirement obligation-1"
    assert {
        finding.perspective
        for finding in VerificationStore(database).get_findings(
            run_id, verifier.targets[0].candidate_id
        )
    } == set(REQUIRED_PERSPECTIVES)
    decision = VerificationStore(database).get_decision(run_id, verifier.targets[0].candidate_id)
    assert decision is not None and decision.outcome == "accepted"
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"covered": 1}


def test_accepted_candidate_cannot_bypass_semantic_verification(tmp_path: Path) -> None:
    database, revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    planner = PlannerAgent(
        TestModel(call_tools=[], custom_output_args={"tasks": [planned_task("obligation-1")]})
    )
    planned = asyncio.run(Scheduler(database, planner, worker=None).plan(run_id))
    scheduler = Scheduler(
        database,
        planner,
        WorkerAgent(
            TestModel(
                call_tools=[],
                custom_output_args=worker_proposal(revision, planned.task_ids[0], "obligation-1"),
            ),
            audit_path=tmp_path / "worker.db",
            gateway_id="test",
            model_name="test",
            max_concurrency=1,
        ),
    )

    outcome = asyncio.run(scheduler.run_ready(run_id, planned.task_ids))

    assert outcome.status == "replan"
    task = scheduler.get_task(run_id, planned.task_ids[0])
    assert task.state == "rejected"
    assert task.receipt is not None
    assert task.receipt.warnings == ("semantic verification unavailable",)
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"open": 1}
    assert AcceptedKnowledgeStore(database).list_claims(run_id) == []


@pytest.mark.parametrize(
    ("overrides", "risk_text", "expected"),
    [
        ({"coverage": ("fail", "error")}, None, "revision_required"),
        ({"contradiction": ("disputed", "warning")}, None, "review_required"),
        ({}, "Security permissions are persisted.", "review_required"),
        ({"risk": ("fail", "critical")}, None, "rejected"),
    ],
)
def test_nonaccepted_semantic_decisions_reopen_obligations_without_mutating_knowledge(
    tmp_path: Path,
    overrides: dict[str, tuple[str, str]],
    risk_text: str | None,
    expected: str,
) -> None:
    database, revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    planner = PlannerAgent(
        TestModel(call_tools=[], custom_output_args={"tasks": [planned_task("obligation-1")]})
    )
    first = Scheduler(database, planner, worker=None)
    planned = asyncio.run(first.plan(run_id))
    proposal = worker_proposal(revision, planned.task_ids[0], "obligation-1")
    if risk_text:
        proposal["claims"][0]["text"] = risk_text
    verifier = StaticVerifier(overrides)
    scheduler = Scheduler(
        database,
        planner,
        WorkerAgent(
            TestModel(call_tools=[], custom_output_args=proposal),
            audit_path=tmp_path / "worker.db",
            gateway_id="test",
            model_name="test",
            max_concurrency=1,
        ),
        verifier=verifier,
    )

    asyncio.run(scheduler.run_ready(run_id, planned.task_ids))

    candidate_id = verifier.targets[0].candidate_id
    decision = VerificationStore(database).get_decision(run_id, candidate_id)
    assert decision is not None and decision.outcome == expected
    task = scheduler.get_task(run_id, planned.task_ids[0])
    assert task.state == "rejected"
    assert task.receipt is not None
    assert task.receipt.unresolved_ids == ("obligation-1",)
    assert task.receipt.warnings[0] == expected
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"open": 1}
    assert AcceptedKnowledgeStore(database).find_concepts(run_id, "") == []
    if "contradiction" in overrides:
        contradiction = next(
            finding
            for finding in VerificationStore(database).get_findings(run_id, candidate_id)
            if finding.perspective == "contradiction"
        )
        assert contradiction.verdict == "disputed"


def test_next_fresh_planner_receives_only_compact_persisted_receipts(tmp_path: Path) -> None:
    database, revision, run_id = make_run(
        tmp_path,
        [("obligation-1", "major", "open"), ("obligation-2", "major", "open")],
    )
    first = Scheduler(
        database,
        PlannerAgent(
            TestModel(
                call_tools=[],
                custom_output_args={"tasks": [planned_task("obligation-1")]},
            )
        ),
        worker=None,
    )
    planned = asyncio.run(first.plan(run_id))
    worker = WorkerAgent(
        TestModel(
            call_tools=[],
            custom_output_args=worker_proposal(revision, planned.task_ids[0], "obligation-1"),
        ),
        audit_path=tmp_path / "worker.db",
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )
    asyncio.run(
        Scheduler(database, first.planner, worker, verifier=StaticVerifier()).run_ready(
            run_id, planned.task_ids
        )
    )
    seen: list[dict] = []

    def next_plan(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        assert not any(isinstance(message, ModelResponse) for message in messages)
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        seen.append(json.loads(str(prompt)))
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"tasks": [planned_task("obligation-2")]},
                    "next-plan",
                )
            ]
        )

    second = Scheduler(database, PlannerAgent(FunctionModel(next_plan)), worker=None)

    outcome = asyncio.run(second.plan(run_id))

    assert outcome.status == "planned"
    receipt = seen[0]["receipts"][0]
    assert set(receipt) == {"accepted_ids", "unresolved_ids", "warnings"}
    assert receipt["accepted_ids"]
    assert receipt["unresolved_ids"] == []
    assert receipt["warnings"] == []
    assert "Workers only read fixed snapshots" not in json.dumps(receipt)


def test_budget_exhaustion_replans_once_then_stops_without_retry_loop(tmp_path: Path) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])

    def never_finishes(
        _messages: list[ModelRequest | ModelResponse], _info: AgentInfo
    ) -> ModelResponse:
        return ModelResponse([ToolCallPart("unknown", {}, "again")])

    scheduler = Scheduler(
        database,
        PlannerAgent(FunctionModel(never_finishes), request_limit=1),
        worker=None,
        limits=PlannerLimits(max_replans=1),
    )

    first = asyncio.run(scheduler.plan(run_id))
    second = asyncio.run(scheduler.plan(run_id))
    third = asyncio.run(scheduler.plan(run_id))

    assert first.status == "replan"
    assert second.status == "failed"
    assert third == second
    assert second.warnings and "UsageLimitExceeded" in second.warnings[0]


def test_scheduler_control_plane_has_no_agent_framework_imports() -> None:
    root = Path(__file__).parents[1] / "src" / "okf_wiki"

    assert "pydantic_ai" not in (root / "scheduler.py").read_text()
    assert "pydantic_ai" not in (root / "verification.py").read_text()
    assert "from .worker" not in (root / "scheduler.py").read_text()
    assert "pydantic_ai" not in (root / "knowledge_contracts.py").read_text()


def test_progress_batches_do_not_spend_failure_replans(tmp_path: Path) -> None:
    database, revision, run_id = make_run(
        tmp_path,
        [("obligation-1", "major", "open"), ("obligation-2", "major", "open")],
    )

    def plan(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        obligation_id = json.loads(str(prompt))["prioritized_obligations"][0]["id"]
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name, {"tasks": [planned_task(obligation_id)]}, "plan"
                )
            ]
        )

    def work(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        prompt = next(
            str(part.content)
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        assignment = json.loads(prompt.rsplit("Task assignment: ", 1)[1])
        obligation_id = assignment["obligation_ids"][0]
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    worker_proposal(revision, assignment["task_id"], obligation_id),
                    "output",
                )
            ]
        )

    scheduler = Scheduler(
        database,
        PlannerAgent(FunctionModel(plan)),
        WorkerAgent(
            FunctionModel(work),
            audit_path=tmp_path / "worker.db",
            gateway_id="test",
            model_name="test",
            max_concurrency=1,
        ),
        limits=PlannerLimits(max_tasks=1, max_replans=0),
        verifier=StaticVerifier(),
    )

    outcome = asyncio.run(scheduler.run_until_terminal(run_id))

    assert outcome.status == "complete"
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"covered": 2}


def test_worker_runtime_failure_is_persisted_and_replanned(tmp_path: Path) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    planner = PlannerAgent(
        TestModel(
            call_tools=[],
            custom_output_args={"tasks": [planned_task("obligation-1")]},
        )
    )
    planned = asyncio.run(Scheduler(database, planner, worker=None).plan(run_id))

    class BrokenWorker:
        async def run(self, task: AnalysisTask) -> WorkerRunResult:
            del task
            raise RuntimeError("worker audit unavailable")

    scheduler = Scheduler(
        database,
        planner,
        BrokenWorker(),
        limits=PlannerLimits(max_replans=0),
    )

    outcome = asyncio.run(scheduler.run_ready(run_id, planned.task_ids))

    task = scheduler.get_task(run_id, planned.task_ids[0])
    assert outcome.status == "failed"
    assert task.state == "failed"
    assert task.receipt is not None
    assert task.receipt.unresolved_ids == ("obligation-1",)
    assert task.receipt.warnings == ("RuntimeError: worker audit unavailable",)
    assert [event.state for event in scheduler.task_events(run_id, task.task_id)] == [
        "planned",
        "running",
        "submitted",
        "failed",
    ]
    assert AcceptedKnowledgeStore(database).get_coverage_summary(run_id) == {"open": 1}


@pytest.mark.parametrize("disposition", ["blocked", "failed"])
def test_unrecoverable_obligations_fail_the_scheduler_and_run(
    tmp_path: Path, disposition: str
) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", disposition)])
    scheduler = Scheduler(
        database,
        PlannerAgent(TestModel(call_tools=[], custom_output_args={"tasks": []})),
        worker=None,
    )

    outcome = asyncio.run(scheduler.plan(run_id))

    assert outcome.status == "failed"
    assert disposition in outcome.warnings[0]
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT state FROM runs WHERE id = ?", (run_id,)).fetchone()[
            0
        ] == ("failed")


def test_assigned_obligation_without_active_task_is_controlled_failure(tmp_path: Path) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", "assigned")])
    scheduler = Scheduler(
        database,
        PlannerAgent(TestModel(call_tools=[], custom_output_args={"tasks": []})),
        worker=None,
    )

    outcome = asyncio.run(scheduler.plan(run_id))

    assert outcome.status == "failed"
    assert "assigned" in outcome.warnings[0]


def test_reopened_attempt_does_not_starve_never_attempted_source(tmp_path: Path) -> None:
    database, revision, run_id = make_run(
        tmp_path,
        [("source-1-open", "major", "open"), ("source-2-open", "major", "open")],
    )
    with sqlite3.connect(database) as connection:
        source_set = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
        )
        source_set["sources"].append(
            {
                "id": "source-2",
                "repository": source_set["sources"][0]["repository"],
                "revision": revision,
                "role": "contracts",
            }
        )
        source_set["source_universe"].append(
            {
                "source_id": "source-2",
                "revision": revision,
                "path": "guide.md",
                "source_unit": "unit-2",
                "source_unit_kind": "file",
            }
        )
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = ?", (json.dumps(source_set), run_id)
        )
        connection.execute(
            """UPDATE coverage_obligations
               SET source = 'source-2', role = 'contracts', source_unit = 'unit-2'
               WHERE run_id = ? AND id = 'source-2-open'""",
            (run_id,),
        )
    first = Scheduler(
        database,
        PlannerAgent(
            TestModel(
                call_tools=[],
                custom_output_args={"tasks": [planned_task("source-1-open")]},
            )
        ),
        worker=None,
        limits=PlannerLimits(source_limit=1),
    )
    planned = asyncio.run(first.plan(run_id))
    rejected = worker_proposal(revision, planned.task_ids[0], "source-1-open")
    rejected["evidence"][0]["digest"] = f"sha256:{'0' * 64}"
    worker = WorkerAgent(
        TestModel(call_tools=[], custom_output_args=rejected),
        audit_path=tmp_path / "worker.db",
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )
    asyncio.run(Scheduler(database, first.planner, worker).run_ready(run_id, planned.task_ids))
    seen: list[dict] = []

    def next_plan(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        prompt = next(
            part.content
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, UserPromptPart)
        )
        seen.append(json.loads(str(prompt)))
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"tasks": [planned_task("source-2-open", "source-2")]},
                    "plan",
                )
            ]
        )

    outcome = asyncio.run(
        Scheduler(
            database,
            PlannerAgent(FunctionModel(next_plan)),
            worker=None,
            limits=PlannerLimits(source_limit=1),
        ).plan(run_id)
    )

    assert outcome.status == "planned"
    assert seen[0]["prioritized_obligations"][0]["id"] == "source-2-open"
    events = AcceptedKnowledgeStore(database).get_obligation_events(run_id, "source-1-open")
    assert [event["state"] for event in events] == ["assigned", "open"]
    assert [event["candidate_id"] for event in events] == [None, None]


@pytest.mark.parametrize(
    "change",
    [
        {"obligation_ids": ["obligation-1", "obligation-1"]},
        {"allowed_paths": ["guide.md", "guide.md"]},
        {"agent_role": "verifier"},
    ],
)
def test_scheduler_rejects_ambiguous_or_unsupported_task_contracts(
    tmp_path: Path, change: dict
) -> None:
    database, _revision, run_id = make_run(tmp_path, [("obligation-1", "major", "open")])
    task = {**planned_task("obligation-1"), **change}
    scheduler = Scheduler(
        database,
        PlannerAgent(TestModel(call_tools=[], custom_output_args={"tasks": [task]})),
        worker=None,
        limits=PlannerLimits(max_replans=0),
    )

    outcome = asyncio.run(scheduler.plan(run_id))

    assert outcome.status == "failed"


def test_planner_receipts_have_hard_content_bounds() -> None:
    with pytest.raises(ValidationError):
        PlannerReceipt(accepted_ids=tuple(str(index) for index in range(101)))
    with pytest.raises(ValidationError):
        PlannerReceipt(warnings=("x" * 501,))
