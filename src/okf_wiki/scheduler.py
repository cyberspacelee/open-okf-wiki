import asyncio
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field

from .accepted_knowledge import AcceptedKnowledgeStore, AcceptanceReceipt
from .coverage import refresh_run_coverage
from .knowledge_contracts import (
    AnalysisTask,
    ObligationSummary,
    WorkerBudgets,
    WorkerProposal,
    WorkerRunResult,
)
from .run_events import append_entity_event
from .run_state import transition_run
from .verification import (
    REQUIRED_PERSPECTIVES,
    AcceptanceDecision,
    AcceptancePolicy,
    SemanticVerifier,
    VerificationFinding,
    VerificationPerspective,
    VerificationSource,
    VerificationStore,
    VerificationTarget,
)


TASK_TRANSITIONS = {
    "planned": {"running"},
    "running": {"submitted"},
    "submitted": {"accepted", "rejected", "failed"},
}
READ_TOOLS = ("list_paths", "search_text", "read_text")
RISK_TERMS = {
    "security": r"\b(?:security|authentication|authorization)\b",
    "permissions": r"\b(?:permission|permissions|access control)\b",
    "privacy": r"\b(?:privacy|personal data|pii)\b",
    "persistence": r"\b(?:persistence|persisted|database|transaction)\b",
    "failure_semantics": r"\b(?:failure|rollback|retry|error handling)\b",
}


