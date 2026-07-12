import asyncio
import hashlib
import os
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import unquote_to_bytes

from .cli import advance_preparation, advance_rendering, get_run
from .coverage import obligation_rows
from .knowledge_contracts import AnalysisTask, WorkerProposal, WorkerRunResult
from .run_state import RUN_TRANSITIONS, transition_run
from .scheduler import PlannedTask, PlannerSummary, Scheduler, TaskPlan
from .security import git_read_bytes
from .verification import (
    AcceptancePolicy,
    VerificationFinding,
    VerificationPerspective,
    VerificationTarget,
)


class FixturePlanner:
    async def plan(self, summary: PlannerSummary) -> TaskPlan:
        grouped: dict[str, list] = {}
        for obligation in summary.prioritized_obligations:
            grouped.setdefault(obligation.source_id, []).append(obligation)
        return TaskPlan(
            tasks=tuple(
                PlannedTask(
                    obligation_ids=tuple(item.id for item in obligations),
                    source_id=source_id,
                    allowed_paths=tuple(dict.fromkeys(item.path for item in obligations)),
                    agent_role="extraction",
                    allowed_tools=("list_paths", "search_text", "read_text"),
                    prompt="Record deterministic source-grounded fixture outcomes.",
                    budgets=summary.remaining_budgets.worker,
                )
                for source_id, obligations in list(grouped.items())[
                    : summary.remaining_budgets.task_slots
                ]
            )
        )


class FixtureWorker:
    def __init__(self, database: Path, run_id: str) -> None:
        self.database = database
        self.run_id = run_id

    async def run(self, task: AnalysisTask) -> WorkerRunResult:
        with sqlite3.connect(self.database) as connection:
            connection.row_factory = sqlite3.Row
            exists = connection.execute(
                "SELECT 1 FROM analysis_tasks WHERE run_id = ? AND id = ?",
                (self.run_id, task.task_id),
            ).fetchone()
            if exists is None:
                raise ValueError(f"Unknown Analysis Task: {task.task_id}")
            obligations = {item["id"]: item for item in obligation_rows(connection, self.run_id)}
        evidence = []
        claims = []
        concepts = []
        dispositions = []
        for obligation_id in task.obligation_ids:
            obligation = obligations[obligation_id]
            content = git_read_bytes(
                task.repository,
                "show",
                f"{task.revision}:{os.fsdecode(unquote_to_bytes(obligation['path']))}",
            ).decode("utf-8")
            span = obligation["span"]
            source_text = "\n".join(content.splitlines()[span["start_line"] - 1 : span["end_line"]])
            suffix = hashlib.sha256(obligation_id.encode()).hexdigest()[:16]
            evidence_id = f"fixture-evidence:{suffix}"
            claim_id = f"fixture-claim:{suffix}"
            evidence.append(
                {
                    "id": evidence_id,
                    "source_id": task.source_id,
                    "path": obligation["path"],
                    "revision": task.revision,
                    "start_line": span["start_line"],
                    "end_line": span["end_line"],
                    "digest": f"sha256:{hashlib.sha256(source_text.encode()).hexdigest()}",
                }
            )
            claims.append(
                {
                    "id": claim_id,
                    "text": obligation["text"],
                    "evidence_ids": [evidence_id],
                }
            )
            concepts.append(
                {
                    "id": f"fixture-concept:{suffix}",
                    "name": f"Fixture {obligation['kind'].replace('_', ' ').title()} {suffix}",
                    "description": "A deterministic source-grounded fixture concept.",
                    "claim_ids": [claim_id],
                }
            )
            dispositions.append(
                {
                    "obligation_id": obligation_id,
                    "disposition": "covered",
                    "reason": "Deterministic fixture accepted the source-grounded claim.",
                    "evidence_ids": [evidence_id],
                }
            )
        proposal = WorkerProposal.model_validate(
            {
                "task_id": task.task_id,
                "obligation_ids": list(task.obligation_ids),
                "evidence": evidence,
                "claims": claims,
                "concepts": concepts,
                "relations": [],
                "dispositions": dispositions,
            }
        )
        return WorkerRunResult(
            status="accepted",
            candidate_id=f"fixture:{hashlib.sha256(task.task_id.encode()).hexdigest()}",
            proposal=proposal,
            errors=[],
        )


class FixtureVerifier:
    async def verify(
        self, perspective: VerificationPerspective, target: VerificationTarget
    ) -> VerificationFinding:
        return VerificationFinding.model_validate(
            {
                "target_id": target.candidate_id,
                "perspective": perspective,
                "verdict": "pass",
                "severity": "info",
                "evidence": [target.proposal.evidence[0].id],
                "rationale": "Deterministic fixture validation passed.",
            }
        )


class FixtureAcceptancePolicy(AcceptancePolicy):
    def decide(self, *, structural_valid, findings, risk_categories=()):
        return super().decide(
            structural_valid=structural_valid,
            findings=findings,
            risk_categories=(),
        )


def run(root: Path, run_id: str, fixture: str) -> None:
    os.chdir(root)
    database = root / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        if fixture == "failure":
            time.sleep(0.1)
            with connection:
                transition_run(connection, run_id, "preparing", "exploring")
            time.sleep(0.1)
            with connection:
                transition_run(
                    connection,
                    run_id,
                    "exploring",
                    "failed",
                    error="Deterministic failure fixture stopped during Exploring",
                )
            return
        state, _coverage = advance_preparation(connection, run_id)
        if state == "exploring":
            outcome = asyncio.run(
                Scheduler(
                    database,
                    FixturePlanner(),
                    FixtureWorker(database, run_id),
                    verifier=FixtureVerifier(),
                    acceptance_policy=FixtureAcceptancePolicy(),
                ).run_until_terminal(run_id)
            )
            if outcome.status != "complete":
                raise ValueError("Deterministic fixture could not close open Coverage Obligations")
            state = "verifying"
        if state != "verifying":
            raise ValueError(f"Deterministic fixture stopped in {state}")
        advance_rendering(connection, run_id)


def main() -> int:
    if len(sys.argv) != 4:
        return 2
    root = Path(sys.argv[1]).resolve()
    run_id = sys.argv[2]
    try:
        run(root, run_id, sys.argv[3])
    except Exception as error:
        database = root / ".okf-wiki" / "runs.db"
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            row = get_run(connection, run_id)
            if row["state"] in RUN_TRANSITIONS and "failed" in RUN_TRANSITIONS[row["state"]]:
                with connection:
                    transition_run(connection, run_id, row["state"], "failed", error=str(error))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
