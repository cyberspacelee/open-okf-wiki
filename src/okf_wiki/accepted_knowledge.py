import hashlib
import json
import re
import sqlite3
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict, cast

from .knowledge_contracts import EvidenceProposal, WorkerRunResult
from .run_events import append_entity_event
from .state_schema import migrate_state


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
    candidate_id: str | None


@dataclass(frozen=True)
class AcceptanceReceipt:
    status: Literal["accepted", "rejected"]
    claim_ids: tuple[str, ...] = ()
    concept_ids: tuple[str, ...] = ()


def _stable_id(prefix: str, value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    return f"{prefix}:{hashlib.sha256(encoded).hexdigest()}"


def evidence_record_id(
    *,
    source_id: str,
    revision: str,
    path: str,
    source_unit: str,
    start_line: int,
    end_line: int,
    digest: str,
    evidence_kind: str,
    authority: str,
) -> str:
    return _stable_id(
        "evidence",
        [
            source_id,
            revision.casefold(),
            path,
            source_unit,
            start_line,
            end_line,
            digest,
            evidence_kind,
            authority,
        ],
    )


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
            migrate_state(connection)

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

    def accept(
        self,
        run_id: str,
        candidate: WorkerRunResult,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> AcceptanceReceipt:
        if candidate.status != "accepted" or candidate.proposal is None or candidate.errors:
            return AcceptanceReceipt("rejected")
        proposal = candidate.proposal
        context = self._connect() if connection is None else nullcontext(connection)
        with context as connection:
            run_columns = {row["name"] for row in connection.execute("PRAGMA table_info(runs)")}
            if {"state", "updated_at"} <= run_columns:
                active = connection.execute(
                    """UPDATE runs SET updated_at = updated_at
                       WHERE id = ? AND state IN ('exploring', 'verifying')""",
                    (run_id,),
                )
                if active.rowcount != 1:
                    raise ValueError("Production Run no longer accepts semantic results")
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
                accepted_id = evidence_record_id(
                    source_id=evidence.source_id,
                    revision=evidence.revision,
                    path=evidence.path,
                    source_unit=source_unit,
                    start_line=evidence.start_line,
                    end_line=evidence.end_line,
                    digest=evidence.digest,
                    evidence_kind=evidence.evidence_kind,
                    authority=evidence.authority,
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
                previous = connection.execute(
                    "SELECT epistemic_status FROM accepted_claims WHERE run_id = ? AND id = ?",
                    (run_id, accepted_id),
                ).fetchone()
                if previous is not None and previous["epistemic_status"] == "stale":
                    connection.execute(
                        "DELETE FROM claim_evidence WHERE run_id = ? AND claim_id = ?",
                        (run_id, accepted_id),
                    )
                    connection.execute(
                        "DELETE FROM claim_links WHERE run_id = ? AND claim_id = ?",
                        (run_id, accepted_id),
                    )
                    connection.execute(
                        "DELETE FROM obligation_claims WHERE run_id = ? AND claim_id = ?",
                        (run_id, accepted_id),
                    )
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
                previous = connection.execute(
                    "SELECT status FROM accepted_concepts WHERE run_id = ? AND id = ?",
                    (run_id, accepted_id),
                ).fetchone()
                if previous is not None and previous["status"] == "stale":
                    relation_ids = [
                        row["id"]
                        for row in connection.execute(
                            """SELECT id FROM concept_relations
                               WHERE run_id = ?
                                 AND (subject_concept_id = ? OR object_concept_id = ?)""",
                            (run_id, accepted_id, accepted_id),
                        )
                    ]
                    connection.executemany(
                        "DELETE FROM relation_evidence WHERE run_id = ? AND relation_id = ?",
                        [(run_id, relation_id) for relation_id in relation_ids],
                    )
                    connection.executemany(
                        "DELETE FROM concept_relations WHERE run_id = ? AND id = ?",
                        [(run_id, relation_id) for relation_id in relation_ids],
                    )
                    connection.execute(
                        "DELETE FROM concept_claims WHERE run_id = ? AND concept_id = ?",
                        (run_id, accepted_id),
                    )
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
                    append_entity_event(
                        connection,
                        run_id,
                        "coverage_obligation",
                        disposition.obligation_id,
                        previous,
                        disposition.disposition,
                        candidate_id=candidate.candidate_id,
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

    def clone_for_refresh(
        self,
        connection: sqlite3.Connection,
        base_run_id: str,
        run_id: str,
        *,
        previous_units: dict[str, dict],
        current_units: dict[str, dict],
        relocations: dict[str, str],
        stale_claim_ids: set[str],
        stale_concept_ids: set[str],
        obligation_ids: dict[str, str],
    ) -> None:
        evidence_ids: dict[str, str] = {}
        for row in connection.execute(
            "SELECT * FROM accepted_evidence WHERE run_id = ? ORDER BY id",
            (base_run_id,),
        ):
            record = dict(row)
            relocated = relocations.get(record["source_unit"])
            if relocated:
                before = previous_units[record["source_unit"]]
                after = current_units[relocated]
                offset = after.get("span", {}).get("start_line", 1) - before.get("span", {}).get(
                    "start_line", 1
                )
                record.update(
                    revision=after["revision"],
                    path=after["path"],
                    source_unit=relocated,
                    start_line=record["start_line"] + offset,
                    end_line=record["end_line"] + offset,
                )
            new_id = evidence_record_id(
                source_id=record["source_id"],
                revision=record["revision"],
                path=record["path"],
                source_unit=record["source_unit"],
                start_line=record["start_line"],
                end_line=record["end_line"],
                digest=record["digest"],
                evidence_kind=record["evidence_kind"],
                authority=record["authority"],
            )
            evidence_ids[row["id"]] = new_id
            connection.execute(
                """INSERT INTO accepted_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    new_id,
                    record["source_id"],
                    record["revision"],
                    record["path"],
                    record["source_unit"],
                    record["start_line"],
                    record["end_line"],
                    record["digest"],
                    record["evidence_kind"],
                    record["authority"],
                ),
            )
        connection.execute(
            """INSERT INTO accepted_claims
               SELECT ?, id, subject, predicate, statement, modality, conditions_json,
                      epistemic_status
               FROM accepted_claims WHERE run_id = ?""",
            (run_id, base_run_id),
        )
        connection.executemany(
            "UPDATE accepted_claims SET epistemic_status = 'stale' WHERE run_id = ? AND id = ?",
            [(run_id, claim_id) for claim_id in stale_claim_ids],
        )
        connection.executemany(
            "INSERT INTO claim_evidence VALUES (?, ?, ?)",
            [
                (run_id, row["claim_id"], evidence_ids[row["evidence_id"]])
                for row in connection.execute(
                    "SELECT claim_id, evidence_id FROM claim_evidence WHERE run_id = ?",
                    (base_run_id,),
                )
            ],
        )
        connection.executemany(
            "INSERT INTO obligation_claims VALUES (?, ?, ?)",
            [
                (run_id, obligation_ids[row["obligation_id"]], row["claim_id"])
                for row in connection.execute(
                    "SELECT obligation_id, claim_id FROM obligation_claims WHERE run_id = ?",
                    (base_run_id,),
                )
                if row["obligation_id"] in obligation_ids
            ],
        )
        connection.execute(
            """INSERT INTO claim_links
               SELECT ?, claim_id, kind, target_claim_id FROM claim_links WHERE run_id = ?""",
            (run_id, base_run_id),
        )
        connection.execute(
            """INSERT INTO accepted_concepts
               SELECT ?, id, canonical_name, aliases_json, description,
                      status
               FROM accepted_concepts WHERE run_id = ?""",
            (run_id, base_run_id),
        )
        connection.executemany(
            "UPDATE accepted_concepts SET status = 'stale' WHERE run_id = ? AND id = ?",
            [(run_id, concept_id) for concept_id in stale_concept_ids],
        )
        for table, columns in (
            ("concept_claims", "concept_id, claim_id, role"),
            (
                "concept_relations",
                "id, subject_concept_id, predicate, object_concept_id",
            ),
            ("page_plans", "concept_id, path, title"),
        ):
            connection.execute(
                f"INSERT INTO {table} SELECT ?, {columns} FROM {table} WHERE run_id = ?",
                (run_id, base_run_id),
            )
        connection.executemany(
            "INSERT INTO relation_evidence VALUES (?, ?, ?)",
            [
                (run_id, row["relation_id"], evidence_ids[row["evidence_id"]])
                for row in connection.execute(
                    "SELECT relation_id, evidence_id FROM relation_evidence WHERE run_id = ?",
                    (base_run_id,),
                )
            ],
        )

    def list_claims(self, run_id: str) -> list[ClaimRecord]:
        with self._connect() as connection:
            ids = [
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM accepted_claims WHERE run_id = ? ORDER BY id", (run_id,)
                )
            ]
        return [claim for claim_id in ids if (claim := self.get_claim(run_id, claim_id))]

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

    def list_concepts(self, run_id: str) -> list[ConceptRecord]:
        with self._connect() as connection:
            ids = [
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM accepted_concepts WHERE run_id = ? ORDER BY id", (run_id,)
                )
            ]
        return [concept for concept_id in ids if (concept := self.get_concept(run_id, concept_id))]

    def knowledge_summary(
        self, run_id: str, connection: sqlite3.Connection | None = None
    ) -> list[dict]:
        if connection is None:
            with self._connect() as owned_connection:
                return self.knowledge_summary(run_id, owned_connection)
        rows = list(
            connection.execute(
                """SELECT c.*, p.path FROM accepted_concepts c LEFT JOIN page_plans p
                     ON p.run_id = c.run_id AND p.concept_id = c.id
                   WHERE c.run_id = ? ORDER BY c.id""",
                (run_id,),
            )
        )
        if missing := next((row["id"] for row in rows if row["path"] is None), None):
            raise ValueError(f"Missing page plan for Concept: {missing}")
        return [
            {
                "id": row["id"],
                "canonical_name": row["canonical_name"],
                "aliases": cast(list[str], json.loads(row["aliases_json"])),
                "description": row["description"],
                "status": row["status"],
                "defining_claim_ids": [
                    item["claim_id"]
                    for item in connection.execute(
                        """SELECT claim_id FROM concept_claims
                           WHERE run_id = ? AND concept_id = ? AND role = 'defining'
                           ORDER BY claim_id""",
                        (run_id, row["id"]),
                    )
                ],
                "supporting_claim_ids": [
                    item["claim_id"]
                    for item in connection.execute(
                        """SELECT claim_id FROM concept_claims
                           WHERE run_id = ? AND concept_id = ? AND role = 'supporting'
                           ORDER BY claim_id""",
                        (run_id, row["id"]),
                    )
                ],
                "page": row["path"],
            }
            for row in rows
        ]

    def renderable_claims(self, run_id: str, concept_id: str) -> list[ClaimRecord]:
        concept = self.get_concept(run_id, concept_id)
        if concept is None:
            raise ValueError(f"Unknown Concept: {concept_id}")
        claim_ids = [*concept["defining_claim_ids"], *concept["supporting_claim_ids"]]
        return [
            claim
            for claim_id in claim_ids
            if (claim := self.get_claim(run_id, claim_id))
            and claim["epistemic_status"] == "supported"
        ]

    def reject_run(self, connection: sqlite3.Connection, run_id: str) -> None:
        for table in (
            "relation_evidence",
            "concept_relations",
            "page_plans",
            "concept_claims",
            "accepted_concepts",
            "claim_links",
            "obligation_claims",
            "claim_evidence",
            "accepted_claims",
            "accepted_evidence",
            "accepted_candidates",
        ):
            connection.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))

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
                            candidate_id=details.get("candidate_id"),
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
        claims = self.renderable_claims(run_id, concept_id)
        paragraphs = "\n\n".join(
            f"{' '.join(claim['statement'].split())}\n\n<!-- claims: {claim['id']} -->"
            for claim in claims
        )
        citations = "\n".join(
            f"* `{claim['id']}` — "
            + ", ".join(
                f"`repo://{evidence['source_id']}@{evidence['revision']}/"
                f"{evidence['path']}#L{evidence['start_line']}-L{evidence['end_line']}`"
                for evidence in claim["evidence"]
            )
            for claim in claims
        )
        return (
            f"# {concept['canonical_name']}\n\n"
            + (paragraphs or "No supported Claims.")
            + "\n\n# Citations\n\n"
            + (citations or "No citations.")
            + "\n"
        )