class PlannerLimits(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    obligation_limit: int = Field(default=20, ge=1)
    source_limit: int = Field(default=10, ge=1)
    active_task_limit: int = Field(default=20, ge=1)
    receipt_limit: int = Field(default=10, ge=1)
    max_tasks: int = Field(default=4, ge=1)
    max_replans: int = Field(default=2, ge=0)


class PlannedTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    obligation_ids: tuple[str, ...] = Field(min_length=1, max_length=20)
    source_id: str = Field(min_length=1)
    allowed_paths: tuple[str, ...] = Field(min_length=1, max_length=100)
    agent_role: Literal["extraction"]
    allowed_tools: tuple[Literal["list_paths", "search_text", "read_text"], ...] = Field(
        min_length=1
    )
    prompt: str = Field(min_length=1, max_length=4_000)
    budgets: WorkerBudgets


class TaskPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tasks: tuple[PlannedTask, ...]


class SourceSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    revision: str
    role: str
    path_count: int


class ActiveTaskSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_id: str
    obligation_ids: tuple[str, ...]
    state: str


class PlannerReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    accepted_ids: tuple[str, ...] = Field(default=(), max_length=100)
    unresolved_ids: tuple[str, ...] = Field(default=(), max_length=20)
    warnings: tuple[Annotated[str, Field(min_length=1, max_length=500)], ...] = Field(
        default=(), max_length=10
    )


class RemainingBudgets(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_slots: int
    replans: int
    worker: WorkerBudgets


class PlannerSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str
    project_id: str
    producer_profile_id: str
    source_set: tuple[SourceSummary, ...]
    coverage: dict[str, int]
    prioritized_obligations: tuple[ObligationSummary, ...]
    active_tasks: tuple[ActiveTaskSummary, ...]
    remaining_budgets: RemainingBudgets
    receipts: tuple[PlannerReceipt, ...]


class SchedulerOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["planned", "complete", "replan", "failed"]
    task_ids: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


class PersistedTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    task_id: str
    run_id: str
    state: str
    obligation_ids: tuple[str, ...]
    source_id: str
    repository: Path
    revision: str
    allowed_paths: tuple[str, ...]
    agent_role: Literal["extraction"]
    allowed_tools: tuple[str, ...]
    prompt: str
    budgets: WorkerBudgets
    receipt: PlannerReceipt | None = None
    error: str | None = None

    def assignment(self) -> AnalysisTask:
        return AnalysisTask(
            task_id=self.task_id,
            obligation_ids=self.obligation_ids,
            source_id=self.source_id,
            repository=self.repository,
            revision=self.revision,
            allowed_paths=self.allowed_paths,
            agent_role=self.agent_role,
            allowed_tools=cast(
                tuple[Literal["list_paths", "search_text", "read_text"], ...], self.allowed_tools
            ),
            prompt=self.prompt,
            budgets=self.budgets,
        )


@dataclass(frozen=True)
class TaskEvent:
    sequence: int
    state: str
    previous_state: str | None


class Planner(Protocol):
    async def plan(self, summary: PlannerSummary) -> TaskPlan: ...


class Worker(Protocol):
    async def run(self, task: AnalysisTask) -> WorkerRunResult: ...


class Scheduler:
    def __init__(
        self,
        database: Path,
        planner: Planner,
        worker: Worker | None,
        *,
        limits: PlannerLimits | None = None,
        worker_budgets: WorkerBudgets | None = None,
        max_concurrency: int = 4,
        verifier: SemanticVerifier | None = None,
        acceptance_policy: AcceptancePolicy | None = None,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        self.database = database
        self.planner = planner
        self.worker = worker
        self.limits = limits or PlannerLimits()
        self.worker_budgets = worker_budgets or WorkerBudgets()
        self.max_concurrency = max_concurrency
        self.verifier = verifier
        self.acceptance_policy = acceptance_policy or AcceptancePolicy()
        self.knowledge = AcceptedKnowledgeStore(database)
        self.verification = VerificationStore(database)
        self._writer = asyncio.Lock()
        self._verification_semaphore = asyncio.Semaphore(max_concurrency)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS analysis_tasks (
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    obligation_ids_json TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    repository TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    allowed_paths_json TEXT NOT NULL,
                    agent_role TEXT NOT NULL,
                    allowed_tools_json TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    budgets_json TEXT NOT NULL,
                    receipt_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, id)
                );
                CREATE TABLE IF NOT EXISTS scheduler_control (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id),
                    replan_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'active',
                    warning TEXT
                );
                """
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    def _control(self, connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        connection.execute("INSERT OR IGNORE INTO scheduler_control (run_id) VALUES (?)", (run_id,))
        row = connection.execute(
            "SELECT * FROM scheduler_control WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise ValueError(f"Unknown Production Run: {run_id}")
        return row

    def _summary(self, run_id: str) -> PlannerSummary:
        with self._connect() as connection:
            run = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if run is None:
                raise ValueError(f"Unknown Production Run: {run_id}")
            control = self._control(connection, run_id)
            source_set = json.loads(run["source_set_json"])
            all_sources = {source["id"]: source for source in source_set.get("sources", [])}
            universe = source_set.get("source_universe", [])
            obligation_rows = list(
                connection.execute(
                    """SELECT o.*, COALESCE(attempts.total, 0) AS attempt_count
                       FROM coverage_obligations o
                       LEFT JOIN (
                           SELECT item.value AS obligation_id, COUNT(*) AS total
                           FROM analysis_tasks task, json_each(task.obligation_ids_json) item
                           WHERE task.run_id = ?
                           GROUP BY item.value
                       ) attempts ON attempts.obligation_id = o.id
                       WHERE o.run_id = ? AND o.disposition = 'open'
                       ORDER BY attempt_count,
                                CASE o.priority WHEN 'major' THEN 0 ELSE 1 END,
                                source, path, id LIMIT ?""",
                    (run_id, run_id, self.limits.obligation_limit),
                )
            )
            selected_source_ids = tuple(dict.fromkeys(row["source"] for row in obligation_rows))[
                : self.limits.source_limit
            ]
            sources = [all_sources[source_id] for source_id in selected_source_ids]
            source_summary = tuple(
                SourceSummary(
                    id=source["id"],
                    revision=source["revision"],
                    role=source["role"],
                    path_count=len(
                        {unit["path"] for unit in universe if unit["source_id"] == source["id"]}
                    ),
                )
                for source in sources
            )
            coverage = {
                row["disposition"]: row["total"]
                for row in connection.execute(
                    """SELECT disposition, COUNT(*) AS total FROM coverage_obligations
                       WHERE run_id = ? GROUP BY disposition ORDER BY disposition""",
                    (run_id,),
                )
            }
            obligations = tuple(
                ObligationSummary(
                    id=row["id"],
                    source_id=row["source"],
                    path=row["path"],
                    source_unit=row["source_unit"],
                    kind=row["kind"],
                    priority=row["priority"],
                    text=row["text"][:1_000],
                )
                for row in obligation_rows
                if row["source"] in selected_source_ids
            )
            active = tuple(
                ActiveTaskSummary(
                    task_id=row["id"],
                    obligation_ids=tuple(json.loads(row["obligation_ids_json"])),
                    state=row["state"],
                )
                for row in connection.execute(
                    """SELECT id, obligation_ids_json, state FROM analysis_tasks
                       WHERE run_id = ? AND state IN ('planned', 'running', 'submitted')
                       ORDER BY created_at, id LIMIT ?""",
                    (run_id, self.limits.active_task_limit),
                )
            )
            receipts = tuple(
                PlannerReceipt.model_validate_json(row["receipt_json"])
                for row in connection.execute(
                    """SELECT receipt_json FROM analysis_tasks
                       WHERE run_id = ? AND receipt_json IS NOT NULL
                       ORDER BY updated_at DESC, id DESC LIMIT ?""",
                    (run_id, self.limits.receipt_limit),
                )
            )
            return PlannerSummary(
                run_id=run_id,
                project_id=run["project_id"],
                producer_profile_id=source_set["producer_profile_id"],
                source_set=source_summary,
                coverage=coverage,
                prioritized_obligations=obligations,
                active_tasks=active,
                remaining_budgets=RemainingBudgets(
                    task_slots=max(0, self.limits.max_tasks - len(active)),
                    replans=max(0, self.limits.max_replans - control["replan_count"]),
                    worker=self.worker_budgets,
                ),
                receipts=receipts,
            )

    def _validate_plan(self, summary: PlannerSummary, plan: TaskPlan) -> None:
        if len(plan.tasks) > min(self.limits.max_tasks, summary.remaining_budgets.task_slots):
            raise ValueError("Task Plan exceeds the remaining task budget")
        obligations = {item.id: item for item in summary.prioritized_obligations}
        source_ids = {source.id for source in summary.source_set}
        assigned: set[str] = set()
        with self._connect() as connection:
            run = connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (summary.run_id,)
            ).fetchone()
            source_set = json.loads(run["source_set_json"])
        paths = {
            (unit["source_id"], unit["path"]) for unit in source_set.get("source_universe", [])
        }
        budget_ceiling = self.worker_budgets.model_dump()
        for task in plan.tasks:
            if len(task.obligation_ids) != len(set(task.obligation_ids)):
                raise ValueError("Analysis Task Obligation IDs must be unique")
            if len(task.allowed_paths) != len(set(task.allowed_paths)):
                raise ValueError("Analysis Task paths must be unique")
            if task.source_id not in source_ids:
                raise ValueError("Task Plan references a source outside the bounded summary")
            if task.allowed_tools != READ_TOOLS:
                raise ValueError("Analysis Tasks may use only the Worker read tools")
            if set(task.obligation_ids) & assigned:
                raise ValueError("Task Plan assigns an Obligation more than once")
            if any(item not in obligations for item in task.obligation_ids):
                raise ValueError("Task Plan references an Obligation outside the bounded summary")
            if any(obligations[item].source_id != task.source_id for item in task.obligation_ids):
                raise ValueError("One Analysis Task cannot span Source Snapshots")
            if any((task.source_id, path) not in paths for path in task.allowed_paths):
                raise ValueError("Task Plan path is outside the fixed Source Snapshot")
            if any(
                obligations[item].path not in task.allowed_paths for item in task.obligation_ids
            ):
                raise ValueError("Task Plan excludes an assigned Obligation path")
            if any(
                value > budget_ceiling[name] for name, value in task.budgets.model_dump().items()
            ):
                raise ValueError("Task Plan exceeds the Worker budget ceiling")
            assigned.update(task.obligation_ids)

    def _task_id(self, run_id: str, replan_count: int, task: PlannedTask) -> str:
        value = json.dumps(
            [run_id, replan_count, task.model_dump(mode="json")],
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return f"task:{hashlib.sha256(value).hexdigest()}"

    async def plan(self, run_id: str) -> SchedulerOutcome:
        self._start_exploration(run_id)
        with self._connect() as connection:
            control = self._control(connection, run_id)
            if control["status"] == "failed":
                return SchedulerOutcome(
                    status="failed",
                    warnings=(control["warning"],) if control["warning"] else (),
                )
        summary = self._summary(run_id)
        if summary.active_tasks:
            ready = tuple(task.task_id for task in summary.active_tasks if task.state == "planned")
            if len(ready) == len(summary.active_tasks):
                return SchedulerOutcome(status="planned", task_ids=ready)
            return self._replan(run_id, "Analysis Tasks were already in flight")
        if summary.coverage.get("blocked", 0) or summary.coverage.get("failed", 0):
            states = [state for state in ("blocked", "failed") if summary.coverage.get(state, 0)]
            return self._fail(run_id, f"Coverage has {' and '.join(states)} Obligations")
        if summary.coverage.get("assigned", 0):
            return self._fail(run_id, "Coverage has assigned Obligations without active Tasks")
        if not summary.prioritized_obligations:
            self._finish_exploration(run_id)
            return SchedulerOutcome(status="complete")
        try:
            plan = await self.planner.plan(summary)
            self._validate_plan(summary, plan)
        except Exception as error:
            return self._replan(run_id, self._warning(f"{type(error).__name__}: {error}"))
        if not plan.tasks:
            return self._replan(run_id, "Planner returned no tasks for uncovered Obligations")
        with self._connect() as connection, connection:
            control = self._control(connection, run_id)
            timestamp = self._now()
            task_ids = []
            for item in plan.tasks:
                task_id = self._task_id(run_id, control["replan_count"], item)
                source = next(
                    source for source in summary.source_set if source.id == item.source_id
                )
                source_set = json.loads(
                    connection.execute(
                        "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
                    ).fetchone()[0]
                )
                configured = next(
                    source_item
                    for source_item in source_set["sources"]
                    if source_item["id"] == item.source_id
                )
                assignment = {
                    "task_id": task_id,
                    "obligation_ids": list(item.obligation_ids),
                    "source_id": item.source_id,
                    "revision": source.revision,
                    "allowed_paths": list(item.allowed_paths),
                    "agent_role": item.agent_role,
                    "allowed_tools": list(item.allowed_tools),
                    "budgets": item.budgets.model_dump(),
                }
                prompt = (
                    f"{item.prompt}\n\nTask assignment: {json.dumps(assignment, sort_keys=True)}"
                )
                connection.execute(
                    """INSERT INTO analysis_tasks VALUES
                       (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
                    (
                        run_id,
                        task_id,
                        json.dumps(item.obligation_ids),
                        item.source_id,
                        configured["repository"],
                        source.revision,
                        json.dumps(item.allowed_paths),
                        item.agent_role,
                        json.dumps(item.allowed_tools),
                        prompt,
                        item.budgets.model_dump_json(),
                        timestamp,
                        timestamp,
                    ),
                )
                append_entity_event(connection, run_id, "analysis_task", task_id, None, "planned")
                for obligation_id in item.obligation_ids:
                    changed = connection.execute(
                        """UPDATE coverage_obligations SET disposition = 'assigned'
                           WHERE run_id = ? AND id = ? AND disposition = 'open'""",
                        (run_id, obligation_id),
                    )
                    if changed.rowcount != 1:
                        raise ValueError(f"Coverage Obligation is no longer open: {obligation_id}")
                    append_entity_event(
                        connection,
                        run_id,
                        "coverage_obligation",
                        obligation_id,
                        "open",
                        "assigned",
                    )
                task_ids.append(task_id)
        return SchedulerOutcome(status="planned", task_ids=tuple(task_ids))

    def transition_task(
        self,
        run_id: str,
        task_id: str,
        next_state: str,
        *,
        receipt: PlannerReceipt | None = None,
        error: str | None = None,
    ) -> None:
        with self._connect() as connection, connection:
            row = connection.execute(
                "SELECT state FROM analysis_tasks WHERE run_id = ? AND id = ?",
                (run_id, task_id),
            ).fetchone()
            if row is None:
                raise ValueError(f"Unknown Analysis Task: {task_id}")
            previous = row["state"]
            if next_state not in TASK_TRANSITIONS.get(previous, set()):
                raise ValueError(f"Illegal Analysis Task transition: {previous} -> {next_state}")
            changed = connection.execute(
                """UPDATE analysis_tasks
                   SET state = ?, receipt_json = COALESCE(?, receipt_json), error = ?, updated_at = ?
                   WHERE run_id = ? AND id = ? AND state = ?""",
                (
                    next_state,
                    receipt.model_dump_json() if receipt else None,
                    error,
                    self._now(),
                    run_id,
                    task_id,
                    previous,
                ),
            )
            if changed.rowcount != 1:
                raise ValueError(f"Analysis Task is no longer in {previous}")
            append_entity_event(connection, run_id, "analysis_task", task_id, previous, next_state)

    def get_task(self, run_id: str, task_id: str) -> PersistedTask:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM analysis_tasks WHERE run_id = ? AND id = ?", (run_id, task_id)
            ).fetchone()
        if row is None:
            raise ValueError(f"Unknown Analysis Task: {task_id}")
        return PersistedTask(
            task_id=row["id"],
            run_id=row["run_id"],
            state=row["state"],
            obligation_ids=tuple(json.loads(row["obligation_ids_json"])),
            source_id=row["source_id"],
            repository=Path(row["repository"]),
            revision=row["revision"],
            allowed_paths=tuple(json.loads(row["allowed_paths_json"])),
            agent_role=row["agent_role"],
            allowed_tools=tuple(json.loads(row["allowed_tools_json"])),
            prompt=row["prompt"],
            budgets=WorkerBudgets.model_validate_json(row["budgets_json"]),
            receipt=(
                PlannerReceipt.model_validate_json(row["receipt_json"])
                if row["receipt_json"]
                else None
            ),
            error=row["error"],
        )

    def task_events(self, run_id: str, task_id: str) -> list[TaskEvent]:
        with self._connect() as connection:
            rows = list(
                connection.execute(
                    "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
                )
            )
        return [
            TaskEvent(row["sequence"], row["state"], row["previous_state"])
            for row in rows
            if (details := json.loads(row["details"])).get("entity_type") == "analysis_task"
            and details.get("entity_id") == task_id
        ]

    async def _execute(self, run_id: str, task_id: str, semaphore: asyncio.Semaphore) -> None:
        if self.worker is None:
            raise ValueError("Scheduler has no Worker Agent")
        task = self.get_task(run_id, task_id)
        self.transition_task(run_id, task_id, "running")
        try:
            async with semaphore:
                result = await self.worker.run(task.assignment())
        except Exception as error:
            self.transition_task(run_id, task_id, "submitted")
            await self._reject_task(
                run_id,
                task_id,
                "failed",
                [self._warning(f"{type(error).__name__}: {error}")],
            )
            return
        self.transition_task(run_id, task_id, "submitted")
        if result.status == "accepted":
            if self.verifier is None:
                await self._reject_task(
                    run_id,
                    task_id,
                    "rejected",
                    ["semantic verification unavailable"],
                )
                return
            decision = await self._verify_candidate(run_id, task, result)
            if decision.outcome != "accepted":
                self.verification.record_decision(run_id, result.candidate_id, decision)
                await self._reject_task(
                    run_id,
                    task_id,
                    "rejected",
                    [decision.outcome, *decision.reasons],
                )
                return
            try:
                async with self._writer:
                    accepted = await asyncio.to_thread(self.knowledge.accept, run_id, result)
            except Exception as error:
                self.verification.record_decision(
                    run_id,
                    result.candidate_id,
                    AcceptanceDecision(
                        outcome="rejected",
                        reasons=(f"accepted knowledge validation failed: {error}",),
                    ),
                )
                await self._reject_task(run_id, task_id, "rejected", [str(error)])
                return
            self.verification.record_decision(run_id, result.candidate_id, decision)
            await self._accept_task(run_id, task_id, accepted)
            return
        terminal = (
            "failed" if result.error_type in {"UsageLimitExceeded", "TimeoutError"} else "rejected"
        )
        await self._reject_task(run_id, task_id, terminal, result.errors)

    def _risk_categories(
        self, obligations: tuple[ObligationSummary, ...], proposal: WorkerProposal
    ) -> tuple[str, ...]:
        obligation_text = " ".join(f"{item.kind} {item.text}" for item in obligations)
        candidate_text = " ".join(
            [
                obligation_text,
                *(claim.text for claim in proposal.claims),
                *(concept.description for concept in proposal.concepts),
                *(disposition.reason for disposition in proposal.dispositions),
            ]
        ).casefold()
        return tuple(
            category
            for category, pattern in RISK_TERMS.items()
            if re.search(pattern, candidate_text)
        )

    async def _verify_candidate(
        self, run_id: str, task: PersistedTask, result: WorkerRunResult
    ) -> AcceptanceDecision:
        if self.verifier is None or result.proposal is None:
            raise ValueError("Semantic verification requires a Verifier and proposal")
        verifier = self.verifier
        with self._connect() as connection:
            obligation_rows = list(
                connection.execute(
                    """SELECT id, source, path, source_unit, kind, priority, text
                       FROM coverage_obligations
                       WHERE run_id = ? AND id IN ({}) ORDER BY id""".format(
                        ",".join("?" for _ in result.proposal.obligation_ids)
                    ),
                    (run_id, *result.proposal.obligation_ids),
                )
            )
            run = connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
        if run is None:
            raise ValueError(f"Unknown Production Run: {run_id}")
        obligations = tuple(
            ObligationSummary(
                id=row["id"],
                source_id=row["source"],
                path=row["path"],
                source_unit=row["source_unit"],
                kind=row["kind"],
                priority=row["priority"],
                text=row["text"],
            )
            for row in obligation_rows
        )
        source_set = json.loads(run["source_set_json"])
        sources = tuple(
            VerificationSource(
                id=source["id"],
                repository=Path(source["repository"]),
                revision=source["revision"],
                role=source["role"],
            )
            for source in source_set.get("sources", [])
        )
        risk_categories = self._risk_categories(obligations, result.proposal)
        target = VerificationTarget(
            run_id=run_id,
            candidate_id=result.candidate_id,
            proposal=result.proposal,
            sources=sources,
            obligations=obligations,
            accepted_claims=tuple(self.knowledge.list_claims(run_id)),
            accepted_concepts=tuple(self.knowledge.list_concepts(run_id)),
            risk_categories=risk_categories,
        )
        self.verification.stage(
            run_id,
            result.candidate_id,
            task.task_id,
            result.proposal.model_dump(mode="json"),
        )

        async def verify(perspective: VerificationPerspective):
            async with self._verification_semaphore:
                return await verifier.verify(perspective, target)

        outcomes = await asyncio.gather(
            *(verify(perspective) for perspective in REQUIRED_PERSPECTIVES),
            return_exceptions=True,
        )
        findings = tuple(
            outcome for outcome in outcomes if isinstance(outcome, VerificationFinding)
        )
        if findings:
            self.verification.record_findings(run_id, result.candidate_id, findings)
        return self.acceptance_policy.decide(
            structural_valid=True,
            findings=findings,
            risk_categories=risk_categories,
        )

    async def _accept_task(self, run_id: str, task_id: str, accepted: AcceptanceReceipt) -> None:
        task = self.get_task(run_id, task_id)
        with self._connect() as connection:
            unresolved = tuple(
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM coverage_obligations
                       WHERE run_id = ? AND id IN ({})
                         AND disposition NOT IN ('covered', 'excluded', 'deferred')
                       ORDER BY id""".format(",".join("?" for _ in task.obligation_ids)),
                    (run_id, *task.obligation_ids),
                )
            )
        accepted_ids = tuple(sorted((*accepted.claim_ids, *accepted.concept_ids)))
        receipt = PlannerReceipt(
            accepted_ids=accepted_ids[:100],
            unresolved_ids=unresolved,
            warnings=("Accepted ID receipt truncated",) if len(accepted_ids) > 100 else (),
        )
        self.transition_task(run_id, task_id, "accepted", receipt=receipt)

    async def _reject_task(
        self, run_id: str, task_id: str, terminal: str, warnings: list[str]
    ) -> None:
        task = self.get_task(run_id, task_id)
        bounded_warnings = tuple(self._warning(warning) for warning in warnings[:10])
        receipt = PlannerReceipt(
            unresolved_ids=task.obligation_ids,
            warnings=bounded_warnings or (terminal,),
        )
        with self._connect() as connection, connection:
            for obligation_id in task.obligation_ids:
                changed = connection.execute(
                    """UPDATE coverage_obligations SET disposition = 'open', reason = NULL
                       WHERE run_id = ? AND id = ? AND disposition = 'assigned'""",
                    (run_id, obligation_id),
                )
                if changed.rowcount:
                    append_entity_event(
                        connection,
                        run_id,
                        "coverage_obligation",
                        obligation_id,
                        "assigned",
                        "open",
                    )
        self.transition_task(
            run_id,
            task_id,
            terminal,
            receipt=receipt,
            error="; ".join(bounded_warnings) or terminal,
        )

    async def run_ready(
        self, run_id: str, task_ids: tuple[str, ...] | None = None
    ) -> SchedulerOutcome:
        if task_ids is None:
            with self._connect() as connection:
                task_ids = tuple(
                    row["id"]
                    for row in connection.execute(
                        """SELECT id FROM analysis_tasks
                           WHERE run_id = ? AND state = 'planned' ORDER BY created_at, id""",
                        (run_id,),
                    )
                )
        semaphore = asyncio.Semaphore(self.max_concurrency)
        await asyncio.gather(*(self._execute(run_id, task_id, semaphore) for task_id in task_ids))
        with self._connect() as connection, connection:
            coverage = refresh_run_coverage(connection, run_id)
            warnings = (
                tuple(
                    warning
                    for row in connection.execute(
                        """SELECT receipt_json FROM analysis_tasks
                       WHERE run_id = ? AND id IN ({}) AND receipt_json IS NOT NULL""".format(
                            ",".join("?" for _ in task_ids)
                        ),
                        (run_id, *task_ids),
                    )
                    for warning in PlannerReceipt.model_validate_json(row["receipt_json"]).warnings
                )
                if task_ids
                else ()
            )
            complete = not any(
                coverage.get(state, 0) for state in ("open", "assigned", "blocked", "failed")
            )
            if complete and self._run_state(connection, run_id) == "exploring":
                transition_run(
                    connection,
                    run_id,
                    "exploring",
                    "verifying",
                    details={"entity_id": run_id, "entity_type": "production_run"},
                )
        if coverage.get("blocked", 0) or coverage.get("failed", 0):
            return self._fail(run_id, "Worker left blocked or failed Coverage Obligations")
        if coverage.get("assigned", 0):
            return self._fail(run_id, "Coverage has assigned Obligations without active Tasks")
        if complete:
            return SchedulerOutcome(status="complete", task_ids=task_ids)
        if not warnings:
            return SchedulerOutcome(status="replan", task_ids=task_ids)
        outcome = self._replan(run_id, warnings[0])
        return outcome.model_copy(update={"task_ids": task_ids, "warnings": warnings})

    async def advance(self, run_id: str) -> SchedulerOutcome:
        planned = await self.plan(run_id)
        if planned.status != "planned":
            return planned
        return await self.run_ready(run_id, planned.task_ids)

    async def run_until_terminal(self, run_id: str) -> SchedulerOutcome:
        while True:
            outcome = await self.advance(run_id)
            if outcome.status in {"complete", "failed"}:
                return outcome

    def _replan(self, run_id: str, warning: str) -> SchedulerOutcome:
        with self._connect() as connection, connection:
            control = self._control(connection, run_id)
            count = control["replan_count"] + 1
            status = "active" if count <= self.limits.max_replans else "failed"
            connection.execute(
                """UPDATE scheduler_control SET replan_count = ?, status = ?, warning = ?
                   WHERE run_id = ?""",
                (count, status, warning, run_id),
            )
            if status == "failed":
                self._fail_run(connection, run_id, warning)
        return SchedulerOutcome(
            status="replan" if status == "active" else "failed",
            warnings=(warning,),
        )

    @staticmethod
    def _warning(value: str) -> str:
        return value[:500] or "Unknown scheduler failure"

    def _run_state(self, connection: sqlite3.Connection, run_id: str) -> str:
        row = connection.execute("SELECT state FROM runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise ValueError(f"Unknown Production Run: {run_id}")
        return str(row["state"])

    def _start_exploration(self, run_id: str) -> None:
        with self._connect() as connection, connection:
            state = self._run_state(connection, run_id)
            if state == "preparing":
                transition_run(
                    connection,
                    run_id,
                    state,
                    "exploring",
                    details={"entity_id": run_id, "entity_type": "production_run"},
                )
            elif state == "verifying":
                open_count = connection.execute(
                    """SELECT COUNT(*) FROM coverage_obligations
                       WHERE run_id = ? AND disposition = 'open'""",
                    (run_id,),
                ).fetchone()[0]
                if open_count:
                    transition_run(
                        connection,
                        run_id,
                        state,
                        "exploring",
                        details={"entity_id": run_id, "entity_type": "production_run"},
                    )

    def _finish_exploration(self, run_id: str) -> None:
        with self._connect() as connection, connection:
            if self._run_state(connection, run_id) == "exploring":
                transition_run(
                    connection,
                    run_id,
                    "exploring",
                    "verifying",
                    details={"entity_id": run_id, "entity_type": "production_run"},
                )

    def _fail_run(self, connection: sqlite3.Connection, run_id: str, warning: str) -> None:
        state = self._run_state(connection, run_id)
        if state != "failed":
            transition_run(
                connection,
                run_id,
                state,
                "failed",
                error=warning,
                details={"entity_id": run_id, "entity_type": "production_run"},
            )

    def _fail(self, run_id: str, warning: str) -> SchedulerOutcome:
        warning = self._warning(warning)
        with self._connect() as connection, connection:
            self._control(connection, run_id)
            connection.execute(
                """UPDATE scheduler_control SET status = 'failed', warning = ?
                   WHERE run_id = ?""",
                (warning, run_id),
            )
            self._fail_run(connection, run_id, warning)
        return SchedulerOutcome(status="failed", warnings=(warning,))
