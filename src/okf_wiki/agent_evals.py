import json
import sqlite3
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic_evals import Dataset

from .investigation_evals import INVESTIGATION_METRICS, evaluate_investigation
from .knowledge_contracts import WorkerProposal
from .query_evals import QUERY_METRICS, evaluate_query
from .scheduler import TaskPlan


AgentRole = Literal["planner", "worker", "verifier", "renderer", "query", "investigator"]
ChangeKind = Literal[
    "model", "prompt", "tool", "classifier", "workflow", "profile", "policy", "schema"
]
ReviewOutcome = Literal["approved", "rejected", "revision_required"]
GATED_CHANGE_KINDS: tuple[ChangeKind, ...] = (
    "model",
    "prompt",
    "tool",
    "classifier",
    "workflow",
    "profile",
    "policy",
    "schema",
)
ROLE_METRICS: dict[AgentRole, tuple[str, ...]] = {
    "planner": (
        "valid_bounded_tasks",
        "priority",
        "overlap",
        "role_selection",
        "scope",
        "concurrency",
        "budgets",
    ),
    "worker": (
        "scope_adherence",
        "claim_atomicity",
        "evidence_validity",
        "conditions",
        "data_carrier_handling",
        "unsupported_output",
    ),
    "verifier": (
        "critical_issue_recall",
        "semantic_issue_recall",
        "false_positive_rate",
        "independent_evidence_reading",
    ),
    "renderer": (
        "grounding",
        "defining_claim_inclusion",
        "contradiction",
        "duplication",
        "readability",
    ),
    "query": QUERY_METRICS,
    "investigator": INVESTIGATION_METRICS,
}
DATASET_VERSION = "v1"
DATASET_ROOT = Path(__file__).with_name("eval_datasets")


class AgentEvalVersions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    tool_schema: str = Field(min_length=1)
    workflow: str = Field(min_length=1)


class AgentTrajectoryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    event: Literal["call", "return", "retry"]
    tool: str = Field(min_length=1, max_length=64)
    outcome: Literal["requested", "ok", "empty", "rejected", "error"]

    @model_validator(mode="after")
    def valid_outcome(self):
        if (self.event == "call") != (self.outcome == "requested"):
            raise ValueError("Agent trajectory call outcomes must be requested")
        if self.event == "return" and self.outcome not in {"ok", "empty"}:
            raise ValueError("Agent trajectory return outcomes must be ok or empty")
        if self.event == "retry" and self.outcome not in {"rejected", "error"}:
            raise ValueError("Agent trajectory retry outcomes must be rejected or error")
        return self


class RoleEvalResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: AgentRole
    case: str = Field(min_length=1)
    output: dict[str, object]
    candidate_id: str | None = Field(default=None, min_length=1)
    trajectory: tuple[AgentTrajectoryEvent, ...] = Field(default=(), max_length=32)


class SemanticJudgeOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: AgentRole
    case: str = Field(min_length=1)
    version: str = Field(min_length=1)
    outcome: Literal["pass", "fail"]
    evidence: tuple[Annotated[str, Field(min_length=1)], ...] = Field(min_length=1)
    rationale: str = Field(min_length=1)


