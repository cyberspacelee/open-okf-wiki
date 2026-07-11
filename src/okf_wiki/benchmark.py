import asyncio
import hashlib
import io
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stdout
from dataclasses import dataclass
from importlib.metadata import version as package_version
from itertools import combinations
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

from .accepted_knowledge import AcceptedKnowledgeStore, ClaimRecord, ConceptRecord
from .agent_evals import AgentEvalReport
from .benchmark_agent_eval import (
    aggregate_worker_audits,
    execute_agent_eval,
    extract_function_tools,
)
from .benchmark_corpus import (
    CORPUS_ROOT,
    BenchmarkCorpus,
    GoldDefinition,
    MaterializedCorpus,
    MutationCase,
    MutationKind,
    ReleaseManifest,
    SemanticClaim,
    git_write,
    load_benchmark_corpus,
    materialize_corpus,
    resolve_marker,
    source_text,
)
from .cli import build, check, finish_run, review
from .coverage import obligation_rows
from .knowledge_contracts import AnalysisTask, WorkerBudgets, WorkerRunResult
from .scheduler import PlannerLimits, PlannedTask, Scheduler, TaskPlan


MODEL_VERSION = "function-model-v1"
PROMPT_VERSION = "benchmark-semantic-v1"
TOOL_SCHEMA_VERSION = "git-snapshot-v1"
GATEWAY_TEST_VERSION = "gateway-contract-v1"
NONSEMANTIC_OBLIGATION_KINDS = frozenset({"impact_reverification", "new_source_unit"})
OPERATIONAL_BUNDLE_DOCUMENTS = frozenset({"reports/coverage.md", "reports/review.md"})


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GatewayStatus(StrictModel):
    version: str = GATEWAY_TEST_VERSION
    status: Literal[
        "not_required",
        "required_credentials_unavailable",
        "passed",
        "failed",
    ]
    live: bool
    passed: bool
    evidence: str


class BenchmarkVersions(StrictModel):
    python: str
    pydantic_ai: str
    model: str = MODEL_VERSION
    prompt: str = PROMPT_VERSION
    tool_schema: str = TOOL_SCHEMA_VERSION
    gateway_capability_tests: str = GATEWAY_TEST_VERSION


class SemanticMetrics(StrictModel):
    supported_claim_precision: float
    major_claim_recall: float
    concept_precision: float
    concept_recall: float
    wrong_merge_split_rate: float
    critical_unsupported_claims: int


class StabilityMetrics(StrictModel):
    major_closure: float
    critical_finding_variance: int
    major_claim_similarity: float
    canonical_concept_similarity: float


class SecurityReport(StrictModel):
    read_only_sources: bool
    bundle_validation: bool


class BenchmarkCosts(StrictModel):
    aggregation: Literal["sum"]
    sources: tuple[str, ...]
    worker_candidates: int
    tokens: int
    tool_calls: int
    latency_ms: int
    retries: int
    human_reviews: int
    failures: int
    cost_usd: float


class MutationReport(StrictModel):
    case_id: str
    kind: MutationKind
    applied: bool
    effect: str
    equivalent: bool
    passed: bool


class RoleTrajectoryReport(StrictModel):
    invocations: int
    function_tools: tuple[str, ...]
    passed: bool


class BenchmarkReport(StrictModel):
    corpus_version: str
    executed_runs: int
    repeated_runs: int
    versions: BenchmarkVersions
    gateway: GatewayStatus
    hard_gates: dict[str, bool]
    semantic_metrics: SemanticMetrics
    stability: StabilityMetrics
    incremental_full_equivalent: bool
    mutations: tuple[MutationReport, ...]
    security: SecurityReport
    agent_eval_passed: bool
    agent_eval: AgentEvalReport
    role_trajectories: dict[str, RoleTrajectoryReport]
    nonsemantic_metadata_excluded: tuple[str, ...]
    costs: BenchmarkCosts
    failures: tuple[str, ...]
    blocking_metric: str | None
    passed: bool
    blocked: bool

    @model_validator(mode="after")
    def complete_incremental_equivalence(self):
        if self.incremental_full_equivalent and not all(
            mutation.equivalent for mutation in self.mutations
        ):
            raise ValueError(
                "incremental_full_equivalent cannot pass when a Mutation Case is not equivalent"
            )
        return self


