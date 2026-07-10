import asyncio
import hashlib
import json
import re
import sqlite3
import subprocess
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import quote_from_bytes, unquote_to_bytes

import httpx
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import (
    Agent,
    ModelRequest,
    ModelResponse,
    ModelRetry,
    ModelSettings,
    RunContext,
    Tool,
    UsageLimits,
    capture_run_messages,
)
from pydantic_ai.messages import RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .knowledge_contracts import (
    ClaimProposal as ClaimProposal,
    ConceptProposal as ConceptProposal,
    DispositionProposal as DispositionProposal,
    EvidenceProposal as EvidenceProposal,
    RelationProposal as RelationProposal,
    WorkerProposal,
    WorkerRunResult,
)


PROMPT_VERSION = "worker-v1"
TOOL_VERSION = "git-snapshot-v1"
SCHEMA_VERSION = "worker-proposal-v2"


class WorkerBudgets(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    request_limit: int = Field(default=8, ge=1)
    tool_calls_limit: int = Field(default=20, ge=1)
    input_tokens_limit: int = Field(default=50_000, ge=1)
    output_tokens_limit: int = Field(default=8_000, ge=1)
    total_tokens_limit: int = Field(default=60_000, ge=1)
    wall_time_seconds: float = Field(default=60, gt=0)
    tool_timeout_seconds: float = Field(default=15, gt=0)

    def usage_limits(self) -> UsageLimits:
        return UsageLimits(
            request_limit=self.request_limit,
            tool_calls_limit=self.tool_calls_limit,
            input_tokens_limit=self.input_tokens_limit,
            output_tokens_limit=self.output_tokens_limit,
            total_tokens_limit=self.total_tokens_limit,
        )


class AnalysisTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    task_id: str = Field(min_length=1)
    obligation_ids: tuple[str, ...] = Field(min_length=1)
    source_id: str = Field(min_length=1)
    repository: Path
    revision: str = Field(pattern=r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
    allowed_paths: tuple[str, ...] = Field(min_length=1)
    prompt: str = Field(min_length=1)
    budgets: WorkerBudgets


@dataclass(frozen=True)
class GatewaySettings:
    base_url: str
    api_key: str = field(repr=False)
    model: str
    default_headers: dict[str, str] | None = field(default=None, repr=False)
    http_client: httpx.AsyncClient | None = field(default=None, repr=False)
    timeout_seconds: float = 30
    max_retries: int = 2


def build_gateway_model(settings: GatewaySettings) -> OpenAIChatModel:
    client = AsyncOpenAI(
        base_url=settings.base_url,
        api_key=settings.api_key,
        default_headers=settings.default_headers,
        http_client=settings.http_client,
        timeout=settings.timeout_seconds,
        max_retries=settings.max_retries,
    )
    return OpenAIChatModel(
        settings.model,
        provider=OpenAIProvider(openai_client=client),
    )


class GitObjectSnapshotReader:
    def __init__(self, repository: Path, source_id: str, revision: str) -> None:
        self.repository = repository.resolve()
        self.source_id = source_id
        self.revision = revision.lower()
        resolved = self._git("rev-parse", "--verify", f"{revision}^{{commit}}").strip().lower()
        if resolved != self.revision:
            raise ValueError("revision does not resolve to the exact requested commit")
        self._object_ids = self._load_objects()

    def _git_bytes(self, *arguments: str) -> bytes:
        result = subprocess.run(
            ["git", "-C", str(self.repository), *arguments],
            check=False,
            capture_output=True,
        )
        if result.returncode:
            raise ValueError(result.stderr.decode(errors="replace").strip() or "Git read failed")
        return result.stdout

    def _git(self, *arguments: str) -> str:
        return self._git_bytes(*arguments).decode("utf-8")

    @staticmethod
    def _safe_path(path: str) -> str:
        parsed = PurePosixPath(path)
        if (
            not path
            or parsed.is_absolute()
            or ".." in parsed.parts
            or "\x00" in path
            or quote_from_bytes(unquote_to_bytes(path), safe="/") != path
        ):
            raise ValueError("path must be a repository-relative path")
        return parsed.as_posix()

    def _load_objects(self) -> dict[str, str]:
        objects = {}
        for record in self._git_bytes("ls-tree", "-r", "--full-tree", "-z", self.revision).split(
            b"\0"
        ):
            if not record:
                continue
            metadata, path = record.split(b"\t", 1)
            _mode, object_type, object_id = metadata.split(b" ", 2)
            if object_type == b"blob":
                objects[quote_from_bytes(path, safe="/")] = object_id.decode()
        return objects

    def list_paths_sync(
        self, prefix: str = "", *, allowed: tuple[str, ...] | None = None
    ) -> list[str]:
        prefix = self._safe_path(prefix) if prefix else ""
        present = self._object_ids
        scope = {self._safe_path(path) for path in allowed} if allowed is not None else set(present)
        return sorted(path for path in present if path in scope and path.startswith(prefix))

    async def list_paths(self, prefix: str = "", *, allowed: tuple[str, ...]) -> list[str]:
        return await asyncio.to_thread(self.list_paths_sync, prefix, allowed=allowed)

    def read_text_sync(
        self,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        path = self._safe_path(path)
        if path not in {self._safe_path(item) for item in allowed}:
            raise ValueError("path is outside the assigned Source Snapshot scope")
        if start_line < 1 or end_line < start_line:
            raise ValueError("use 1-based lines with end_line >= start_line")
        object_id = self._object_ids.get(path)
        if object_id is None:
            raise ValueError("path is missing from the assigned Source Snapshot")
        text = self._git_bytes("cat-file", "blob", object_id).decode("utf-8")
        lines = text.splitlines()
        if end_line > len(lines):
            raise ValueError("line span is outside the source file")
        return "\n".join(lines[start_line - 1 : end_line])

    async def read_text(
        self,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        return await asyncio.to_thread(
            self.read_text_sync,
            path,
            start_line,
            end_line,
            allowed=allowed,
        )

    async def search_text(
        self,
        query: str,
        *,
        paths: list[str] | None,
        allowed: tuple[str, ...],
    ) -> list[dict[str, object]]:
        selected = tuple(paths) if paths is not None else allowed
        if not set(selected) <= set(allowed):
            raise ValueError("search paths are outside the assigned Source Snapshot scope")
        matches: list[dict[str, object]] = []
        for path in await self.list_paths(allowed=selected):
            text = await self.read_text(
                path, 1, self.line_count(path, allowed=allowed), allowed=allowed
            )
            matches.extend(
                {"path": path, "line": line_number, "text": line}
                for line_number, line in enumerate(text.splitlines(), 1)
                if query in line
            )
        return matches

    def line_count(self, path: str, *, allowed: tuple[str, ...]) -> int:
        path = self._safe_path(path)
        if path not in allowed:
            raise ValueError("path is outside the assigned Source Snapshot scope")
        object_id = self._object_ids.get(path)
        if object_id is None:
            raise ValueError("path is missing from the assigned Source Snapshot")
        return len(self._git_bytes("cat-file", "blob", object_id).decode("utf-8").splitlines())


@dataclass(frozen=True)
class WorkerDeps:
    task: AnalysisTask
    snapshot: GitObjectSnapshotReader


async def list_paths(ctx: RunContext[WorkerDeps], prefix: str = "") -> list[str]:
    """List paths within the assigned fixed Source Snapshot."""
    async with asyncio.timeout(ctx.deps.task.budgets.tool_timeout_seconds):
        return await ctx.deps.snapshot.list_paths(prefix, allowed=ctx.deps.task.allowed_paths)


async def search_text(
    ctx: RunContext[WorkerDeps], query: str, paths: list[str] | None = None
) -> list[dict[str, object]]:
    """Search literal text within assigned Source Snapshot paths."""
    if not query.strip():
        raise ModelRetry("query must not be empty")
    async with asyncio.timeout(ctx.deps.task.budgets.tool_timeout_seconds):
        return await ctx.deps.snapshot.search_text(
            query,
            paths=paths,
            allowed=ctx.deps.task.allowed_paths,
        )


async def read_text(ctx: RunContext[WorkerDeps], path: str, start_line: int, end_line: int) -> str:
    """Read an inclusive line range from an assigned Source Snapshot path."""
    if start_line < 1 or end_line < start_line:
        raise ModelRetry("use 1-based lines with end_line >= start_line")
    async with asyncio.timeout(ctx.deps.task.budgets.tool_timeout_seconds):
        return await ctx.deps.snapshot.read_text(
            path,
            start_line,
            end_line,
            allowed=ctx.deps.task.allowed_paths,
        )


def _unique(values: list[str]) -> bool:
    return len(values) == len(set(values))


async def validate_candidate(
    proposal: WorkerProposal,
    task: AnalysisTask,
    snapshot: GitObjectSnapshotReader,
) -> list[str]:
    errors = []
    if proposal.task_id != task.task_id:
        errors.append("proposal task_id does not match the assigned task")
    if set(proposal.obligation_ids) != set(task.obligation_ids) or not _unique(
        proposal.obligation_ids
    ):
        errors.append("proposal obligation_ids do not exactly match the assignment")

    evidence = {item.id: item for item in proposal.evidence}
    claims = {item.id: item for item in proposal.claims}
    concepts = {item.id: item for item in proposal.concepts}
    if len(evidence) != len(proposal.evidence):
        errors.append("Evidence proposal IDs must be unique")
    if len(claims) != len(proposal.claims):
        errors.append("Claim proposal IDs must be unique")
    if len(concepts) != len(proposal.concepts):
        errors.append("Concept proposal IDs must be unique")

    for item in proposal.evidence:
        if item.source_id != task.source_id:
            errors.append(f"Evidence {item.id} source is outside the assigned Source Snapshot")
            continue
        if item.revision.lower() != task.revision.lower():
            errors.append(f"Evidence {item.id} revision does not match the assigned snapshot")
            continue
        if item.path not in task.allowed_paths:
            errors.append(f"Evidence {item.id} path is outside the assigned scope")
            continue
        try:
            text = await snapshot.read_text(
                item.path,
                item.start_line,
                item.end_line,
                allowed=task.allowed_paths,
            )
        except ValueError as error:
            errors.append(f"Evidence {item.id} cannot be resolved: {error}")
            continue
        digest = f"sha256:{hashlib.sha256(text.encode()).hexdigest()}"
        if item.digest != digest:
            errors.append(f"Evidence {item.id} digest does not match the resolved span")

    def missing(
        references: list[str],
        known: Mapping[str, object],
        owner: str,
        external_prefix: str | None = None,
    ) -> None:
        for reference in references:
            external = external_prefix and re.fullmatch(
                rf"{external_prefix}:[0-9a-f]{{64}}", reference
            )
            if reference not in known and not external:
                errors.append(f"{owner} references missing ID {reference}")

    for item in proposal.claims:
        missing(item.evidence_ids, evidence, f"Claim {item.id}")
        missing(item.conflicts_with, claims, f"Claim {item.id}", "claim")
        missing(item.supersedes, claims, f"Claim {item.id}", "claim")
        if item.id in item.conflicts_with or item.id in item.supersedes:
            errors.append(f"Claim {item.id} cannot conflict with or supersede itself")
    for item in proposal.concepts:
        missing(item.claim_ids, claims, f"Concept {item.id}")
        missing(item.defining_claim_ids, claims, f"Concept {item.id}")
        missing(item.supporting_claim_ids, claims, f"Concept {item.id}")
        explicit = set(item.defining_claim_ids) | set(item.supporting_claim_ids)
        if explicit - set(item.claim_ids):
            errors.append(f"Concept {item.id} Claim roles must be included in claim_ids")
        if set(item.defining_claim_ids) & set(item.supporting_claim_ids):
            errors.append(f"Concept {item.id} Claims cannot be both defining and supporting")
        if item.supporting_claim_ids and not item.defining_claim_ids:
            errors.append(f"Concept {item.id} explicit Claim roles require a defining Claim")
    for item in proposal.relations:
        missing([item.subject_concept_id, item.object_concept_id], concepts, "Relation", "concept")
        missing(item.evidence_ids, evidence, "Relation")
    for item in proposal.dispositions:
        if item.obligation_id not in task.obligation_ids:
            errors.append(f"Disposition references unassigned obligation {item.obligation_id}")
        missing(item.evidence_ids, evidence, f"Disposition {item.obligation_id}")
    if {item.obligation_id for item in proposal.dispositions} != set(task.obligation_ids):
        errors.append("Every assigned obligation needs exactly one Disposition proposal")
    elif len(proposal.dispositions) != len(task.obligation_ids):
        errors.append("Each assigned obligation must have only one Disposition proposal")
    return errors


def _trajectory(
    messages: list[ModelRequest | ModelResponse],
) -> tuple[list[dict[str, object]], int]:
    trajectory: list[dict[str, object]] = []
    retries = 0
    for message in messages:
        for part in message.parts:
            if isinstance(part, ToolCallPart):
                trajectory.append(
                    {
                        "event": "call",
                        "tool": part.tool_name,
                        "tool_call_id": part.tool_call_id,
                    }
                )
            elif isinstance(part, ToolReturnPart):
                trajectory.append(
                    {
                        "event": "return",
                        "tool": part.tool_name,
                        "tool_call_id": part.tool_call_id,
                        "outcome": str(part.outcome),
                    }
                )
            elif isinstance(part, RetryPromptPart):
                retries += 1
                trajectory.append(
                    {
                        "event": "retry",
                        "tool": part.tool_name,
                        "tool_call_id": part.tool_call_id,
                    }
                )
    return trajectory, retries


class WorkerAgent:
    def __init__(
        self,
        model: Model,
        *,
        audit_path: Path,
        gateway_id: str,
        model_name: str,
        max_concurrency: int,
    ) -> None:
        self.audit_path = audit_path
        self.gateway_id = gateway_id
        self.model_name = model_name
        self.max_concurrency = max_concurrency
        self.agent = Agent[WorkerDeps, WorkerProposal](
            model,
            name="worker_agent",
            deps_type=WorkerDeps,
            output_type=WorkerProposal,
            instructions=(
                "Investigate only the assigned Coverage Obligations and fixed Source Snapshot. "
                "Use only list_paths, search_text, and read_text. Every proposal must cite exact "
                "evidence returned by those tools. Submit proposals only; never mutate obligations, "
                "the Bundle, source repositories, accepted knowledge, or publication state."
            ),
            model_settings=ModelSettings(parallel_tool_calls=True),
            tools=[
                Tool(list_paths, max_retries=1, timeout=30),
                Tool(search_text, max_retries=2, timeout=30),
                Tool(read_text, max_retries=1, timeout=30),
            ],
            retries={"tools": 1, "output": 2},
            tool_timeout=30,
            max_concurrency=max_concurrency,
            metadata={"worker_contract": "pydanticai-v2.8"},
        )
        self._initialize_audit()

    def _initialize_audit(self) -> None:
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.audit_path) as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS worker_candidates (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    obligation_ids_json TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    status TEXT NOT NULL,
                    proposal_json TEXT,
                    errors_json TEXT NOT NULL,
                    error_type TEXT,
                    trajectory_json TEXT NOT NULL,
                    retry_count INTEGER NOT NULL,
                    usage_json TEXT NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    gateway_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    response_model TEXT NOT NULL,
                    provider_url TEXT,
                    prompt_version TEXT NOT NULL,
                    tool_version TEXT NOT NULL,
                    schema_version TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )"""
            )

    def _record(
        self,
        candidate_id: str,
        task: AnalysisTask,
        status: str,
        proposal: WorkerProposal | None,
        errors: list[str],
        error_type: str | None,
        messages: list[ModelRequest | ModelResponse],
        usage: dict[str, int],
        latency_ms: int,
        response_model: str,
        provider_url: str | None,
    ) -> None:
        trajectory, retries = _trajectory(messages)
        with sqlite3.connect(self.audit_path, timeout=30) as connection:
            connection.execute(
                """INSERT INTO worker_candidates
                   (id, task_id, obligation_ids_json, source_id, revision, status,
                    proposal_json, errors_json, error_type, trajectory_json, retry_count,
                    usage_json, latency_ms, gateway_id, model, prompt_version, tool_version,
                    schema_version, response_model, provider_url)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    candidate_id,
                    task.task_id,
                    json.dumps(task.obligation_ids),
                    task.source_id,
                    task.revision,
                    status,
                    proposal.model_dump_json() if proposal else None,
                    json.dumps(errors),
                    error_type,
                    json.dumps(trajectory, default=str),
                    retries,
                    json.dumps(usage),
                    latency_ms,
                    self.gateway_id,
                    self.model_name,
                    PROMPT_VERSION,
                    TOOL_VERSION,
                    SCHEMA_VERSION,
                    response_model,
                    provider_url,
                ),
            )

    async def run(self, task: AnalysisTask) -> WorkerRunResult:
        candidate_id = uuid.uuid4().hex
        started = time.monotonic()
        messages: list[ModelRequest | ModelResponse] = []
        proposal = None
        errors: list[str] = []
        error_type = None
        usage: dict[str, int] = {}
        response_model = self.model_name
        provider_url = None
        try:
            snapshot = GitObjectSnapshotReader(task.repository, task.source_id, task.revision)
            with capture_run_messages() as captured:
                async with asyncio.timeout(task.budgets.wall_time_seconds):
                    result = await self.agent.run(
                        task.prompt,
                        deps=WorkerDeps(task, snapshot),
                        usage_limits=task.budgets.usage_limits(),
                        metadata={
                            "task_id": task.task_id,
                            "source_id": task.source_id,
                            "revision": task.revision,
                            "obligation_ids": list(task.obligation_ids),
                        },
                    )
            messages = result.new_messages()
            proposal = result.output
            errors = await validate_candidate(proposal, task, snapshot)
            run_usage = result.usage
            usage = {
                "requests": run_usage.requests,
                "tool_calls": run_usage.tool_calls,
                "input_tokens": run_usage.input_tokens,
                "output_tokens": run_usage.output_tokens,
                "total_tokens": run_usage.total_tokens,
            }
            response_model = result.response.model_name or self.model_name
            provider_url = result.response.provider_url
        except Exception as error:  # Scheduler receives a rejected, audited candidate.
            messages = list(captured) if "captured" in locals() else []
            responses = [message for message in messages if isinstance(message, ModelResponse)]
            if responses:
                response_model = responses[-1].model_name or self.model_name
                provider_url = responses[-1].provider_url
            errors = [str(error)]
            error_type = type(error).__name__
        status = "rejected" if errors else "accepted"
        self._record(
            candidate_id,
            task,
            status,
            proposal,
            errors,
            error_type,
            messages,
            usage,
            round((time.monotonic() - started) * 1000),
            response_model,
            provider_url,
        )
        return WorkerRunResult(
            status=status,
            candidate_id=candidate_id,
            proposal=proposal,
            errors=errors,
            error_type=error_type,
        )
