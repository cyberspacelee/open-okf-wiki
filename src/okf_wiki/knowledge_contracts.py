from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class WorkerBudgets(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    request_limit: int = Field(default=8, ge=1)
    tool_calls_limit: int = Field(default=20, ge=1)
    input_tokens_limit: int = Field(default=50_000, ge=1)
    output_tokens_limit: int = Field(default=8_000, ge=1)
    total_tokens_limit: int = Field(default=60_000, ge=1)
    wall_time_seconds: float = Field(default=60, gt=0)
    tool_timeout_seconds: float = Field(default=15, gt=0)


class AnalysisTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    task_id: str = Field(min_length=1)
    obligation_ids: tuple[str, ...] = Field(min_length=1, max_length=20)
    source_id: str = Field(min_length=1)
    repository: Path
    revision: str = Field(pattern=r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
    allowed_paths: tuple[str, ...] = Field(min_length=1, max_length=100)
    agent_role: Literal["extraction"] = "extraction"
    allowed_tools: tuple[Literal["list_paths", "search_text", "read_text"], ...] = (
        "list_paths",
        "search_text",
        "read_text",
    )
    prompt: str = Field(min_length=1, max_length=8_000)
    budgets: WorkerBudgets


class EvidenceProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    path: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    evidence_kind: str = Field(default="source_span", min_length=1)
    authority: str = Field(default="source_snapshot", min_length=1)


class ClaimProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    subject: str = Field(default="source", min_length=1)
    predicate: str = Field(default="states", min_length=1)
    text: str = Field(min_length=1)
    modality: str = Field(default="asserted", min_length=1)
    conditions: list[str] = Field(default_factory=list)
    epistemic_status: Literal["supported", "disputed", "stale"] = "supported"
    conflicts_with: list[str] = Field(default_factory=list)
    supersedes: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(min_length=1)


class ConceptProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    description: str = Field(min_length=1)
    claim_ids: list[str] = Field(min_length=1)
    defining_claim_ids: list[str] = Field(default_factory=list)
    supporting_claim_ids: list[str] = Field(default_factory=list)
    status: Literal["active", "disputed", "stale"] = "active"


class RelationProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject_concept_id: str = Field(min_length=1)
    predicate: str = Field(min_length=1)
    object_concept_id: str = Field(min_length=1)
    evidence_ids: list[str] = Field(min_length=1)


class DispositionProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    obligation_id: str = Field(min_length=1)
    disposition: Literal["covered", "deferred", "excluded", "blocked", "failed"]
    reason: str = Field(min_length=1)
    evidence_ids: list[str] = Field(min_length=1)


class WorkerProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1)
    obligation_ids: list[str] = Field(min_length=1)
    evidence: list[EvidenceProposal] = Field(min_length=1)
    claims: list[ClaimProposal] = Field(min_length=1)
    concepts: list[ConceptProposal] = Field(min_length=1)
    relations: list[RelationProposal]
    dispositions: list[DispositionProposal] = Field(min_length=1)


class WorkerRunResult(BaseModel):
    status: Literal["accepted", "rejected"]
    candidate_id: str
    proposal: WorkerProposal | None
    errors: list[str]
    error_type: str | None = None
