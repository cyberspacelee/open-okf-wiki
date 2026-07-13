import asyncio
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from pydantic import BaseModel, ConfigDict
from pydantic_ai import Agent, ModelResponse
from pydantic_ai.messages import RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from .agent_evals import (
    AgentEvalReport,
    ReleaseEvalManifest,
    evaluate_release,
    load_role_dataset,
)
from .benchmark_corpus import (
    BenchmarkCorpus,
    CORPUS_ROOT,
    MaterializedCorpus,
    git_write,
    source_text,
)
from .knowledge_contracts import (
    AnalysisTask,
    ObligationSummary,
    WorkerBudgets,
    WorkerProposal,
)
from .planner import PlannerAgent
from .query_agent import KnowledgeQueryContext, QueryAgent
from .scheduler import PlannerSummary, RemainingBudgets, SourceSummary
from .state_schema import migrate_state
from .verification import VerificationSource, VerificationTarget
from .verifier import VerifierAgent
from .worker import WorkerAgent


QUERY_RUN_ID = "run-1"
QUERY_SOURCE_SET_DIGEST = "digest-1"
QUERY_CLAIM_ID = "claim:" + "a" * 64
QUERY_EVIDENCE_ID = "evidence:" + "b" * 64
QUERY_CONCEPT_ID = "concept:" + "c" * 64
QUERY_STATEMENT = "Accepted query answers use exact evidence."


@dataclass(frozen=True)
class AgentEvalExecution:
    report: AgentEvalReport
    invocations: dict[str, int]
    function_tools: dict[str, tuple[str, ...]]


@dataclass(frozen=True)
class WorkerAuditTotals:
    candidates: int = 0
    tokens: int = 0
    tool_calls: int = 0
    latency_ms: int = 0
    retries: int = 0
    failures: int = 0


def aggregate_worker_audits(*paths: Path) -> WorkerAuditTotals:
    totals = WorkerAuditTotals()
    for path in paths:
        with sqlite3.connect(path) as connection:
            rows = connection.execute(
                "SELECT status, usage_json, latency_ms, retry_count FROM worker_candidates"
            )
            for status, usage_json, latency_ms, retries in rows:
                usage = json.loads(usage_json)
                totals = WorkerAuditTotals(
                    candidates=totals.candidates + 1,
                    tokens=totals.tokens + usage["total_tokens"],
                    tool_calls=totals.tool_calls + usage["tool_calls"],
                    latency_ms=totals.latency_ms + latency_ms,
                    retries=totals.retries + retries,
                    failures=totals.failures + (status != "accepted"),
                )
    return totals


def extract_function_tools(messages) -> tuple[str, ...]:
    return tuple(
        part.tool_name
        for message in messages
        for part in message.parts
        if isinstance(part, ToolCallPart) and part.tool_name != "final_result"
    )


def _planner_output(function_tools: dict[str, list[str]]) -> dict:
    fixture = json.loads((CORPUS_ROOT / "v1" / "agent-eval.json").read_text())
    output = next(item["output"] for item in fixture["results"] if item["role"] == "planner")

    def function(messages, info: AgentInfo) -> ModelResponse:
        function_tools["planner"].extend(extract_function_tools(messages))
        return ModelResponse([ToolCallPart(info.output_tools[0].name, output, "planner")])

    summary = PlannerSummary(
        run_id="agent-eval",
        project_id="agent-eval",
        producer_profile_id="profile:agent-eval",
        source_set=(
            SourceSummary(id="source-1", revision="1" * 40, role="implementation", path_count=2),
        ),
        coverage={"open": 2},
        prioritized_obligations=(
            ObligationSummary(
                id="major-1",
                source_id="source-1",
                path="src/Order.java",
                source_unit="unit-1",
                kind="java_type",
                priority="major",
                text="Major",
            ),
            ObligationSummary(
                id="supporting-1",
                source_id="source-1",
                path="README.md",
                source_unit="unit-2",
                kind="normative_statement",
                priority="supporting",
                text="Supporting",
            ),
        ),
        active_tasks=(),
        remaining_budgets=RemainingBudgets(task_slots=2, replans=2, worker=WorkerBudgets()),
        receipts=(),
    )
    return asyncio.run(PlannerAgent(FunctionModel(function)).plan(summary)).model_dump(mode="json")