@dataclass(frozen=True)
class RunObservation:
    run_id: str
    source_revisions: dict[str, str]
    obligations: tuple[dict, ...]
    claims: tuple[ClaimRecord, ...]
    concepts: tuple[ConceptRecord, ...]
    refresh: dict
    review: dict
    bundle_errors: tuple[str, ...]
    major_evidence_resolved: bool
    unexplained_deletions: tuple[str, ...]
    obligation_resolutions: tuple[dict, ...]
    bundle_documents: dict[str, str]

    def semantic_snapshot(self) -> dict[str, object]:
        def normalized_revision(source_id: str) -> str:
            return f"<source-revision:{source_id}>"

        obligations = [
            {
                **{key: value for key, value in item.items() if key != "id"},
                "claim_ids": [] if item["disposition"] == "excluded" else item["claim_ids"],
                "evidence": [
                    (
                        source_id,
                        normalized_revision(source_id),
                        path,
                        start_line,
                        end_line,
                    )
                    for source_id, _revision, path, start_line, end_line in item["evidence"]
                ],
            }
            for item in self.obligation_resolutions
            if item["kind"] not in NONSEMANTIC_OBLIGATION_KINDS
        ]
        bundle_documents = dict(sorted(self.bundle_documents.items()))
        for path, document in bundle_documents.items():
            for source_id, revision in self.source_revisions.items():
                document = document.replace(revision, normalized_revision(source_id))
            document = re.sub(
                r"(?m)^source_revision: [0-9a-f]{64}$",
                "source_revision: <source-set-revision>",
                document,
            )
            document = re.sub(r"(?m)^## \d{4}-\d{2}-\d{2}$", "## <source-date>", document)
            document = re.sub(
                r"Source Set `[0-9a-f]{64}`",
                "Source Set `<source-set-revision>`",
                document,
            )
            document = re.sub(
                r"tree digest `[0-9a-f]{64}`", "tree digest `<tree-digest>`", document
            )
            bundle_documents[path] = document
        return {
            "claims": sorted(
                (
                    {
                        "statement": item["statement"],
                        "status": item["epistemic_status"],
                        "evidence": [
                            {
                                key: evidence[key]
                                for key in (
                                    "source_id",
                                    "path",
                                    "start_line",
                                    "end_line",
                                )
                            }
                            | {"revision": normalized_revision(evidence["source_id"])}
                            for evidence in item["evidence"]
                        ],
                        "conflicts_with": item["conflicts_with"],
                    }
                    for item in self.claims
                    if item["epistemic_status"] != "stale"
                ),
                key=lambda item: item["statement"],
            ),
            "concepts": sorted(
                (
                    {
                        "id": item["id"],
                        "name": item["canonical_name"],
                        "aliases": item["aliases"],
                    }
                    for item in self.concepts
                    if item["status"] != "stale"
                ),
                key=lambda item: item["id"],
            ),
            "obligations": sorted(
                obligations,
                key=lambda item: json.dumps(item, sort_keys=True),
            ),
            "exclusions": sorted(
                json.dumps(item, sort_keys=True)
                for item in obligations
                if item["disposition"] == "excluded"
            ),
            "verification_findings": sorted(
                (
                    {
                        key: finding[key]
                        for key in ("perspective", "verdict", "severity", "rationale", "evidence")
                    }
                    for finding in self.review.get("verification_findings", ())
                    if finding["verdict"] != "pass"
                ),
                key=lambda item: (item["perspective"], item["severity"]),
            ),
            "bundle_documents": bundle_documents,
            "bundle_manifest": {
                path: hashlib.sha256(document.encode()).hexdigest()
                for path, document in bundle_documents.items()
            },
        }


@contextmanager
def _working_directory(path: Path) -> Iterator[None]:
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _capture(command, *args) -> tuple[int, dict]:
    output = io.StringIO()
    with redirect_stdout(output):
        code = command(*args)
    lines = [line for line in output.getvalue().splitlines() if line]
    return code, json.loads(lines[-1]) if lines else {}


def _obligation_evidence(
    repositories: dict[str, Path], revisions: dict[str, str], item: dict, index: int
) -> dict:
    lines = source_text(
        repositories[item["source"]], revisions[item["source"]], item["path"]
    ).splitlines()
    start, end = item["span"]["start_line"], item["span"]["end_line"]
    text = "\n".join(lines[start - 1 : end])
    return {
        "id": f"obligation-evidence:{index}",
        "source_id": item["source"],
        "path": item["path"],
        "revision": revisions[item["source"]],
        "start_line": start,
        "end_line": end,
        "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
    }


def _proposal_for_task(
    task: AnalysisTask,
    corpus: BenchmarkCorpus,
    materialized: MaterializedCorpus,
    revisions: dict[str, str],
    mutation_id: str | None,
    obligations: dict[str, dict],
    external_claims: dict[str, str],
) -> dict:
    available: dict[str, tuple[SemanticClaim, dict]] = {}
    for claim in corpus.semantic.claims:
        evidence = resolve_marker(materialized.repositories, revisions, claim)
        if (
            evidence is not None
            and evidence["source_id"] == task.source_id
            and evidence["path"] in task.allowed_paths
        ):
            available[claim.key] = (claim, evidence)
    evidence = [item[1] for item in available.values()]
    claims = [
        {
            "id": key,
            "subject": claim.subject,
            "predicate": claim.predicate,
            "text": claim.statement,
            "conditions": [claim.exclusion_reason] if claim.exclusion_reason else [],
            "epistemic_status": claim.epistemic_status,
            "evidence_ids": [item["id"]],
            "conflicts_with": [
                target if target in available else external_claims[target]
                for target in claim.conflicts_with
                if target in available or target in external_claims
            ],
        }
        for key, (claim, item) in available.items()
    ]
    concepts = []
    renames = corpus.semantic.renames.get(mutation_id or "", {})
    for concept in corpus.semantic.concepts:
        defining = [item for item in concept.defining_claims if item in available]
        supporting = [item for item in concept.supporting_claims if item in available]
        if defining:
            concepts.append(
                {
                    "id": concept.key,
                    "name": renames.get(concept.key, concept.canonical_name),
                    "aliases": list(concept.aliases),
                    "description": f"Human-reviewed benchmark knowledge for {concept.canonical_name}.",
                    "claim_ids": [*defining, *supporting],
                    "defining_claim_ids": defining,
                    "supporting_claim_ids": supporting,
                }
            )
    dispositions = []
    for index, obligation_id in enumerate(task.obligation_ids):
        obligation = obligations[obligation_id]
        evidence_id = next(
            (
                item["id"]
                for item in evidence
                if item["source_id"] == obligation["source"]
                and item["path"] == obligation["path"]
                and obligation["span"]["start_line"]
                <= item["start_line"]
                <= item["end_line"]
                <= obligation["span"]["end_line"]
            ),
            None,
        )
        covered = evidence_id is not None and obligation["kind"] != "data_contract"
        if not covered:
            extra = _obligation_evidence(materialized.repositories, revisions, obligation, index)
            evidence.append(extra)
            evidence_id = extra["id"]
        dispositions.append(
            {
                "obligation_id": obligation_id,
                "disposition": "covered" if covered else "excluded",
                "reason": (
                    "Grounded by the versioned semantic benchmark fixture."
                    if covered
                    else "Human-reviewed benchmark exclusion outside core semantic gold."
                ),
                "evidence_ids": [evidence_id],
            }
        )
    if not claims:
        claims = [
            {
                "id": "excluded-scope",
                "subject": "Excluded benchmark scope",
                "predicate": "is reviewed as",
                "text": f"Excluded semantic scope for {task.source_id}.",
                "epistemic_status": "stale",
                "evidence_ids": [evidence[0]["id"]],
            }
        ]
    if not concepts:
        concepts = [
            {
                "id": "excluded-scope",
                "name": f"Excluded {task.source_id} scope",
                "description": "A non-rendered typed Worker placeholder.",
                "claim_ids": [claims[0]["id"]],
                "defining_claim_ids": [claims[0]["id"]],
                "status": "stale",
            }
        ]
    return {
        "task_id": task.task_id,
        "obligation_ids": list(task.obligation_ids),
        "evidence": evidence,
        "claims": claims,
        "concepts": concepts,
        "relations": [],
        "dispositions": dispositions,
    }


