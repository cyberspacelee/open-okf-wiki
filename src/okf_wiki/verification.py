import json
import sqlite3
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .accepted_knowledge import ClaimRecord, ConceptRecord
from .knowledge_contracts import ObligationSummary, WorkerProposal


VerificationPerspective = Literal[
    "evidence_entailment",
    "coverage",
    "contradiction",
    "concept_boundary",
    "risk",
]
REQUIRED_PERSPECTIVES: tuple[VerificationPerspective, ...] = (
    "evidence_entailment",
    "coverage",
    "contradiction",
    "concept_boundary",
    "risk",
)


class VerificationFinding(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    target_id: str = Field(min_length=1)
    target_type: Literal["candidate", "claim", "concept", "obligation"] = "candidate"
    perspective: VerificationPerspective
    verdict: Literal["pass", "fail", "disputed"]
    severity: Literal["info", "warning", "error", "critical"]
    evidence: tuple[str, ...] = Field(min_length=1)
    rationale: str = Field(min_length=1, max_length=2_000)


class AcceptanceDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["accepted", "rejected", "revision_required", "review_required"]
    reasons: tuple[str, ...] = ()


class VerificationSource(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    repository: Path
    revision: str
    role: str


class AcceptancePolicy:
    def decide(
        self,
        *,
        structural_valid: bool,
        findings: tuple[VerificationFinding, ...],
        risk_categories: tuple[str, ...] = (),
    ) -> AcceptanceDecision:
        if not structural_valid:
            return AcceptanceDecision(outcome="rejected", reasons=("structural validation failed",))
        perspectives = [finding.perspective for finding in findings]
        missing = tuple(item for item in REQUIRED_PERSPECTIVES if perspectives.count(item) != 1)
        if missing:
            return AcceptanceDecision(
                outcome="revision_required",
                reasons=(f"missing or duplicate verification: {', '.join(missing)}",),
            )
        critical = tuple(
            finding.perspective
            for finding in findings
            if finding.verdict == "fail" and finding.severity == "critical"
        )
        if critical:
            return AcceptanceDecision(
                outcome="rejected",
                reasons=(f"critical verification failure: {', '.join(critical)}",),
            )
        disputed = tuple(
            finding.perspective for finding in findings if finding.verdict == "disputed"
        )
        if disputed:
            return AcceptanceDecision(
                outcome="review_required",
                reasons=(f"disputed knowledge: {', '.join(disputed)}",),
            )
        failed = tuple(finding.perspective for finding in findings if finding.verdict == "fail")
        if failed:
            return AcceptanceDecision(
                outcome="revision_required",
                reasons=(f"verification failed: {', '.join(failed)}",),
            )
        if risk_categories:
            return AcceptanceDecision(
                outcome="review_required",
                reasons=(f"high-risk knowledge: {', '.join(risk_categories)}",),
            )
        return AcceptanceDecision(outcome="accepted")


class VerificationTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    run_id: str
    candidate_id: str
    proposal: WorkerProposal
    sources: tuple[VerificationSource, ...]
    obligations: tuple[ObligationSummary, ...]
    accepted_claims: tuple[ClaimRecord, ...] = ()
    accepted_concepts: tuple[ConceptRecord, ...] = ()
    risk_categories: tuple[str, ...] = ()


class SemanticVerifier(Protocol):
    async def verify(
        self, perspective: VerificationPerspective, target: VerificationTarget
    ) -> VerificationFinding: ...


class VerificationStore:
    def __init__(self, database: Path) -> None:
        self.database = database
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS verification_candidates (
                    run_id TEXT NOT NULL,
                    candidate_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    proposal_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    decision_json TEXT,
                    PRIMARY KEY (run_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS verification_findings (
                    run_id TEXT NOT NULL,
                    candidate_id TEXT NOT NULL,
                    perspective TEXT NOT NULL,
                    finding_json TEXT NOT NULL,
                    PRIMARY KEY (run_id, candidate_id, perspective),
                    FOREIGN KEY (run_id, candidate_id)
                        REFERENCES verification_candidates(run_id, candidate_id)
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=30)
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def stage(
        self,
        run_id: str,
        candidate_id: str,
        task_id: str,
        proposal: dict[str, object],
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO verification_candidates VALUES (?, ?, ?, ?, 'staged', NULL)",
                (run_id, candidate_id, task_id, json.dumps(proposal, sort_keys=True)),
            )

    def record_findings(
        self,
        run_id: str,
        candidate_id: str,
        findings: tuple[VerificationFinding, ...],
    ) -> None:
        with self._connect() as connection:
            connection.executemany(
                "INSERT INTO verification_findings VALUES (?, ?, ?, ?)",
                [
                    (run_id, candidate_id, finding.perspective, finding.model_dump_json())
                    for finding in findings
                ],
            )

    def record_decision(self, run_id: str, candidate_id: str, decision: AcceptanceDecision) -> None:
        with self._connect() as connection:
            changed = connection.execute(
                """UPDATE verification_candidates SET status = ?, decision_json = ?
                   WHERE run_id = ? AND candidate_id = ? AND status = 'staged'""",
                (decision.outcome, decision.model_dump_json(), run_id, candidate_id),
            )
            if changed.rowcount != 1:
                raise ValueError(f"Candidate is not staged: {candidate_id}")

    def get_findings(self, run_id: str, candidate_id: str) -> list[VerificationFinding]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT finding_json FROM verification_findings
                   WHERE run_id = ? AND candidate_id = ?""",
                (run_id, candidate_id),
            )
            findings = [VerificationFinding.model_validate_json(row[0]) for row in rows]
        return sorted(findings, key=lambda item: REQUIRED_PERSPECTIVES.index(item.perspective))

    def get_decision(self, run_id: str, candidate_id: str) -> AcceptanceDecision | None:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT decision_json FROM verification_candidates
                   WHERE run_id = ? AND candidate_id = ?""",
                (run_id, candidate_id),
            ).fetchone()
        return AcceptanceDecision.model_validate_json(row[0]) if row and row[0] else None
