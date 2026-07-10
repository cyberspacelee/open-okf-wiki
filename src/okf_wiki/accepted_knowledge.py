import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, TypedDict, cast

from .knowledge_contracts import EvidenceProposal, WorkerRunResult


class EvidenceRecord(TypedDict):
    id: str
    source_id: str
    revision: str
    path: str
    source_unit: str
    start_line: int
    end_line: int
    digest: str
    evidence_kind: str
    authority: str


class ClaimRecord(TypedDict):
    id: str
    subject: str
    predicate: str
    statement: str
    modality: str
    conditions: list[str]
    epistemic_status: str
    evidence: list[EvidenceRecord]
    conflicts_with: list[str]
    supersedes: list[str]


class ConceptRecord(TypedDict):
    id: str
    canonical_name: str
    aliases: list[str]
    description: str
    status: str
    defining_claim_ids: list[str]
    supporting_claim_ids: list[str]


class RelationRecord(TypedDict):
    id: str
    subject_concept_id: str
    predicate: str
    object_concept_id: str
    evidence_ids: list[str]


class PagePlan(TypedDict):
    path: str
    title: str


class ObligationEvent(TypedDict):
    sequence: int
    previous_state: str
    state: str
    occurred_at: str
    candidate_id: str


@dataclass(frozen=True)
class AcceptanceReceipt:
    status: Literal["accepted", "rejected"]
    claim_ids: tuple[str, ...] = ()
    concept_ids: tuple[str, ...] = ()