def _run_semantic_agents(
    workspace: Path,
    run_id: str,
    corpus: BenchmarkCorpus,
    materialized: MaterializedCorpus,
    revisions: dict[str, str],
    mutation_id: str | None,
    role_function_tools: dict[str, list[str]],
    role_invocations: dict[str, int],
) -> None:
    from pydantic_ai import ModelResponse
    from pydantic_ai.messages import ToolCallPart, ToolReturnPart
    from pydantic_ai.models.function import AgentInfo, FunctionModel

    from .planner import PlannerAgent
    from .verification import VerificationFinding, VerificationPerspective, VerificationTarget
    from .verifier import VerifierAgent
    from .worker import WorkerAgent

    database = workspace / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        obligations = {item["id"]: item for item in obligation_rows(connection, run_id)}

    class DeterministicPlanner:
        async def plan(self, summary) -> TaskPlan:
            role_invocations["planner"] += 1
            by_source: dict[str, list] = {}
            for obligation in summary.prioritized_obligations:
                by_source.setdefault(obligation.source_id, []).append(obligation)
            semantic_paths: dict[str, list[str]] = {}
            for claim in corpus.semantic.claims:
                evidence = resolve_marker(materialized.repositories, revisions, claim)
                if evidence is not None:
                    semantic_paths.setdefault(evidence["source_id"], []).append(evidence["path"])
            plan = TaskPlan(
                tasks=tuple(
                    PlannedTask(
                        obligation_ids=tuple(item.id for item in selected),
                        source_id=source_id,
                        allowed_paths=tuple(
                            dict.fromkeys(
                                [
                                    *(item.path for item in selected),
                                    *semantic_paths.get(source_id, ()),
                                ]
                            )
                        ),
                        agent_role="extraction",
                        allowed_tools=("list_paths", "search_text", "read_text"),
                        prompt="Replay the reviewed benchmark semantic fixture.",
                        budgets=WorkerBudgets(),
                    )
                    for source_id, selected in by_source.items()
                )
            )

            def function(messages, info: AgentInfo) -> ModelResponse:
                role_function_tools["planner"].extend(extract_function_tools(messages))
                return ModelResponse(
                    [ToolCallPart(info.output_tools[0].name, plan.model_dump(), "plan")]
                )

            return await PlannerAgent(FunctionModel(function)).plan(summary)

    class DeterministicWorker:
        async def run(self, task: AnalysisTask) -> WorkerRunResult:
            role_invocations["worker"] += 1
            statements = {item.key: item.statement for item in corpus.semantic.claims}
            accepted = AcceptedKnowledgeStore(database).list_claims(run_id)
            external_claims = {
                key: claim["id"]
                for key, statement in statements.items()
                for claim in accepted
                if claim["statement"] == statement and claim["epistemic_status"] != "stale"
            }
            proposal = _proposal_for_task(
                task,
                corpus,
                materialized,
                revisions,
                mutation_id,
                obligations,
                external_claims,
            )

            def function(messages, info: AgentInfo) -> ModelResponse:
                returned = any(
                    isinstance(part, ToolReturnPart)
                    for message in messages
                    for part in message.parts
                )
                if not returned:
                    first = proposal["evidence"][0]
                    return ModelResponse(
                        [
                            ToolCallPart(
                                "read_text",
                                {
                                    "path": first["path"],
                                    "start_line": first["start_line"],
                                    "end_line": first["end_line"],
                                },
                                "read",
                            )
                        ]
                    )
                return ModelResponse(
                    [ToolCallPart(info.output_tools[0].name, proposal, "proposal")]
                )

            result = await WorkerAgent(
                FunctionModel(function),
                audit_path=workspace / "worker-audit.db",
                gateway_id="benchmark",
                model_name=MODEL_VERSION,
                max_concurrency=1,
            ).run(task)
            role_function_tools["worker"].append("read_text")
            return result

    class DeterministicVerifier:
        async def verify(
            self, perspective: VerificationPerspective, target: VerificationTarget
        ) -> VerificationFinding:
            role_invocations["verifier"] += 1
            evidence_ids = tuple(item.id for item in target.proposal.evidence)

            def function(messages, info: AgentInfo) -> ModelResponse:
                role_function_tools["verifier"].extend(extract_function_tools(messages))
                return ModelResponse(
                    [
                        ToolCallPart(
                            info.output_tools[0].name,
                            {
                                "target_id": target.candidate_id,
                                "perspective": perspective,
                                "verdict": "pass",
                                "severity": "info",
                                "evidence": evidence_ids,
                                "rationale": "The fixture matches exact source evidence.",
                            },
                            f"verify-{perspective}",
                        )
                    ]
                )

            return await VerifierAgent(FunctionModel(function)).verify(perspective, target)

    outcome = asyncio.run(
        Scheduler(
            database,
            DeterministicPlanner(),
            DeterministicWorker(),
            verifier=DeterministicVerifier(),
            limits=PlannerLimits(max_tasks=4, obligation_limit=20),
        ).run_until_terminal(run_id)
    )
    if outcome.status != "complete":
        raise ValueError(f"Benchmark Scheduler did not close exploration: {outcome.status}")