class HumanAdjudication(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: AgentRole
    case: str = Field(min_length=1)
    version: str = Field(min_length=1)
    outcome: ReviewOutcome
    evidence: tuple[Annotated[str, Field(min_length=1)], ...] = Field(min_length=1)
    rationale: str = Field(min_length=1)


class ReleaseEvalManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    change_kinds: tuple[ChangeKind, ...] = Field(min_length=1)
    versions: AgentEvalVersions
    worker_audit_path: Path
    cost_usd: float = Field(ge=0)
    latency_ms: int = Field(ge=0)
    semantic_judges: tuple[SemanticJudgeOutcome, ...]
    human_adjudications: tuple[HumanAdjudication, ...]
    results: tuple[RoleEvalResult, ...]

    @model_validator(mode="after")
    def unique_results(self):
        keys = [(result.role, result.case) for result in self.results]
        if len(keys) != len(set(keys)):
            raise ValueError("Agent Eval results must be unique by role and case")
        judge_keys = [(outcome.role, outcome.case) for outcome in self.semantic_judges]
        if len(judge_keys) != len(set(judge_keys)):
            raise ValueError("Semantic Judge outcomes must be unique by role and case")
        human_keys = [(outcome.role, outcome.case) for outcome in self.human_adjudications]
        if len(human_keys) != len(set(human_keys)):
            raise ValueError("Human adjudications must be unique by role and case")
        return self


class RoleEvalReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: AgentRole
    case: str
    metrics: dict[str, float]
    failures: tuple[str, ...]


class AgentEvalReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset_version: str
    change_kinds: tuple[ChangeKind, ...]
    versions: AgentEvalVersions
    cost_usd: float
    latency_ms: int
    semantic_judges: tuple[SemanticJudgeOutcome, ...]
    human_adjudications: tuple[HumanAdjudication, ...]
    cases: tuple[RoleEvalReport, ...]
    trajectory_failures: tuple[str, ...]
    judge_failures: tuple[str, ...]
    adjudication_failures: tuple[str, ...]
    failures: tuple[str, ...]
    passed: bool
    blocked: bool


def load_role_dataset(
    role: AgentRole, version: str = DATASET_VERSION
) -> Dataset[dict[str, object], dict[str, object], dict[str, object]]:
    path = DATASET_ROOT / version / f"{role}.json"
    if not path.is_file():
        raise ValueError(f"Unknown Agent Eval dataset: {role}/{version}")
    return Dataset[dict[str, object], dict[str, object], dict[str, object]].from_file(path)


def _case(role: AgentRole, name: str):
    dataset = load_role_dataset(role)
    try:
        return next(case for case in dataset.cases if case.name == name)
    except StopIteration as error:
        raise ValueError(f"Unknown {role} Agent Eval case: {name}") from error


def _planner_metrics(
    inputs: dict[str, object], expected: dict[str, object], output: Mapping[str, object]
) -> dict[str, float]:
    try:
        plan = TaskPlan.model_validate(output)
    except ValidationError:
        return {metric: 0.0 for metric in ROLE_METRICS["planner"]}
    tasks = plan.tasks
    obligation_ids = [item for task in tasks for item in task.obligation_ids]
    allowed_obligations = {
        str(item["id"]): item for item in cast(list[dict[str, object]], inputs["obligations"])
    }
    source_ids = set(cast(list[str], inputs["source_ids"]))
    allowed_paths = set(cast(list[str], inputs["allowed_paths"]))
    budget_ceiling = cast(dict[str, int | float], inputs["worker_budgets"])
    scope_valid = all(
        task.source_id in source_ids
        and set(task.obligation_ids) <= allowed_obligations.keys()
        and set(task.allowed_paths) <= allowed_paths
        and all(
            allowed_obligations[obligation_id]["source_id"] == task.source_id
            and allowed_obligations[obligation_id]["path"] in task.allowed_paths
            for obligation_id in task.obligation_ids
        )
        for task in tasks
    )
    return {
        "valid_bounded_tasks": float(bool(tasks)),
        "priority": float(obligation_ids == expected["priority_order"]),
        "overlap": float(len(obligation_ids) == len(set(obligation_ids))),
        "role_selection": float(all(task.agent_role == expected["agent_role"] for task in tasks)),
        "scope": float(scope_valid),
        "concurrency": float(len(tasks) <= cast(int, inputs["max_tasks"])),
        "budgets": float(
            all(
                value <= budget_ceiling[name]
                for task in tasks
                for name, value in task.budgets.model_dump().items()
            )
        ),
    }


def _worker_metrics(
    inputs: dict[str, object], expected: dict[str, object], output: Mapping[str, object]
) -> dict[str, float]:
    try:
        proposal = WorkerProposal.model_validate(output)
    except ValidationError:
        return {metric: 0.0 for metric in ROLE_METRICS["worker"]}
    expected_claims = cast(list[dict[str, object]], expected["claims"])
    expected_evidence = cast(list[dict[str, object]], expected["evidence"])
    claims_by_text = {claim.text: claim for claim in proposal.claims}
    expected_texts = {str(claim["text"]) for claim in expected_claims}
    expected_evidence_by_id = {str(item["id"]): item for item in expected_evidence}
    scope_valid = (
        proposal.task_id == inputs["task_id"]
        and set(proposal.obligation_ids) == set(cast(list[str], inputs["obligation_ids"]))
        and {item.obligation_id for item in proposal.dispositions}
        == set(cast(list[str], inputs["obligation_ids"]))
        and all(
            item.source_id == inputs["source_id"]
            and item.revision == inputs["revision"]
            and item.path in cast(list[str], inputs["allowed_paths"])
            for item in proposal.evidence
        )
    )
    evidence_valid = len(proposal.evidence) == len(expected_evidence) and all(
        item.id in expected_evidence_by_id
        and all(
            getattr(item, field) == expected_evidence_by_id[item.id][field]
            for field in ("source_id", "path", "revision", "start_line", "end_line", "digest")
        )
        for item in proposal.evidence
    )
    conditions_valid = all(
        str(item["text"]) in claims_by_text
        and set(cast(list[str], item["conditions"]))
        <= set(claims_by_text[str(item["text"])].conditions)
        for item in expected_claims
    )
    concept_names = {concept.name for concept in proposal.concepts}
    data_carriers = set(cast(list[str], inputs["data_carriers"]))
    expected_contracts = set(cast(list[str], expected["data_contract_concepts"]))
    forbidden = set(cast(list[str], expected["forbidden_concepts"])) | data_carriers
    supported_evidence = set(expected_evidence_by_id)
    return {
        "scope_adherence": float(scope_valid),
        "claim_atomicity": float(
            len(proposal.claims) == len(expected_claims) and set(claims_by_text) == expected_texts
        ),
        "evidence_validity": float(evidence_valid),
        "conditions": float(conditions_valid),
        "data_carrier_handling": float(
            expected_contracts <= concept_names and not concept_names & forbidden
        ),
        "unsupported_output": float(
            set(claims_by_text) <= expected_texts
            and all(set(claim.evidence_ids) <= supported_evidence for claim in proposal.claims)
        ),
    }


def _verifier_metrics(
    inputs: dict[str, object], expected: dict[str, object], output: Mapping[str, object]
) -> dict[str, float]:
    findings = output.get("findings")
    if not isinstance(findings, list) or any(not isinstance(item, dict) for item in findings):
        return {
            "critical_issue_recall": 0.0,
            "semantic_issue_recall": 0.0,
            "false_positive_rate": 1.0,
            "independent_evidence_reading": 0.0,
        }
    typed_findings = cast(list[dict[str, object]], findings)
    expected_issues = cast(list[dict[str, str]], expected["issues"])
    expected_critical = {item["id"] for item in expected_issues if item["kind"] == "critical"}
    expected_semantic = {item["id"] for item in expected_issues if item["kind"] == "semantic"}
    flagged = {
        str(item.get("target_id"))
        for item in typed_findings
        if item.get("verdict") in {"fail", "disputed"}
    }
    critical = {
        str(item.get("target_id"))
        for item in typed_findings
        if item.get("verdict") in {"fail", "disputed"} and item.get("severity") == "critical"
    }
    candidate_evidence = set(cast(list[str], inputs["candidate_evidence_ids"]))
    resolvable = set(cast(list[str], inputs["resolvable_reread_references"]))

    def valid_reread(item: dict[str, object]) -> bool:
        evidence = item.get("evidence")
        if (
            not isinstance(evidence, list)
            or not evidence
            or any(not isinstance(reference, str) for reference in evidence)
        ):
            return False
        references = cast(list[str], evidence)
        return set(references) <= resolvable and any(
            reference not in candidate_evidence for reference in references
        )

    independently_read = bool(flagged) and all(
        valid_reread(item) for item in typed_findings if str(item.get("target_id")) in flagged
    )

    def recall(found: set[str], wanted: set[str]) -> float:
        return len(found & wanted) / len(wanted) if wanted else 1.0

    expected_ids = expected_critical | expected_semantic
    return {
        "critical_issue_recall": recall(critical, expected_critical),
        "semantic_issue_recall": recall(flagged, expected_semantic),
        "false_positive_rate": len(flagged - expected_ids) / len(flagged) if flagged else 0.0,
        "independent_evidence_reading": float(independently_read),
    }


def _renderer_metrics(
    inputs: dict[str, object], expected: dict[str, object], output: Mapping[str, object]
) -> dict[str, float]:
    pages = output.get("pages")
    claims_by_page = output.get("claim_ids_by_page")
    if not isinstance(pages, dict) or not isinstance(claims_by_page, dict):
        return {metric: 0.0 for metric in ROLE_METRICS["renderer"]}
    if any(not isinstance(path, str) or not isinstance(text, str) for path, text in pages.items()):
        return {metric: 0.0 for metric in ROLE_METRICS["renderer"]}
    typed_pages = cast(dict[str, str], pages)
    typed_claims = {
        str(path): set(cast(list[str], claim_ids))
        for path, claim_ids in claims_by_page.items()
        if isinstance(claim_ids, list)
    }
    accepted_claims = set(cast(list[str], inputs["claim_ids"]))
    required_claims = set(cast(list[str], expected["required_claim_ids"]))
    rendered_claims = set().union(*typed_claims.values()) if typed_claims else set()
    grounding = (
        set(cast(list[str], expected["required_pages"])) <= typed_pages.keys()
        and required_claims <= rendered_claims <= accepted_claims
        and all(
            all(f"claims: {claim_id}" in typed_pages.get(path, "") for claim_id in claim_ids)
            for path, claim_ids in typed_claims.items()
        )
    )
    contradiction_free = all(
        not set(pair) <= rendered_claims for pair in cast(list[list[str]], inputs["contradictions"])
    )
    paragraphs = [
        paragraph.strip()
        for page in typed_pages.values()
        for paragraph in page.split("\n\n")
        if paragraph.strip()
        and not paragraph.lstrip().startswith("#")
        and not paragraph.lstrip().startswith("<!--")
    ]
    normalized = [" ".join(paragraph.casefold().split()) for paragraph in paragraphs]
    return {
        "grounding": float(grounding),
        "defining_claim_inclusion": float(
            set(cast(list[str], inputs["defining_claim_ids"])) <= rendered_claims
        ),
        "contradiction": float(contradiction_free),
        "duplication": float(len(normalized) == len(set(normalized))),
        "readability": float(
            all(page.lstrip().startswith("# ") for page in typed_pages.values())
            and all(
                len(paragraph.split()) <= cast(int, expected["max_paragraph_words"])
                for paragraph in paragraphs
            )
        ),
    }


def evaluate_role(
    role: AgentRole, case_name: str, output: Mapping[str, object]
) -> dict[str, float]:
    case = _case(role, case_name)
    inputs = cast(dict[str, object], case.inputs)
    expected = cast(dict[str, object], case.expected_output)
    if role == "planner":
        return _planner_metrics(inputs, expected, output)
    if role == "worker":
        return _worker_metrics(inputs, expected, output)
    if role == "verifier":
        return _verifier_metrics(inputs, expected, output)
    if role == "renderer":
        return _renderer_metrics(inputs, expected, output)
    if role == "query":
        return evaluate_query(case_name, dict(output))
    if role == "investigator":
        return evaluate_investigation(case_name, dict(output))
    raise ValueError(f"Agent Eval is not implemented for role: {role}")


def _metric_failures(
    role: AgentRole,
    case_name: str,
    metrics: dict[str, float],
    thresholds: dict[str, object],
) -> tuple[str, ...]:
    failures = []
    for metric, raw_threshold in thresholds.items():
        threshold = cast(dict[str, float], raw_threshold)
        value = metrics.get(metric)
        if value is None:
            failures.append(f"{role}:{case_name}:{metric}")
        elif "minimum" in threshold and value < threshold["minimum"]:
            failures.append(f"{role}:{case_name}:{metric}")
        elif "maximum" in threshold and value > threshold["maximum"]:
            failures.append(f"{role}:{case_name}:{metric}")
    return tuple(failures)


def _worker_trajectory_failures(
    audit_path: Path,
    case_name: str,
    inputs: dict[str, object],
    result: RoleEvalResult | None,
) -> tuple[str, ...]:
    prefix = f"worker:{case_name}:trajectory:"
    if result is None:
        return (prefix + "missing_result",)
    if result.candidate_id is None:
        return (prefix + "missing_candidate",)
    if not audit_path.is_file():
        return (prefix + "missing_audit",)
    try:
        with sqlite3.connect(f"{audit_path.resolve().as_uri()}?mode=ro", uri=True) as connection:
            row = connection.execute(
                """SELECT status, proposal_json, trajectory_json
                   FROM worker_candidates WHERE id = ?""",
                (result.candidate_id,),
            ).fetchone()
    except sqlite3.Error:
        return (prefix + "invalid_audit",)
    if row is None:
        return (prefix + "missing_candidate",)
    if row[0] != "accepted":
        return (prefix + "candidate_not_accepted",)
    try:
        proposal = json.loads(row[1]) if row[1] else None
        trajectory = json.loads(row[2]) if row[2] else None
    except TypeError, json.JSONDecodeError:
        return (prefix + "invalid_audit",)
    if proposal != result.output:
        return (prefix + "audit_mismatch",)
    if not isinstance(trajectory, list) or not trajectory:
        return (prefix + "missing_trajectory",)
    if any(not isinstance(event, dict) for event in trajectory):
        return (prefix + "invalid_audit",)
    detected = evaluate_trajectory(
        cast(list[dict[str, object]], trajectory),
        allowed_tools=tuple(cast(list[str], inputs["allowed_tools"])),
        allowed_paths=tuple(cast(list[str], inputs["allowed_paths"])),
        tool_calls_limit=cast(int, inputs["tool_calls_limit"]),
    )
    return tuple(prefix + failure for failure in detected)


def _read_only_trajectory_failures(
    role: Literal["query", "investigator"],
    case_name: str,
    inputs: dict[str, object],
    result: RoleEvalResult | None,
) -> tuple[str, ...]:
    prefix = f"{role}:{case_name}:trajectory:"
    if result is None:
        return (prefix + "missing_result",)
    if not result.trajectory:
        return (prefix + "missing_trajectory",)
    allowed = set(cast(list[str], inputs["allowed_tools"]))
    calls = [event for event in result.trajectory if event.event == "call"]
    failures = []
    if any(event.tool not in allowed for event in result.trajectory):
        failures.append(prefix + "disallowed_tool")
    if len(calls) > cast(int, inputs["tool_calls_limit"]):
        failures.append(prefix + "tool_budget")
    outstanding = None
    invalid_sequence = False
    for event in result.trajectory:
        if event.event == "call":
            if outstanding is not None:
                invalid_sequence = True
                break
            outstanding = event.tool
        elif outstanding != event.tool:
            invalid_sequence = True
            break
        else:
            outstanding = None
    if invalid_sequence or outstanding is not None:
        failures.append(prefix + "invalid_sequence")
    return tuple(failures)


def evaluate_release(manifest: ReleaseEvalManifest) -> AgentEvalReport:
    results = {(result.role, result.case): result for result in manifest.results}
    judges = {(outcome.role, outcome.case): outcome for outcome in manifest.semantic_judges}
    adjudications = {
        (outcome.role, outcome.case): outcome for outcome in manifest.human_adjudications
    }
    case_reports = []
    failures = []
    trajectory_failures = []
    judge_failures = []
    adjudication_failures = []
    for role in ROLE_METRICS:
        dataset = load_role_dataset(role)
        for case in dataset.cases:
            if case.name is None:
                continue
            result = results.get((role, case.name))
            metrics = evaluate_role(role, case.name, result.output if result else {})
            metadata = cast(dict[str, object], case.metadata)
            case_failures = _metric_failures(
                role,
                case.name,
                metrics,
                cast(dict[str, object], metadata["thresholds"]),
            )
            failures.extend(case_failures)
            case_reports.append(
                RoleEvalReport(
                    role=role,
                    case=case.name,
                    metrics=metrics,
                    failures=case_failures,
                )
            )
            judge = judges.get((role, case.name))
            if judge is None:
                judge_failures.append(f"{role}:{case.name}:semantic_judge:missing")
            elif judge.outcome != "pass":
                judge_failures.append(f"{role}:{case.name}:semantic_judge:{judge.outcome}")
            adjudication = adjudications.get((role, case.name))
            if adjudication is None:
                adjudication_failures.append(f"{role}:{case.name}:human_adjudication:missing")
            elif adjudication.outcome != "approved":
                adjudication_failures.append(
                    f"{role}:{case.name}:human_adjudication:{adjudication.outcome}"
                )
            if role == "worker":
                trajectory_failures.extend(
                    _worker_trajectory_failures(
                        manifest.worker_audit_path,
                        case.name,
                        case.inputs,
                        result,
                    )
                )
            elif role == "query":
                trajectory_failures.extend(
                    _read_only_trajectory_failures("query", case.name, case.inputs, result)
                )
            elif role == "investigator":
                trajectory_failures.extend(
                    _read_only_trajectory_failures("investigator", case.name, case.inputs, result)
                )
    failures.extend(trajectory_failures)
    failures.extend(judge_failures)
    failures.extend(adjudication_failures)
    passed = not failures
    return AgentEvalReport(
        dataset_version=DATASET_VERSION,
        change_kinds=manifest.change_kinds,
        versions=manifest.versions,
        cost_usd=manifest.cost_usd,
        latency_ms=manifest.latency_ms,
        semantic_judges=manifest.semantic_judges,
        human_adjudications=manifest.human_adjudications,
        cases=tuple(case_reports),
        trajectory_failures=tuple(trajectory_failures),
        judge_failures=tuple(judge_failures),
        adjudication_failures=tuple(adjudication_failures),
        failures=tuple(failures),
        passed=passed,
        blocked=not passed,
    )


def evaluate_trajectory(
    events: Sequence[Mapping[str, object]],
    *,
    allowed_tools: tuple[str, ...],
    allowed_paths: tuple[str, ...],
    tool_calls_limit: int,
) -> tuple[str, ...]:
    calls = [
        event
        for event in events
        if event.get("event") == "call"
        and event.get("tool_kind") != "output"
        and event.get("tool") != "final_result"
    ]
    empty_returns = {
        event.get("tool_call_id")
        for event in events
        if event.get("event") == "return" and event.get("result_empty") is True
    }
    productive_returns = {
        event.get("tool_call_id")
        for event in events
        if event.get("event") == "return" and event.get("result_empty") is False
    }
    low_value_searches = Counter(
        json.dumps(event.get("args", {}), sort_keys=True, default=str)
        for event in calls
        if event.get("tool") == "search_text" and event.get("tool_call_id") in empty_returns
    )
    # ponytail: lexical DTO detection; use corpus labels if naming conventions stop being useful.
    dto_calls = sum(
        any(
            term in json.dumps(event.get("args", {})).casefold()
            for term in ("dto", "request", "response", "payload")
        )
        for event in calls
    )
    allowed_tool_set = set(allowed_tools)
    allowed_path_set = set(allowed_paths)

    def selected_paths(event: Mapping[str, object]) -> set[str]:
        args = event.get("args")
        if not isinstance(args, dict):
            return set()
        path = args.get("path")
        paths = args.get("paths")
        selected = {path} if isinstance(path, str) else set()
        if isinstance(paths, list):
            selected.update(item for item in paths if isinstance(item, str))
        return selected

    checks = {
        "repeated_low_value_search": any(count > 1 for count in low_value_searches.values()),
        "excessive_dto_attention": dto_calls >= 3 and dto_calls * 2 >= max(1, len(calls)),
        "needless_tools": any(
            event.get("tool") not in allowed_tool_set or event.get("needed") is False
            for event in calls
        ),
        "retry_loops": sum(event.get("event") == "retry" for event in events) >= 3,
        "scope_violations": any(event.get("scope_violation") is True for event in events)
        or any(selected_paths(event) - allowed_path_set for event in calls),
        "budget_waste": len(calls) >= tool_calls_limit and len(productive_returns) * 2 < len(calls),
    }
    return tuple(name for name, detected in checks.items() if detected)