def _worker_output(
    corpus: BenchmarkCorpus,
    materialized: MaterializedCorpus,
    workspace: Path,
    model_version: str,
) -> tuple[dict, str]:
    repository = materialized.repositories["contracts"]
    revision = materialized.base_revisions["contracts"]
    path = "src/main/java/example/CreateOrderRequest.java"
    output = json.loads((CORPUS_ROOT / corpus.version / "worker-eval.json").read_text())

    def function(messages, info: AgentInfo) -> ModelResponse:
        returned = any(
            isinstance(part, ToolReturnPart) for message in messages for part in message.parts
        )
        if not returned:
            return ModelResponse(
                [ToolCallPart("read_text", {"path": path, "start_line": 1, "end_line": 1}, "read")]
            )
        return ModelResponse([ToolCallPart(info.output_tools[0].name, output, "output")])

    audit = workspace / "agent-eval-worker.db"
    result = asyncio.run(
        WorkerAgent(
            FunctionModel(function),
            audit_path=audit,
            gateway_id="benchmark",
            model_name=model_version,
            max_concurrency=1,
        ).run(
            AnalysisTask(
                task_id="task-1",
                obligation_ids=("data-contract-1",),
                source_id="source-1",
                repository=repository,
                revision=revision,
                allowed_paths=(path,),
                prompt="Extract the reviewed Data Contract.",
                budgets=WorkerBudgets(),
            )
        )
    )
    if result.status != "accepted" or result.proposal is None:
        raise ValueError(f"Benchmark Worker Agent fixture failed: {result.errors}")
    return result.proposal.model_dump(mode="json"), result.candidate_id


def _verifier_output(
    materialized: MaterializedCorpus, function_tools: dict[str, list[str]]
) -> dict:
    repository = materialized.repositories["contracts"]
    revision = materialized.base_revisions["contracts"]
    path = "src/main/java/example/CreateOrderRequest.java"
    text = source_text(repository, revision, path).strip()
    digest = f"sha256:{hashlib.sha256(text.encode()).hexdigest()}"
    proposal = WorkerProposal.model_validate(
        {
            "task_id": "verifier-eval",
            "obligation_ids": ["verifier-obligation"],
            "evidence": [
                {
                    "id": "evidence-critical",
                    "source_id": "source-1",
                    "path": path,
                    "revision": revision,
                    "start_line": 1,
                    "end_line": 1,
                    "digest": digest,
                },
                {
                    "id": "evidence-semantic",
                    "source_id": "source-1",
                    "path": path,
                    "revision": revision,
                    "start_line": 1,
                    "end_line": 1,
                    "digest": digest,
                },
            ],
            "claims": [
                {
                    "id": "claim-critical",
                    "text": "Critical issue.",
                    "evidence_ids": ["evidence-critical"],
                },
                {
                    "id": "claim-semantic",
                    "text": "Semantic issue.",
                    "evidence_ids": ["evidence-semantic"],
                },
            ],
            "concepts": [
                {
                    "id": "concept",
                    "name": "Verifier Eval",
                    "description": "Verifier eval concept.",
                    "claim_ids": ["claim-critical", "claim-semantic"],
                }
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": "verifier-obligation",
                    "disposition": "covered",
                    "reason": "Eval",
                    "evidence_ids": ["evidence-critical"],
                }
            ],
        }
    )
    target = VerificationTarget(
        run_id="agent-eval",
        candidate_id="verifier-candidate",
        proposal=proposal,
        sources=(
            VerificationSource(
                id="source-1", repository=repository, revision=revision, role="reference"
            ),
        ),
        obligations=(),
    )
    findings = []
    for target_id, severity in (("claim-critical", "critical"), ("claim-semantic", "error")):

        def function(
            messages, info: AgentInfo, target_id=target_id, severity=severity
        ) -> ModelResponse:
            function_tools["verifier"].extend(extract_function_tools(messages))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "target_id": target_id,
                            "target_type": "claim",
                            "perspective": "evidence_entailment",
                            "verdict": "fail",
                            "severity": severity,
                            "evidence": ["evidence-semantic"],
                            "rationale": "The reviewed fixture contains this issue.",
                        },
                        f"verify-{target_id}",
                    )
                ]
            )

        finding = asyncio.run(
            VerifierAgent(FunctionModel(function)).verify("evidence_entailment", target)
        )
        findings.append(finding.model_dump(mode="json"))
    return {"findings": findings}


class RendererOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pages: dict[str, str]
    claim_ids_by_page: dict[str, list[str]]


def _renderer_output(function_tools: dict[str, list[str]]) -> dict:
    fixture = json.loads((CORPUS_ROOT / "v1" / "agent-eval.json").read_text())
    output = next(item["output"] for item in fixture["results"] if item["role"] == "renderer")

    def function(messages, info: AgentInfo) -> ModelResponse:
        function_tools["renderer"].extend(extract_function_tools(messages))
        return ModelResponse([ToolCallPart(info.output_tools[0].name, output, "renderer")])

    result = Agent[None, RendererOutput](
        FunctionModel(function), output_type=RendererOutput, name="renderer_eval"
    ).run_sync("Render the reviewed accepted knowledge fixture.")
    return result.output.model_dump(mode="json")


def _query_database(workspace: Path) -> Path:
    root = workspace / "agent-eval-query"
    source = root / "source"
    source.mkdir(parents=True)
    (source / "README.md").write_text(QUERY_STATEMENT + "\n", encoding="utf-8")
    git_write(source, "init", "-q")
    git_write(source, "add", "README.md")
    git_write(
        source,
        "-c",
        "user.name=OKF Benchmark",
        "-c",
        "user.email=benchmark@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-qm",
        "query eval",
    )
    revision = git_write(source, "rev-parse", "HEAD")
    release = root / ".published.releases" / QUERY_RUN_ID
    (release / "concepts").mkdir(parents=True)
    (release / "concepts" / "query.md").write_text(
        f"# Query Agent\n\n{QUERY_STATEMENT}\n\n<!-- claims: {QUERY_CLAIM_ID} -->\n",
        encoding="utf-8",
    )
    source_set = {
        "digest": QUERY_SOURCE_SET_DIGEST,
        "sources": [
            {
                "id": "docs",
                "repository": str(source),
                "revision": revision,
                "role": "documentation",
            }
        ],
    }
    database = root / "runs.db"
    with sqlite3.connect(database) as connection:
        migrate_state(connection)
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'agent-eval', ?, ?, ?, ?, 'published', ?, '2026-01-01',
                       '2026-01-01')""",
            (
                QUERY_RUN_ID,
                str(source),
                revision,
                str(root / "published"),
                str(release),
                json.dumps(source_set),
            ),
        )
        connection.execute(
            "INSERT INTO accepted_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                QUERY_RUN_ID,
                QUERY_EVIDENCE_ID,
                "docs",
                revision,
                "README.md",
                "unit:readme",
                1,
                1,
                "sha256:" + hashlib.sha256(QUERY_STATEMENT.encode()).hexdigest(),
                "source_span",
                "source_snapshot",
            ),
        )
        connection.execute(
            "INSERT INTO accepted_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                QUERY_RUN_ID,
                QUERY_CLAIM_ID,
                "Query Agent",
                "uses",
                QUERY_STATEMENT,
                "asserted",
                "[]",
                "supported",
            ),
        )
        connection.execute(
            "INSERT INTO claim_evidence VALUES (?, ?, ?)",
            (QUERY_RUN_ID, QUERY_CLAIM_ID, QUERY_EVIDENCE_ID),
        )
        connection.execute(
            "INSERT INTO accepted_concepts VALUES (?, ?, ?, ?, ?, ?)",
            (
                QUERY_RUN_ID,
                QUERY_CONCEPT_ID,
                "Query Agent",
                "[]",
                "Grounded answers.",
                "active",
            ),
        )
        connection.execute(
            "INSERT INTO concept_claims VALUES (?, ?, ?, ?)",
            (QUERY_RUN_ID, QUERY_CONCEPT_ID, QUERY_CLAIM_ID, "defining"),
        )
        connection.execute(
            "INSERT INTO page_plans VALUES (?, ?, ?, ?)",
            (QUERY_RUN_ID, QUERY_CONCEPT_ID, "concepts/query.md", "Query Agent"),
        )
    return database


def _query_trajectory(messages) -> list[dict[str, str]]:
    trajectory = []
    for message in messages:
        for part in message.parts:
            if isinstance(part, ToolCallPart) and part.tool_kind != "output":
                trajectory.append({"event": "call", "tool": part.tool_name, "outcome": "requested"})
            elif isinstance(part, ToolReturnPart):
                trajectory.append(
                    {
                        "event": "return",
                        "tool": part.tool_name,
                        "outcome": "empty" if part.content in (None, "", [], {}) else "ok",
                    }
                )
            elif isinstance(part, RetryPromptPart) and part.tool_name != "final_result":
                trajectory.append({"event": "retry", "tool": part.tool_name, "outcome": "rejected"})
    return trajectory


def _query_output(
    database: Path, model_version: str, case_name: str
) -> tuple[dict, list[dict[str, str]]]:
    case = next(case for case in load_role_dataset("query").cases if case.name == case_name)
    question = cast(str, case.inputs["question"])
    messages = []

    def function(current, info: AgentInfo) -> ModelResponse:
        messages[:] = current
        returns = [
            part
            for message in current
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if case_name == "grounded-answer":
            if not returns:
                part = ToolCallPart("renderable_claims", {"concept_id": QUERY_CONCEPT_ID}, "claims")
            elif len(returns) == 1:
                part = ToolCallPart(
                    "read_evidence",
                    {"claim_id": QUERY_CLAIM_ID, "evidence_id": QUERY_EVIDENCE_ID},
                    "evidence",
                )
            else:
                part = ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "segments": [
                            {
                                "kind": "fact",
                                "claim_ids": [QUERY_CLAIM_ID],
                                "evidence_ids": [QUERY_EVIDENCE_ID],
                            }
                        ]
                    },
                    "answer",
                )
        elif not returns:
            part = ToolCallPart("find_concepts", {"query": question}, "find")
        else:
            part = ToolCallPart(
                info.output_tools[0].name,
                {"segments": [{"kind": "insufficient_support"}]},
                "refuse",
            )
        return ModelResponse([part])

    context = KnowledgeQueryContext(
        run_id=QUERY_RUN_ID,
        source_set_digest=QUERY_SOURCE_SET_DIGEST,
        bundle="published",
        scope="concept",
        page="concepts/query.md",
        concept_id=QUERY_CONCEPT_ID,
        claim_ids=(QUERY_CLAIM_ID,) if case_name == "grounded-answer" else (),
    )
    try:
        answer = asyncio.run(
            QueryAgent(
                FunctionModel(function),
                database=database,
                model_name=model_version,
            ).ask(context, question)
        )
    except Exception:
        return {}, _query_trajectory(messages)
    return answer.model_dump(mode="json"), _query_trajectory(messages)


def execute_agent_eval(
    corpus: BenchmarkCorpus,
    materialized: MaterializedCorpus,
    workspace: Path,
    model_version: str,
) -> AgentEvalExecution:
    tools = {role: [] for role in ("planner", "worker", "verifier", "renderer", "query")}
    planner = _planner_output(tools)
    worker, candidate_id = _worker_output(corpus, materialized, workspace, model_version)
    verifier = _verifier_output(materialized, tools)
    renderer = _renderer_output(tools)
    query_database = _query_database(workspace)
    queries = {
        case: _query_output(query_database, model_version, case)
        for case in ("grounded-answer", "prompt-injection-refusal")
    }
    payload = json.loads((CORPUS_ROOT / corpus.version / "agent-eval.json").read_text())
    outputs = {"planner": planner, "worker": worker, "verifier": verifier, "renderer": renderer}
    for result in payload["results"]:
        if result["role"] == "query":
            result["output"], result["trajectory"] = queries[result["case"]]
            tools["query"].extend(
                event["tool"] for event in result["trajectory"] if event["event"] == "call"
            )
        else:
            result["output"] = outputs[result["role"]]
        if result["role"] == "worker":
            result["candidate_id"] = candidate_id
    payload["worker_audit_path"] = str(workspace / "agent-eval-worker.db")
    report = evaluate_release(ReleaseEvalManifest.model_validate(payload))
    return AgentEvalExecution(
        report=report,
        invocations={
            "planner": 1,
            "worker": 1,
            "verifier": 2,
            "renderer": 1,
            "query": len(queries),
        },
        function_tools={key: tuple(value) for key, value in tools.items()},
    )