def _write_config(
    path: Path,
    corpus: BenchmarkCorpus,
    repositories: dict[str, Path],
    revisions: dict[str, str],
    publish_dir: Path,
) -> None:
    lines = [
        f'project_id = "{corpus.project.id}"',
        f'publish_dir = "{publish_dir}"',
        "",
        "[profile.dispositions.major]",
        'disposition = "open"',
        "",
        "[profile.dispositions.supporting]",
        'disposition = "open"',
    ]
    roles = {item.id: item.role for item in corpus.repositories}
    for source_id in corpus.project.source_ids:
        lines.extend(
            [
                "",
                "[[sources]]",
                f'id = "{source_id}"',
                f'role = "{roles[source_id]}"',
                f'repository = "{repositories[source_id]}"',
                f'revision = "{revisions[source_id]}"',
            ]
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _execute_run(
    workspace: Path,
    corpus: BenchmarkCorpus,
    materialized: MaterializedCorpus,
    revisions: dict[str, str],
    publish_dir: Path,
    label: str,
    mutation_id: str | None = None,
    role_function_tools: dict[str, list[str]] | None = None,
    role_invocations: dict[str, int] | None = None,
) -> RunObservation:
    config = workspace / f"{label}.toml"
    _write_config(config, corpus, materialized.repositories, revisions, publish_dir)
    code, created = _capture(build, str(config))
    if code != 1 or created.get("state") != "exploring":
        raise ValueError(f"Benchmark Production Run did not enter exploration: {created}")
    run_id = str(created["run_id"])
    _run_semantic_agents(
        workspace,
        run_id,
        corpus,
        materialized,
        revisions,
        mutation_id,
        role_function_tools or {"planner": [], "worker": [], "verifier": [], "renderer": []},
        role_invocations or {"planner": 0, "worker": 0, "verifier": 0, "renderer": 0},
    )
    finish_run(run_id)
    code, published = _capture(review, run_id, True)
    if code or published.get("state") != "published":
        raise ValueError(f"Benchmark Production Run did not publish: {published}")
    _, status = _capture(__import__("okf_wiki.cli", fromlist=["status"]).status, run_id)
    _, checked = _capture(check, str(publish_dir))
    database = workspace / ".okf-wiki" / "runs.db"
    store = AcceptedKnowledgeStore(database)
    claims = store.list_claims(run_id)
    claims_by_id = {item["id"]: item for item in claims}
    with sqlite3.connect(database) as connection:
        unresolved_evidence = connection.execute(
            """SELECT COUNT(*) FROM coverage_obligations obligation
               WHERE obligation.run_id = ? AND obligation.priority = 'major'
                 AND obligation.disposition = 'covered'
                 AND NOT EXISTS (
                     SELECT 1 FROM obligation_claims grounding
                     WHERE grounding.run_id = obligation.run_id
                       AND grounding.obligation_id = obligation.id
                 )""",
            (run_id,),
        ).fetchone()[0]
        grounding: dict[str, list[str]] = {}
        for obligation_id, claim_id in connection.execute(
            "SELECT obligation_id, claim_id FROM obligation_claims WHERE run_id = ? ORDER BY obligation_id, claim_id",
            (run_id,),
        ):
            grounding.setdefault(obligation_id, []).append(claim_id)
    obligation_resolutions = tuple(
        {
            "id": item["id"],
            "source": item["source"],
            "path": item["path"],
            "span": item["span"],
            "kind": item["kind"],
            "text": item["text"],
            "priority": item["priority"],
            "disposition": item["disposition"],
            "reason": item["reason"],
            "claim_ids": grounding.get(item["id"], []),
            "evidence": (
                [
                    (
                        item["source"],
                        revisions[item["source"]],
                        item["path"],
                        item["span"]["start_line"],
                        item["span"]["end_line"],
                    )
                ]
                if item["disposition"] == "excluded"
                else sorted(
                    {
                        (
                            evidence["source_id"],
                            evidence["revision"],
                            evidence["path"],
                            evidence["start_line"],
                            evidence["end_line"],
                        )
                        for claim_id in grounding.get(item["id"], [])
                        for evidence in claims_by_id[claim_id]["evidence"]
                    }
                )
            ),
        }
        for item in status["obligations"]
    )
    bundle_documents = {
        path.relative_to(publish_dir).as_posix(): path.read_text(encoding="utf-8")
        for path in publish_dir.rglob("*.md")
        if path.relative_to(publish_dir).as_posix() not in OPERATIONAL_BUNDLE_DOCUMENTS
    }
    removed = tuple(status["review"].get("bundle_diff", {}).get("removed", ()))
    allowed_removal = mutation_id in {
        "mutation:removed-defining-evidence",
        "mutation:concept-rename",
    }
    return RunObservation(
        run_id=run_id,
        source_revisions={item["id"]: item["revision"] for item in status["sources"]},
        obligations=tuple(status["obligations"]),
        claims=tuple(claims),
        concepts=tuple(store.list_concepts(run_id)),
        refresh=status["refresh"],
        review=status["review"],
        bundle_errors=tuple(checked["errors"]),
        major_evidence_resolved=not unresolved_evidence,
        unexplained_deletions=tuple(
            path
            for path in removed
            if not allowed_removal or not path.startswith("concepts/order-submission-")
        ),
        obligation_resolutions=obligation_resolutions,
        bundle_documents=bundle_documents,
    )


def _jaccard(left: set[str], right: set[str]) -> float:
    return len(left & right) / len(left | right) if left or right else 1.0


def _minimum_similarity(values: list[set[str]]) -> float:
    return min((_jaccard(left, right) for left, right in combinations(values, 2)), default=1.0)


def claim_concept_membership_error_rate(
    observed: set[tuple[str, str]], expected: set[tuple[str, str]]
) -> float:
    return len(observed ^ expected) / len(observed | expected) if observed or expected else 0


def critical_unsupported_count(
    claims: tuple[ClaimRecord, ...],
    critical_statements: set[str],
    valid_statements: set[str],
) -> int:
    return sum(
        claim["statement"] in critical_statements
        and (
            claim["statement"] not in valid_statements
            or claim["epistemic_status"] == "stale"
            or not claim["evidence"]
        )
        for claim in claims
    )


def _semantic_metrics(
    observation: RunObservation,
    gold: GoldDefinition,
    critical_statements: set[str],
    valid_statements: set[str],
) -> SemanticMetrics:
    supported = {
        item["statement"] for item in observation.claims if item["epistemic_status"] == "supported"
    }
    expected = {item.statement for item in gold.claims}
    major = {item.statement for item in gold.claims if item.major}
    concepts = {
        (item["canonical_name"], tuple(item["aliases"]))
        for item in observation.concepts
        if item["status"] == "active"
    }
    expected_concepts = {
        (item.canonical_name, tuple(sorted(item.aliases))) for item in gold.concepts
    }
    correct_concepts = {
        (name, tuple(sorted(aliases))) for name, aliases in concepts
    } & expected_concepts
    claims_by_id = {item["id"]: item["statement"] for item in observation.claims}
    observed_memberships = {
        (concept["canonical_name"], claims_by_id[claim_id])
        for concept in observation.concepts
        if concept["status"] == "active"
        for claim_id in [*concept["defining_claim_ids"], *concept["supporting_claim_ids"]]
        if claim_id in claims_by_id
    }
    gold_claims = {item.key: item.statement for item in gold.claims}
    expected_memberships = {
        (concept.canonical_name, gold_claims[claim_key])
        for concept in gold.concepts
        for claim_key in concept.claim_keys
    }
    return SemanticMetrics(
        supported_claim_precision=len(supported & expected) / len(supported) if supported else 0,
        major_claim_recall=len(supported & major) / len(major),
        concept_precision=len(correct_concepts) / len(concepts) if concepts else 0,
        concept_recall=len(correct_concepts) / len(expected_concepts),
        wrong_merge_split_rate=claim_concept_membership_error_rate(
            observed_memberships, expected_memberships
        ),
        critical_unsupported_claims=critical_unsupported_count(
            observation.claims,
            critical_statements,
            valid_statements,
        ),
    )


def _reviewed_major_inventory(observation: RunObservation, gold: GoldDefinition) -> bool:
    actual = {item["id"]: item for item in observation.obligations if item["priority"] == "major"}
    expected = {item.id: item for item in gold.major_obligations}
    if set(actual) != set(expected):
        return False
    resolutions = {item["id"]: item for item in observation.obligation_resolutions}
    evidence = {item.key: item for item in gold.evidence}
    for obligation_id, reviewed in expected.items():
        item = actual[obligation_id]
        if (
            item["source"],
            item["path"],
            item["kind"],
            item["disposition"],
        ) != (
            reviewed.source_id,
            reviewed.path,
            reviewed.kind,
            reviewed.disposition,
        ):
            return False
        if reviewed.disposition == "excluded":
            if item["reason"] != reviewed.reason:
                return False
            continue
        assert reviewed.evidence_key is not None
        expected_evidence = evidence[reviewed.evidence_key]
        locator = (
            expected_evidence.source_id,
            expected_evidence.revision,
            expected_evidence.path,
            expected_evidence.start_line,
            expected_evidence.end_line,
        )
        if locator not in resolutions[obligation_id]["evidence"]:
            return False
    return True


def reviewed_semantic_gold(observation: RunObservation, gold: GoldDefinition) -> bool:
    claims_by_statement = {item["statement"]: item for item in observation.claims}
    gold_claims = {item.key: item for item in gold.claims}
    for conflict in gold.conflicts:
        disputed = claims_by_statement.get(gold_claims[conflict.key].statement)
        resolution = claims_by_statement.get(gold_claims[conflict.resolved_by].statement)
        if (
            disputed is None
            or resolution is None
            or disputed["epistemic_status"] != "disputed"
            or not disputed["evidence"]
            or resolution["epistemic_status"] != "supported"
            or resolution["id"] not in disputed["conflicts_with"]
            or gold_claims[conflict.key].critical != conflict.critical
        ):
            return False
    for exclusion in gold.exclusions:
        excluded_claims = [
            claim
            for claim in observation.claims
            if any(
                evidence["source_id"] == exclusion.source_id and evidence["path"] == exclusion.path
                for evidence in claim["evidence"]
            )
        ]
        if (
            not excluded_claims
            or any(claim["epistemic_status"] == "supported" for claim in excluded_claims)
            or not any(
                claim["epistemic_status"] == "disputed"
                and claim["conditions"] == [exclusion.reason]
                for claim in excluded_claims
            )
        ):
            return False
    concepts = {
        item["canonical_name"]: item for item in observation.concepts if item["status"] == "active"
    }
    claims_by_id = {item["id"]: item["statement"] for item in observation.claims}
    gold_concepts = {item.key: item for item in gold.concepts}
    for concept_key in gold.data_contracts:
        expected = gold_concepts[concept_key]
        observed = concepts.get(expected.canonical_name)
        if observed is None:
            return False
        observed_claims = {
            claims_by_id[claim_id]
            for claim_id in [
                *observed["defining_claim_ids"],
                *observed["supporting_claim_ids"],
            ]
        }
        if {gold_claims[key].statement for key in expected.claim_keys} - observed_claims:
            return False
    return True


def _hard_gates(
    observation: RunObservation, expected_source_revisions: dict[str, str]
) -> dict[str, bool]:
    complete_major = (
        all(
            item["disposition"] in {"covered", "excluded"}
            for item in observation.obligations
            if item["priority"] == "major"
        )
        and observation.major_evidence_resolved
    )
    exact_revisions = observation.source_revisions == expected_source_revisions and all(
        evidence["revision"] == expected_source_revisions.get(evidence["source_id"])
        for claim in observation.claims
        if claim["epistemic_status"] != "stale"
        for evidence in claim["evidence"]
    )
    unresolved_conflicts = any(
        item["epistemic_status"] == "supported" and item["conflicts_with"]
        for item in observation.claims
    )
    return {
        "complete_major_disposition_and_evidence": complete_major,
        "exact_source_revisions": exact_revisions,
        "valid_okf": not observation.bundle_errors,
        "zero_broken_internal_links": not any(
            "broken internal link" in error for error in observation.bundle_errors
        ),
        "zero_unexplained_deletions": not observation.unexplained_deletions,
        "zero_unresolved_critical_conflicts": not unresolved_conflicts,
    }


def source_revisions_applied(expected: dict[str, str], *observations: RunObservation) -> bool:
    return all(observation.source_revisions == expected for observation in observations)


def _single_mutation_effect_passed(
    mutation: MutationCase, base: RunObservation, changed: RunObservation
) -> bool:
    expected = mutation.expected
    statements = {
        item["statement"] for item in changed.claims if item["epistemic_status"] != "stale"
    }
    concepts = {
        item["canonical_name"]: item for item in changed.concepts if item["status"] != "stale"
    }
    if expected.effect == "semantic_unchanged":
        return base.semantic_snapshot() == changed.semantic_snapshot()
    if expected.effect == "new_major_obligation":
        assert expected.obligation is not None and expected.claim_statement is not None
        obligation = expected.obligation
        matching = [
            item
            for item in changed.obligations
            if (
                item["source"],
                item["path"],
                item["kind"],
                item["text"],
                item["priority"],
                item["disposition"],
            )
            == (
                obligation.source_id,
                obligation.path,
                obligation.kind,
                obligation.text,
                obligation.priority,
                obligation.disposition,
            )
        ]
        base_ids = {item["id"] for item in base.obligations}
        resolutions = {item["id"]: item for item in changed.obligation_resolutions}
        return (
            len(matching) == 1
            and matching[0]["id"] not in base_ids
            and matching[0]["disposition"] in {"covered", "excluded"}
            and bool(resolutions[matching[0]["id"]]["evidence"])
            and expected.claim_statement in statements
            and expected.claim_statement not in {item["statement"] for item in base.claims}
        )
    if expected.effect == "removed_defining_evidence":
        assert expected.claim_statement is not None
        return expected.claim_statement not in statements
    if expected.effect == "evidence_relocated":
        assert expected.claim_statement is not None and expected.evidence_path is not None
        return any(
            claim["statement"] == expected.claim_statement
            and evidence["path"] == expected.evidence_path
            for claim in changed.claims
            for evidence in claim["evidence"]
        )
    if expected.effect == "concept_identity_preserved":
        assert expected.previous_concept_name is not None and expected.concept_name is not None
        base_concept = next(
            item
            for item in base.concepts
            if item["canonical_name"] == expected.previous_concept_name
        )
        return concepts.get(expected.concept_name, {}).get("id") == base_concept["id"]
    if expected.effect == "critical_conflict_resolved":
        assert expected.claim_statement is not None and expected.epistemic_status is not None
        return any(
            item["statement"] == expected.claim_statement
            and item["epistemic_status"] == expected.epistemic_status
            and item["conflicts_with"]
            for item in changed.claims
        )
    assert expected.concept_membership is not None
    membership = expected.concept_membership
    claim = next(
        (
            item
            for item in changed.claims
            if item["statement"] == membership.claim_statement
            and item["epistemic_status"] == "supported"
            and item["evidence"]
        ),
        None,
    )
    concept = concepts.get(membership.canonical_name)
    membership_key = (
        "defining_claim_ids" if membership.role == "defining" else "supporting_claim_ids"
    )
    return (
        claim is not None
        and membership.claim_statement not in {item["statement"] for item in base.claims}
        and concept is not None
        and claim["id"] in concept[membership_key]
    )


def mutation_effect_applied(
    mutation: MutationCase,
    base: RunObservation,
    incremental: RunObservation,
    full: RunObservation,
) -> bool:
    return _single_mutation_effect_passed(
        mutation, base, incremental
    ) and _single_mutation_effect_passed(mutation, base, full)


def verify_gateway_contract_requirement(current: str, baseline: str) -> GatewayStatus:
    if current == baseline:
        return GatewayStatus(
            status="not_required",
            live=False,
            passed=True,
            evidence="PydanticAI baseline is unchanged; live gateway tests were not run.",
        )
    required = ("OKF_GATEWAY_BASE_URL", "OKF_GATEWAY_API_KEY", "OKF_GATEWAY_MODEL")
    if any(not os.environ.get(name) for name in required):
        return GatewayStatus(
            status="required_credentials_unavailable",
            live=False,
            passed=False,
            evidence="PydanticAI changed and required live gateway credentials are unavailable.",
        )
    result = subprocess.run(
        [
            shutil.which("pytest") or "pytest",
            "-q",
            "-m",
            "gateway_live",
            "tests/test_gateway_live.py",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    return GatewayStatus(
        status="passed" if result.returncode == 0 else "failed",
        live=True,
        passed=result.returncode == 0,
        evidence=(result.stdout + result.stderr)[-2000:] or "Live gateway contract tests ran.",
    )


def run_benchmark(
    *,
    workspace: Path | None = None,
    manifest_path: Path | None = None,
) -> BenchmarkReport:
    if manifest_path is None:
        manifest_path = CORPUS_ROOT / "v1" / "release-manifest.json"
    manifest = ReleaseManifest.model_validate_json(manifest_path.read_text())
    corpus = load_benchmark_corpus(manifest.corpus_version)
    root_context = tempfile.TemporaryDirectory() if workspace is None else None
    root = Path(root_context.name) if root_context else workspace
    assert root is not None
    root.mkdir(parents=True, exist_ok=True)
    materialized = materialize_corpus(corpus, root / "repositories")
    clean_before = {
        source_id: (
            git_write(repository, "status", "--porcelain"),
            git_write(repository, "rev-parse", "HEAD"),
        )
        for source_id, repository in materialized.repositories.items()
    }
    observations: list[RunObservation] = []
    expected_source_revisions: list[dict[str, str]] = []
    mutations: list[MutationReport] = []
    role_function_tools = {"planner": [], "worker": [], "verifier": [], "renderer": []}
    role_invocations = {"planner": 0, "worker": 0, "verifier": 0, "renderer": 0}
    with _working_directory(root):
        publish = root / "published" / "baseline"
        baseline = _execute_run(
            root,
            corpus,
            materialized,
            materialized.base_revisions,
            publish,
            "baseline-1",
            role_function_tools=role_function_tools,
            role_invocations=role_invocations,
        )
        observations.append(baseline)
        expected_source_revisions.append(materialized.base_revisions)
        base_target = os.readlink(publish)
        for number in (2, 3):
            publish.unlink()
            repeated_observation = _execute_run(
                root,
                corpus,
                materialized,
                materialized.base_revisions,
                publish,
                f"baseline-{number}",
                role_function_tools=role_function_tools,
                role_invocations=role_invocations,
            )
            observations.append(repeated_observation)
            expected_source_revisions.append(materialized.base_revisions)
        publish.unlink()
        os.symlink(base_target, publish, target_is_directory=True)
        baseline_incremental = _execute_run(
            root,
            corpus,
            materialized,
            materialized.base_revisions,
            publish,
            "baseline-incremental",
            role_function_tools=role_function_tools,
            role_invocations=role_invocations,
        )
        observations.append(baseline_incremental)
        expected_source_revisions.append(materialized.base_revisions)
        base_equivalent = baseline.semantic_snapshot() == baseline_incremental.semantic_snapshot()
        for mutation in corpus.mutations:
            publish.unlink()
            os.symlink(base_target, publish, target_is_directory=True)
            revisions = materialized.mutation_revisions[mutation.id]
            incremental = _execute_run(
                root,
                corpus,
                materialized,
                revisions,
                publish,
                f"{mutation.kind}-incremental",
                mutation.id,
                role_function_tools,
                role_invocations,
            )
            full = _execute_run(
                root,
                corpus,
                materialized,
                revisions,
                root / "published" / f"{mutation.kind}-full",
                f"{mutation.kind}-full",
                mutation.id,
                role_function_tools,
                role_invocations,
            )
            observations.extend((incremental, full))
            expected_source_revisions.extend((revisions, revisions))
            equivalent = incremental.semantic_snapshot() == full.semantic_snapshot()
            effect = mutation_effect_applied(mutation, baseline, incremental, full)
            mutations.append(
                MutationReport(
                    case_id=mutation.id,
                    kind=mutation.kind,
                    applied=source_revisions_applied(revisions, incremental, full),
                    effect=mutation.expected.effect,
                    equivalent=equivalent,
                    passed=(
                        equivalent
                        and effect
                        and source_revisions_applied(revisions, incremental, full)
                    ),
                )
            )
    repeated = observations[:3]
    hard_gate_sets = [
        _hard_gates(observation, expected)
        for observation, expected in zip(observations, expected_source_revisions, strict=True)
    ]
    hard_gates = {name: all(item[name] for item in hard_gate_sets) for name in hard_gate_sets[0]}
    hard_gates["reviewed_major_inventory"] = _reviewed_major_inventory(baseline, corpus.gold)
    hard_gates["reviewed_conflicts_exclusions_data_contracts"] = reviewed_semantic_gold(
        baseline, corpus.gold
    )
    critical_statements = {item.statement for item in corpus.semantic.claims if item.critical}
    valid_statements = {item.statement for item in corpus.semantic.claims}
    semantic = _semantic_metrics(
        baseline,
        corpus.gold,
        critical_statements,
        valid_statements,
    ).model_copy(
        update={
            "critical_unsupported_claims": sum(
                critical_unsupported_count(
                    observation.claims,
                    critical_statements,
                    valid_statements,
                )
                for observation in observations
            )
        }
    )
    major_gold = {item.statement for item in corpus.gold.claims if item.major}
    claim_sets = [
        {
            item["statement"]
            for item in observation.claims
            if item["epistemic_status"] == "supported" and item["statement"] in major_gold
        }
        for observation in repeated
    ]
    concept_sets = [
        {item["canonical_name"] for item in observation.concepts if item["status"] == "active"}
        for observation in repeated
    ]
    stability = StabilityMetrics(
        major_closure=sum(
            all(
                item["disposition"] in {"covered", "excluded"}
                for item in observation.obligations
                if item["priority"] == "major"
            )
            for observation in repeated
        )
        / 3,
        critical_finding_variance=len(
            {tuple(item.review.get("blocking_findings", ())) for item in repeated}
        )
        - 1,
        major_claim_similarity=_minimum_similarity(claim_sets),
        canonical_concept_similarity=_minimum_similarity(concept_sets),
    )
    clean_after = {
        source_id: (
            git_write(repository, "status", "--porcelain"),
            git_write(repository, "rev-parse", "HEAD"),
        )
        for source_id, repository in materialized.repositories.items()
    }
    agent_execution = execute_agent_eval(corpus, materialized, root, MODEL_VERSION)
    agent_eval = agent_execution.report
    audit_totals = aggregate_worker_audits(root / "worker-audit.db", root / "agent-eval-worker.db")
    for role in role_invocations:
        role_invocations[role] += agent_execution.invocations[role]
        role_function_tools[role].extend(agent_execution.function_tools[role])
    role_trajectories = {
        role: RoleTrajectoryReport(
            invocations=role_invocations[role],
            function_tools=tuple(sorted(set(tools))),
            passed=(set(tools) <= {"read_text"} if role == "worker" else not tools),
        )
        for role, tools in role_function_tools.items()
    }
    current_pydantic = package_version("pydantic-ai")
    gateway = verify_gateway_contract_requirement(
        current_pydantic, corpus.release_baseline.pydantic_ai
    )
    failures = [name for name, passed in hard_gates.items() if not passed]
    semantic_checks = {
        "supported_claim_precision": semantic.supported_claim_precision >= 0.95,
        "major_claim_recall": semantic.major_claim_recall >= 0.95,
        "concept_precision": semantic.concept_precision >= 0.90,
        "concept_recall": semantic.concept_recall >= 0.90,
        "wrong_merge_split_rate": semantic.wrong_merge_split_rate < 0.05,
        "critical_unsupported_claims": semantic.critical_unsupported_claims == 0,
        "major_closure": stability.major_closure == 1,
        "critical_finding_variance": stability.critical_finding_variance == 0,
        "major_claim_similarity": stability.major_claim_similarity >= 0.90,
        "canonical_concept_similarity": stability.canonical_concept_similarity >= 0.90,
    }
    failures.extend(name for name, passed in semantic_checks.items() if not passed)
    if not base_equivalent:
        failures.append("incremental_full_equivalence")
    failures.extend(f"mutation:{item.case_id}" for item in mutations if not item.passed)
    if clean_before != clean_after:
        failures.append("read_only_sources")
    if not agent_eval.passed:
        failures.append("agent_eval")
    if not all(item.passed for item in role_trajectories.values()):
        failures.append("agent_role_trajectories")
    if not gateway.passed:
        failures.append("gateway_contract_tests")
    failures = list(dict.fromkeys(failures))
    all_incremental_equivalent = base_equivalent and all(item.equivalent for item in mutations)
    report = BenchmarkReport(
        corpus_version=corpus.version,
        executed_runs=len(observations),
        repeated_runs=3,
        versions=BenchmarkVersions(python=platform.python_version(), pydantic_ai=current_pydantic),
        gateway=gateway,
        hard_gates=hard_gates,
        semantic_metrics=semantic,
        stability=stability,
        incremental_full_equivalent=all_incremental_equivalent,
        mutations=tuple(mutations),
        security=SecurityReport(
            read_only_sources=clean_before == clean_after,
            bundle_validation=hard_gates["valid_okf"],
        ),
        agent_eval_passed=agent_eval.passed,
        agent_eval=agent_eval,
        role_trajectories=role_trajectories,
        nonsemantic_metadata_excluded=(
            "run_id",
            "run_events.occurred_at",
            "agent_latency_ms",
            "Source Snapshot revision identifiers (validated by exact_source_revisions)",
            "Coverage Obligation IDs and Bundle Source Set provenance fields",
            "reports/review.md",
            "reports/coverage.md (represented by normalized obligation resolutions)",
            "refresh-only impact_reverification/new_source_unit obligations",
        ),
        costs=BenchmarkCosts(
            aggregation="sum",
            sources=("production_worker_audit", "agent_eval_worker_audit"),
            worker_candidates=audit_totals.candidates,
            tokens=audit_totals.tokens,
            tool_calls=audit_totals.tool_calls,
            latency_ms=audit_totals.latency_ms,
            retries=audit_totals.retries,
            human_reviews=len(observations),
            failures=audit_totals.failures + sum(bool(item.bundle_errors) for item in observations),
            cost_usd=0,
        ),
        failures=tuple(failures),
        blocking_metric=failures[0] if failures else None,
        passed=not failures,
        blocked=bool(failures),
    )
    if root_context:
        root_context.cleanup()
    return report