def _stable_id(prefix: str, value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    return f"{prefix}:{hashlib.sha256(encoded).hexdigest()}"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-") or "concept"


class AcceptedKnowledgeStore:
    def __init__(self, database: Path) -> None:
        self.database = database
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS accepted_candidates (
                    run_id TEXT NOT NULL,
                    candidate_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS accepted_evidence (
                    run_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    path TEXT NOT NULL,
                    source_unit TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    digest TEXT NOT NULL,
                    evidence_kind TEXT NOT NULL,
                    authority TEXT NOT NULL,
                    PRIMARY KEY (run_id, id)
                );
                CREATE TABLE IF NOT EXISTS accepted_claims (
                    run_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    statement TEXT NOT NULL,
                    modality TEXT NOT NULL,
                    conditions_json TEXT NOT NULL,
                    epistemic_status TEXT NOT NULL,
                    PRIMARY KEY (run_id, id)
                );
                CREATE TABLE IF NOT EXISTS claim_evidence (
                    run_id TEXT NOT NULL,
                    claim_id TEXT NOT NULL,
                    evidence_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, claim_id, evidence_id),
                    FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id),
                    FOREIGN KEY (run_id, evidence_id) REFERENCES accepted_evidence(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS claim_links (
                    run_id TEXT NOT NULL,
                    claim_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    target_claim_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, claim_id, kind, target_claim_id),
                    FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id),
                    FOREIGN KEY (run_id, target_claim_id) REFERENCES accepted_claims(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS accepted_concepts (
                    run_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    canonical_name TEXT NOT NULL,
                    aliases_json TEXT NOT NULL,
                    description TEXT NOT NULL,
                    status TEXT NOT NULL,
                    PRIMARY KEY (run_id, id)
                );
                CREATE TABLE IF NOT EXISTS concept_claims (
                    run_id TEXT NOT NULL,
                    concept_id TEXT NOT NULL,
                    claim_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    PRIMARY KEY (run_id, concept_id, claim_id),
                    FOREIGN KEY (run_id, concept_id) REFERENCES accepted_concepts(run_id, id),
                    FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS concept_relations (
                    run_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    subject_concept_id TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object_concept_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, id),
                    FOREIGN KEY (run_id, subject_concept_id)
                        REFERENCES accepted_concepts(run_id, id),
                    FOREIGN KEY (run_id, object_concept_id)
                        REFERENCES accepted_concepts(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS relation_evidence (
                    run_id TEXT NOT NULL,
                    relation_id TEXT NOT NULL,
                    evidence_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, relation_id, evidence_id),
                    FOREIGN KEY (run_id, relation_id) REFERENCES concept_relations(run_id, id),
                    FOREIGN KEY (run_id, evidence_id) REFERENCES accepted_evidence(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS page_plans (
                    run_id TEXT NOT NULL,
                    concept_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    title TEXT NOT NULL,
                    PRIMARY KEY (run_id, concept_id),
                    FOREIGN KEY (run_id, concept_id) REFERENCES accepted_concepts(run_id, id)
                );
                CREATE TABLE IF NOT EXISTS obligation_claims (
                    run_id TEXT NOT NULL,
                    obligation_id TEXT NOT NULL,
                    claim_id TEXT NOT NULL,
                    PRIMARY KEY (run_id, obligation_id, claim_id),
                    FOREIGN KEY (run_id, claim_id) REFERENCES accepted_claims(run_id, id)
                );
                """
            )

    @staticmethod
    def _source_unit(
        connection: sqlite3.Connection, run_id: str, evidence: EvidenceProposal
    ) -> str:
        row = connection.execute(
            "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise ValueError(f"Unknown Production Run: {run_id}")
        source_set = json.loads(row["source_set_json"])
        matches = [
            unit
            for unit in source_set.get("source_universe", [])
            if unit["source_id"] == evidence.source_id
            and unit["revision"].casefold() == evidence.revision.casefold()
            and unit["path"] == evidence.path
            and (
                "span" not in unit
                or (
                    unit["span"]["start_line"] <= evidence.start_line
                    and unit["span"]["end_line"] >= evidence.end_line
                )
            )
        ]
        if not matches:
            raise ValueError(f"Evidence {evidence.id} has no Source Unit in the Production Run")
        matches.sort(
            key=lambda unit: (
                unit.get("span", {}).get("end_line", 10**12)
                - unit.get("span", {}).get("start_line", 0)
            )
        )
        return str(matches[0]["source_unit"])

    def accept(self, run_id: str, candidate: WorkerRunResult) -> AcceptanceReceipt:
        if candidate.status != "accepted" or candidate.proposal is None or candidate.errors:
            return AcceptanceReceipt("rejected")
        proposal = candidate.proposal
        with self._connect() as connection:
            obligations = {
                row["id"]: row
                for row in connection.execute(
                    """SELECT id, priority, disposition FROM coverage_obligations
                       WHERE run_id = ?""",
                    (run_id,),
                )
            }
            if set(proposal.obligation_ids) != set(obligations) & set(proposal.obligation_ids):
                raise ValueError("Candidate references an unknown Coverage Obligation")
            grounding: dict[str, list[str]] = {}
            for disposition in proposal.dispositions:
                obligation = obligations[disposition.obligation_id]
                current = obligation["disposition"]
                if current != disposition.disposition and current not in {"open", "assigned"}:
                    raise ValueError(
                        f"Illegal Coverage Obligation transition: "
                        f"{current} -> {disposition.disposition}"
                    )
                if obligation["priority"] == "major" and disposition.disposition == "deferred":
                    raise ValueError("Major Coverage Obligations cannot be deferred")
                grounding[disposition.obligation_id] = [
                    claim.id
                    for claim in proposal.claims
                    if set(claim.evidence_ids) & set(disposition.evidence_ids)
                ]
                if (
                    disposition.disposition == "covered"
                    and not grounding[disposition.obligation_id]
                ):
                    raise ValueError("A covered Coverage Obligation requires an accepted Claim")

            existing_claims = {
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM accepted_claims WHERE run_id = ?", (run_id,)
                )
            }
            existing_concepts = {
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM accepted_concepts WHERE run_id = ?", (run_id,)
                )
            }
            local_claims = {claim.id for claim in proposal.claims}
            local_concepts = {concept.id for concept in proposal.concepts}
            for claim in proposal.claims:
                for target in [*claim.conflicts_with, *claim.supersedes]:
                    if target not in local_claims and target not in existing_claims:
                        raise ValueError(f"Unknown external Claim: {target}")
            for relation in proposal.relations:
                for target in [relation.subject_concept_id, relation.object_concept_id]:
                    if target not in local_concepts and target not in existing_concepts:
                        raise ValueError(f"Unknown external Concept: {target}")

            evidence_ids: dict[str, str] = {}
            for evidence in proposal.evidence:
                source_unit = self._source_unit(connection, run_id, evidence)
                accepted_id = _stable_id(
                    "evidence",
                    [
                        evidence.source_id,
                        evidence.revision.casefold(),
                        evidence.path,
                        source_unit,
                        evidence.start_line,
                        evidence.end_line,
                        evidence.digest,
                        evidence.evidence_kind,
                        evidence.authority,
                    ],
                )
                evidence_ids[evidence.id] = accepted_id
                connection.execute(
                    """INSERT OR IGNORE INTO accepted_evidence
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        run_id,
                        accepted_id,
                        evidence.source_id,
                        evidence.revision.casefold(),
                        evidence.path,
                        source_unit,
                        evidence.start_line,
                        evidence.end_line,
                        evidence.digest,
                        evidence.evidence_kind,
                        evidence.authority,
                    ),
                )

            claim_ids: dict[str, str] = {}
            for claim in proposal.claims:
                accepted_evidence = sorted(evidence_ids[item] for item in claim.evidence_ids)
                accepted_id = _stable_id(
                    "claim",
                    [
                        claim.subject,
                        claim.predicate,
                        claim.text,
                        claim.modality,
                        sorted(claim.conditions),
                    ],
                )
                claim_ids[claim.id] = accepted_id
                connection.execute(
                    """INSERT INTO accepted_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (run_id, id) DO UPDATE SET
                           epistemic_status = excluded.epistemic_status""",
                    (
                        run_id,
                        accepted_id,
                        claim.subject,
                        claim.predicate,
                        claim.text,
                        claim.modality,
                        json.dumps(sorted(claim.conditions), ensure_ascii=False),
                        claim.epistemic_status,
                    ),
                )
                connection.executemany(
                    "INSERT OR IGNORE INTO claim_evidence VALUES (?, ?, ?)",
                    [(run_id, accepted_id, evidence_id) for evidence_id in accepted_evidence],
                )
            for claim in proposal.claims:
                connection.executemany(
                    "INSERT OR IGNORE INTO claim_links VALUES (?, ?, ?, ?)",
                    [
                        *(
                            (run_id, claim_ids[claim.id], "conflicts_with", claim_ids[target])
                            for target in claim.conflicts_with
                            if target in claim_ids
                        ),
                        *(
                            (run_id, claim_ids[claim.id], "supersedes", claim_ids[target])
                            for target in claim.supersedes
                            if target in claim_ids
                        ),
                        *(
                            (run_id, claim_ids[claim.id], "conflicts_with", target)
                            for target in claim.conflicts_with
                            if target not in claim_ids
                        ),
                        *(
                            (run_id, claim_ids[claim.id], "supersedes", target)
                            for target in claim.supersedes
                            if target not in claim_ids
                        ),
                    ],
                )

            concept_ids: dict[str, str] = {}
            for concept in proposal.concepts:
                if concept.defining_claim_ids or concept.supporting_claim_ids:
                    defining_proposals = concept.defining_claim_ids
                    supporting_proposals = concept.supporting_claim_ids
                else:
                    defining_proposals = sorted(concept.claim_ids)
                    supporting_proposals = []
                defining = [claim_ids[item] for item in defining_proposals]
                supporting = [claim_ids[item] for item in supporting_proposals]
                accepted_id = _stable_id("concept", sorted(defining))
                concept_ids[concept.id] = accepted_id
                connection.execute(
                    """INSERT INTO accepted_concepts VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT (run_id, id) DO UPDATE SET
                           canonical_name = excluded.canonical_name,
                           aliases_json = excluded.aliases_json,
                           description = excluded.description,
                           status = excluded.status""",
                    (
                        run_id,
                        accepted_id,
                        concept.name,
                        json.dumps(sorted(set(concept.aliases)), ensure_ascii=False),
                        concept.description,
                        concept.status,
                    ),
                )
                connection.executemany(
                    "INSERT OR IGNORE INTO concept_claims VALUES (?, ?, ?, ?)",
                    [
                        *((run_id, accepted_id, claim_id, "defining") for claim_id in defining),
                        *((run_id, accepted_id, claim_id, "supporting") for claim_id in supporting),
                    ],
                )
                connection.execute(
                    """INSERT INTO page_plans VALUES (?, ?, ?, ?)
                       ON CONFLICT (run_id, concept_id) DO UPDATE SET
                           path = excluded.path, title = excluded.title""",
                    (
                        run_id,
                        accepted_id,
                        f"concepts/{_slug(concept.name)}-{accepted_id.removeprefix('concept:')[:12]}.md",
                        concept.name,
                    ),
                )

            for relation in proposal.relations:
                subject_id = concept_ids.get(
                    relation.subject_concept_id, relation.subject_concept_id
                )
                object_id = concept_ids.get(relation.object_concept_id, relation.object_concept_id)
                relation_evidence = sorted(evidence_ids[item] for item in relation.evidence_ids)
                relation_id = _stable_id("relation", [subject_id, relation.predicate, object_id])
                connection.execute(
                    "INSERT OR IGNORE INTO concept_relations VALUES (?, ?, ?, ?, ?)",
                    (run_id, relation_id, subject_id, relation.predicate, object_id),
                )
                connection.executemany(
                    "INSERT OR IGNORE INTO relation_evidence VALUES (?, ?, ?)",
                    [(run_id, relation_id, evidence_id) for evidence_id in relation_evidence],
                )

            for disposition in proposal.dispositions:
                relevant_claims = [
                    claim_ids[claim_id] for claim_id in grounding[disposition.obligation_id]
                ]
                connection.executemany(
                    "INSERT OR IGNORE INTO obligation_claims VALUES (?, ?, ?)",
                    [(run_id, disposition.obligation_id, claim_id) for claim_id in relevant_claims],
                )
                previous = obligations[disposition.obligation_id]["disposition"]
                if previous != disposition.disposition:
                    connection.execute(
                        """UPDATE coverage_obligations SET disposition = ?, reason = ?
                           WHERE run_id = ? AND id = ?""",
                        (
                            disposition.disposition,
                            disposition.reason,
                            run_id,
                            disposition.obligation_id,
                        ),
                    )
                    connection.execute(
                        """INSERT INTO run_events
                           (run_id, previous_state, state, occurred_at, details)
                           VALUES (?, ?, ?, ?, ?)""",
                        (
                            run_id,
                            previous,
                            disposition.disposition,
                            datetime.now(UTC).isoformat(),
                            json.dumps(
                                {
                                    "candidate_id": candidate.candidate_id,
                                    "entity_id": disposition.obligation_id,
                                    "entity_type": "coverage_obligation",
                                },
                                sort_keys=True,
                            ),
                        ),
                    )
            connection.execute(
                "INSERT OR IGNORE INTO accepted_candidates VALUES (?, ?)",
                (run_id, candidate.candidate_id),
            )
        return AcceptanceReceipt(
            "accepted", tuple(sorted(claim_ids.values())), tuple(sorted(concept_ids.values()))
        )

    def get_claim(self, run_id: str, claim_id: str) -> ClaimRecord | None:
        with self._connect() as connection:
            claim = connection.execute(
                "SELECT * FROM accepted_claims WHERE run_id = ? AND id = ?", (run_id, claim_id)
            ).fetchone()
            if claim is None:
                return None
            evidence = [
                EvidenceRecord(
                    id=row["id"],
                    source_id=row["source_id"],
                    revision=row["revision"],
                    path=row["path"],
                    source_unit=row["source_unit"],
                    start_line=row["start_line"],
                    end_line=row["end_line"],
                    digest=row["digest"],
                    evidence_kind=row["evidence_kind"],
                    authority=row["authority"],
                )
                for row in connection.execute(
                    """SELECT e.* FROM accepted_evidence e JOIN claim_evidence ce
                       ON ce.run_id = e.run_id AND ce.evidence_id = e.id
                       WHERE ce.run_id = ? AND ce.claim_id = ? ORDER BY e.id""",
                    (run_id, claim_id),
                )
            ]
            links = list(
                connection.execute(
                    """SELECT kind, target_claim_id FROM claim_links
                       WHERE run_id = ? AND claim_id = ? ORDER BY kind, target_claim_id""",
                    (run_id, claim_id),
                )
            )
        return ClaimRecord(
            id=claim["id"],
            subject=claim["subject"],
            predicate=claim["predicate"],
            statement=claim["statement"],
            modality=claim["modality"],
            conditions=cast(list[str], json.loads(claim["conditions_json"])),
            epistemic_status=claim["epistemic_status"],
            evidence=evidence,
            conflicts_with=[
                row["target_claim_id"] for row in links if row["kind"] == "conflicts_with"
            ],
            supersedes=[row["target_claim_id"] for row in links if row["kind"] == "supersedes"],
        )

    def get_concept(self, run_id: str, concept_id: str) -> ConceptRecord | None:
        with self._connect() as connection:
            concept = connection.execute(
                "SELECT * FROM accepted_concepts WHERE run_id = ? AND id = ?",
                (run_id, concept_id),
            ).fetchone()
            if concept is None:
                return None
            claims = list(
                connection.execute(
                    """SELECT claim_id, role FROM concept_claims
                       WHERE run_id = ? AND concept_id = ? ORDER BY claim_id""",
                    (run_id, concept_id),
                )
            )
        return ConceptRecord(
            id=concept["id"],
            canonical_name=concept["canonical_name"],
            aliases=cast(list[str], json.loads(concept["aliases_json"])),
            description=concept["description"],
            status=concept["status"],
            defining_claim_ids=[row["claim_id"] for row in claims if row["role"] == "defining"],
            supporting_claim_ids=[row["claim_id"] for row in claims if row["role"] == "supporting"],
        )

    def find_concepts(self, run_id: str, query: str, limit: int = 20) -> list[ConceptRecord]:
        if limit < 1:
            raise ValueError("limit must be positive")
        with self._connect() as connection:
            ids = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM accepted_concepts
                       WHERE run_id = ? AND (
                           instr(lower(canonical_name), lower(?)) > 0
                           OR instr(lower(aliases_json), lower(?)) > 0
                       )
                       ORDER BY canonical_name, id LIMIT ?""",
                    (run_id, query, query, limit),
                )
            ]
        return [concept for concept_id in ids if (concept := self.get_concept(run_id, concept_id))]

    def get_relations(self, run_id: str, concept_id: str) -> list[RelationRecord]:
        with self._connect() as connection:
            rows = list(
                connection.execute(
                    """SELECT * FROM concept_relations
                       WHERE run_id = ? AND (subject_concept_id = ? OR object_concept_id = ?)
                       ORDER BY predicate, id""",
                    (run_id, concept_id, concept_id),
                )
            )
            return [
                RelationRecord(
                    id=row["id"],
                    subject_concept_id=row["subject_concept_id"],
                    predicate=row["predicate"],
                    object_concept_id=row["object_concept_id"],
                    evidence_ids=[
                        evidence["evidence_id"]
                        for evidence in connection.execute(
                            """SELECT evidence_id FROM relation_evidence
                               WHERE run_id = ? AND relation_id = ? ORDER BY evidence_id""",
                            (run_id, row["id"]),
                        )
                    ],
                )
                for row in rows
            ]

    def get_conflicts(self, run_id: str, concept_id: str) -> list[ClaimRecord]:
        concept = self.get_concept(run_id, concept_id)
        if concept is None:
            raise ValueError(f"Unknown Concept: {concept_id}")
        claims = [
            self.get_claim(run_id, claim_id)
            for claim_id in [
                *concept["defining_claim_ids"],
                *concept["supporting_claim_ids"],
            ]
        ]
        return [claim for claim in claims if claim and claim["conflicts_with"]]

    def get_claims_for_obligation(self, run_id: str, obligation_id: str) -> list[ClaimRecord]:
        with self._connect() as connection:
            ids = [
                row["claim_id"]
                for row in connection.execute(
                    """SELECT claim_id FROM obligation_claims
                       WHERE run_id = ? AND obligation_id = ? ORDER BY claim_id""",
                    (run_id, obligation_id),
                )
            ]
        return [claim for claim_id in ids if (claim := self.get_claim(run_id, claim_id))]

    def get_obligation_events(self, run_id: str, obligation_id: str) -> list[ObligationEvent]:
        with self._connect() as connection:
            events = []
            for row in connection.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
            ):
                details = json.loads(row["details"])
                if (
                    details.get("entity_type") == "coverage_obligation"
                    and details.get("entity_id") == obligation_id
                ):
                    events.append(
                        ObligationEvent(
                            sequence=row["sequence"],
                            previous_state=row["previous_state"],
                            state=row["state"],
                            occurred_at=row["occurred_at"],
                            candidate_id=details["candidate_id"],
                        )
                    )
            return events

    def get_coverage_summary(self, run_id: str) -> dict[str, int]:
        with self._connect() as connection:
            return {
                row["disposition"]: row["total"]
                for row in connection.execute(
                    """SELECT disposition, COUNT(*) AS total FROM coverage_obligations
                       WHERE run_id = ? GROUP BY disposition ORDER BY disposition""",
                    (run_id,),
                )
            }

    def get_page_plan(self, run_id: str, concept_id: str) -> PagePlan:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT path, title FROM page_plans WHERE run_id = ? AND concept_id = ?",
                (run_id, concept_id),
            ).fetchone()
        if row is None:
            raise ValueError(f"Unknown Concept: {concept_id}")
        return PagePlan(path=row["path"], title=row["title"])

    def derive_concept_page(self, run_id: str, concept_id: str) -> str:
        concept = self.get_concept(run_id, concept_id)
        if concept is None:
            raise ValueError(f"Unknown Concept: {concept_id}")
        claim_ids = [*concept["defining_claim_ids"], *concept["supporting_claim_ids"]]
        claims = [self.get_claim(run_id, claim_id) for claim_id in claim_ids]
        return (
            f"# {concept['canonical_name']}\n\n"
            "## Claims\n\n"
            + "\n".join(
                f"* [{claim['epistemic_status']}] {claim['statement']} (`{claim['id']}`)"
                for claim in claims
                if claim
            )
            + "\n"
        )
