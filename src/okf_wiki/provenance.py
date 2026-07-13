import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .accepted_knowledge import claim_record_id, concept_record_id
from .knowledge_contracts import WorkerProposal
from .state_schema import migrate_state
from .verification import AcceptanceDecision, VerificationFinding


MAX_GRAPH_NODES = 200
MAX_GRAPH_EDGES = 200
MAX_FINDINGS = 5
MAX_FINDING_EVIDENCE = 20
MAX_DECISION_REASONS = 20
MAX_DETAIL_TEXT = 2_000
PROVENANCE_NODE_TYPES = frozenset(
    {"source_unit", "evidence", "claim", "verification", "concept", "page"}
)
PROVENANCE_FILTER_STATES = frozenset(
    {
        "supported",
        "disputed",
        "stale",
        "conflicting",
        "superseded",
        "rejected",
        "blocked",
    }
)


class ConceptProvenanceStore:
    def __init__(self, database: Path) -> None:
        self.database = database
        with self._connect() as connection:
            migrate_state(connection)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def snapshot(
        self,
        run_id: str,
        *,
        concept_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
        node_types: tuple[str, ...] = (),
        states: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        if not 1 <= limit <= MAX_GRAPH_NODES:
            raise ValueError(f"limit must be between 1 and {MAX_GRAPH_NODES}")
        if offset < 0:
            raise ValueError("offset must be non-negative")
        if unknown := set(node_types) - PROVENANCE_NODE_TYPES:
            raise ValueError(f"Unknown provenance node type: {sorted(unknown)[0]}")
        if unknown := set(states) - PROVENANCE_FILTER_STATES:
            raise ValueError(f"Unknown provenance state: {sorted(unknown)[0]}")

        with self._connect() as connection:
            run = connection.execute(
                "SELECT state, revision, source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise ValueError(f"Unknown Production Run: {run_id}")
            source_set = json.loads(run["source_set_json"] or "{}")
            manifest = self._bundle_manifest(source_set)
            concepts = list(
                connection.execute(
                    """SELECT c.id, c.canonical_name, c.status, p.path
                       FROM accepted_concepts c LEFT JOIN page_plans p
                         ON p.run_id = c.run_id AND p.concept_id = c.id
                       WHERE c.run_id = ? ORDER BY c.canonical_name, c.id""",
                    (run_id,),
                )
            )
            selected = concept_id or (concepts[0]["id"] if concepts else None)
            if selected is not None and selected not in {row["id"] for row in concepts}:
                raise ValueError(f"Unknown Concept: {selected}")
            lineage = self._lineage_run_ids(connection, run_id)
            nodes, edges = self._graph(
                connection,
                run_id,
                selected,
                run,
                source_set,
                manifest,
                lineage,
            )

        total_nodes = len(nodes)
        total_edges = len(edges)
        type_filter = set(node_types)
        state_filter = set(states)
        filtered_nodes = [
            node
            for node in nodes
            if (not type_filter or node["type"] in type_filter)
            and (not state_filter or state_filter.intersection(node["states"]))
        ]
        filtered_ids = {node["id"] for node in filtered_nodes}
        filtered_edges = [
            edge
            for edge in edges
            if edge["source"] in filtered_ids and edge["target"] in filtered_ids
        ]
        bounded_nodes = filtered_nodes[offset : offset + limit]
        bounded_ids = {node["id"] for node in bounded_nodes}
        page_edges = [
            edge
            for edge in filtered_edges
            if edge["source"] in bounded_ids and edge["target"] in bounded_ids
        ]
        bounded_edges = page_edges[:MAX_GRAPH_EDGES]
        filtered_total_nodes = len(filtered_nodes)
        filtered_total_edges = len(filtered_edges)
        next_offset = offset + limit if offset + limit < filtered_total_nodes else None
        previous_offset = max(0, offset - limit) if offset else None
        return {
            "run_id": run_id,
            "run_state": run["state"],
            "selected_concept_id": selected,
            "concepts": [
                {
                    "id": row["id"],
                    "name": row["canonical_name"],
                    "status": row["status"],
                    "page": row["path"] if row["path"] in manifest else None,
                }
                for row in concepts
            ],
            "nodes": bounded_nodes,
            "edges": bounded_edges,
            "bounds": {
                "limit": limit,
                "offset": offset,
                "previous_offset": previous_offset,
                "next_offset": next_offset,
                "total_nodes": total_nodes,
                "total_edges": total_edges,
                "filtered_total_nodes": filtered_total_nodes,
                "filtered_total_edges": filtered_total_edges,
                "truncated": (
                    offset > 0 or next_offset is not None or len(page_edges) > len(bounded_edges)
                ),
            },
        }

    def _graph(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        concept_id: str | None,
        run: sqlite3.Row,
        source_set: dict[str, Any],
        manifest: dict[str, str],
        lineage: tuple[str, ...],
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if concept_id is None:
            return [], []
        events = self._events(connection, lineage)
        concept = connection.execute(
            """SELECT c.*, p.path, p.title FROM accepted_concepts c LEFT JOIN page_plans p
                 ON p.run_id = c.run_id AND p.concept_id = c.id
               WHERE c.run_id = ? AND c.id = ?""",
            (run_id, concept_id),
        ).fetchone()
        if concept is None:
            return [], []

        memberships = list(
            connection.execute(
                """SELECT claim_id, role FROM concept_claims
                   WHERE run_id = ? AND concept_id = ? ORDER BY role, claim_id""",
                (run_id, concept_id),
            )
        )
        claim_ids = [row["claim_id"] for row in memberships]
        role_by_claim = {row["claim_id"]: row["role"] for row in memberships}
        placeholders = ",".join("?" for _ in claim_ids)
        claims = (
            list(
                connection.execute(
                    f"""SELECT * FROM accepted_claims
                        WHERE run_id = ? AND id IN ({placeholders}) ORDER BY id""",
                    (run_id, *claim_ids),
                )
            )
            if claim_ids
            else []
        )
        claim_links = (
            list(
                connection.execute(
                    f"""SELECT claim_id, kind, target_claim_id FROM claim_links
                        WHERE run_id = ? AND (
                          claim_id IN ({placeholders}) OR target_claim_id IN ({placeholders})
                        ) ORDER BY claim_id, kind, target_claim_id""",
                    (run_id, *claim_ids, *claim_ids),
                )
            )
            if claim_ids
            else []
        )
        evidence = (
            list(
                connection.execute(
                    f"""SELECT e.*, ce.claim_id FROM accepted_evidence e JOIN claim_evidence ce
                          ON ce.run_id = e.run_id AND ce.evidence_id = e.id
                        WHERE ce.run_id = ? AND ce.claim_id IN ({placeholders})
                        ORDER BY e.id, ce.claim_id""",
                    (run_id, *claim_ids),
                )
            )
            if claim_ids
            else []
        )
        source_units = self._source_units(source_set)
        attributed_candidates = {
            (event["run_id"], event["candidate_id"])
            for entity_type, entity_id in [
                ("concept", concept_id),
                *(("claim", claim_id) for claim_id in claim_ids),
            ]
            for event in events.get((entity_type, entity_id), [])
            if event["candidate_id"] is not None
        }
        candidates = self._candidates(connection, lineage)
        blocked = list(
            connection.execute(
                """SELECT id, source, source_unit, reason FROM coverage_obligations
                   WHERE run_id = ? AND disposition = 'blocked' ORDER BY id""",
                (run_id,),
            )
        )
        selected_claim_ids = set(claim_ids)
        selected_sources = {(row["source_id"], row["source_unit"]) for row in evidence}

        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, str]] = []
        edge_ids: set[str] = set()
        self._add_node(
            nodes,
            concept_id,
            "concept",
            concept["canonical_name"],
            [concept["status"]],
            events.get(("concept", concept_id), []),
            run_id=run_id,
            decision=concept["status"],
        )
        if concept["path"] in manifest:
            page_id = f"page:{run_id}:{concept['path']}"
            self._add_node(
                nodes,
                page_id,
                "page",
                concept["title"],
                [],
                [],
                run_id=run_id,
                revision=run["revision"],
                path=concept["path"],
                digest=f"sha256:{manifest[concept['path']]}",
            )
            self._add_edge(edges, edge_ids, concept_id, page_id, "renders")

        incoming_conflicts = {
            row["target_claim_id"] for row in claim_links if row["kind"] == "conflicts_with"
        }
        outgoing_conflicts = {
            row["claim_id"] for row in claim_links if row["kind"] == "conflicts_with"
        }
        superseded = {row["target_claim_id"] for row in claim_links if row["kind"] == "supersedes"}
        for claim in claims:
            states = [claim["epistemic_status"]]
            if claim["id"] in incoming_conflicts | outgoing_conflicts:
                states.append("conflicting")
            if claim["id"] in superseded:
                states.append("superseded")
            self._add_node(
                nodes,
                claim["id"],
                "claim",
                claim["statement"],
                states,
                events.get(("claim", claim["id"]), []),
                run_id=run_id,
                role=role_by_claim[claim["id"]],
                decision=claim["epistemic_status"],
            )

        for candidate in candidates:
            candidate_key = (candidate["run_id"], candidate["candidate_id"])
            claim_targets, concept_targets = self._proposal_targets(candidate["proposal_json"])
            proposal_matches = concept_id in concept_targets.values()
            direct_targets: set[str] = set()
            for finding in candidate["findings"]:
                if finding.target_type == "claim":
                    target = claim_targets.get(finding.target_id, finding.target_id)
                    if target in selected_claim_ids:
                        direct_targets.add(target)
                elif finding.target_type == "concept":
                    target = concept_targets.get(finding.target_id, finding.target_id)
                    if target == concept_id:
                        direct_targets.add(target)
            if (
                candidate_key not in attributed_candidates
                and not direct_targets
                and not proposal_matches
            ):
                continue
            states = [candidate["status"]]
            if any(finding.verdict == "disputed" for finding in candidate["findings"]):
                states.append("disputed")
            node_id = f"verification:{candidate['run_id']}:candidate:{candidate['candidate_id']}"
            self._add_node(
                nodes,
                node_id,
                "verification",
                f"Verification · {candidate['candidate_id']}",
                states,
                [
                    event
                    for event in events.get(
                        ("verification_candidate", candidate["candidate_id"]), []
                    )
                    if event["run_id"] == candidate["run_id"]
                ],
                run_id=candidate["run_id"],
                candidate_id=candidate["candidate_id"],
                decision=candidate["decision"].outcome,
                metadata={
                    "findings": [
                        {
                            **finding.model_dump(mode="json"),
                            "target_id": finding.target_id[:MAX_DETAIL_TEXT],
                            "rationale": finding.rationale[:MAX_DETAIL_TEXT],
                            "evidence": [
                                item[:MAX_DETAIL_TEXT]
                                for item in finding.evidence[:MAX_FINDING_EVIDENCE]
                            ],
                        }
                        for finding in candidate["findings"][:MAX_FINDINGS]
                    ],
                    "reasons": [
                        reason[:MAX_DETAIL_TEXT]
                        for reason in candidate["decision"].reasons[:MAX_DECISION_REASONS]
                    ],
                },
            )
            for claim_id in claim_ids:
                if any(
                    event["run_id"] == candidate["run_id"]
                    and event["candidate_id"] == candidate["candidate_id"]
                    for event in events.get(("claim", claim_id), [])
                ):
                    self._add_edge(edges, edge_ids, claim_id, node_id, "verified_by")
            if any(
                event["run_id"] == candidate["run_id"]
                and event["candidate_id"] == candidate["candidate_id"]
                for event in events.get(("concept", concept_id), [])
            ):
                self._add_edge(edges, edge_ids, node_id, concept_id, "forms")
            elif proposal_matches and candidate["status"] != "accepted":
                self._add_edge(edges, edge_ids, node_id, concept_id, "proposes")
            for target_id in direct_targets:
                self._add_edge(edges, edge_ids, target_id, node_id, "assesses")

        for obligation in blocked:
            if (obligation["source"], obligation["source_unit"]) not in selected_sources:
                continue
            node_id = f"verification:{run_id}:obligation:{obligation['id']}"
            self._add_node(
                nodes,
                node_id,
                "verification",
                f"Blocked · {obligation['id']}",
                ["blocked"],
                events.get(("coverage_obligation", obligation["id"]), []),
                run_id=run_id,
                decision="blocked",
                metadata={
                    "reason": obligation["reason"][:MAX_DETAIL_TEXT]
                    if obligation["reason"]
                    else None
                },
            )
            matching_evidence = next(
                row
                for row in evidence
                if row["source_id"] == obligation["source"]
                and row["source_unit"] == obligation["source_unit"]
            )
            self._add_edge(
                edges,
                edge_ids,
                self._source_node_id(matching_evidence),
                node_id,
                "blocked_by",
            )

        evidence_nodes: set[str] = set()
        source_nodes: set[str] = set()
        for row in evidence:
            if row["id"] not in evidence_nodes:
                self._add_node(
                    nodes,
                    row["id"],
                    "evidence",
                    f"{row['path']}:{row['start_line']}-{row['end_line']}",
                    [],
                    [],
                    run_id=run_id,
                    revision=row["revision"],
                    path=row["path"],
                    span={"start_line": row["start_line"], "end_line": row["end_line"]},
                    digest=row["digest"],
                )
                evidence_nodes.add(row["id"])
            source_id = self._source_node_id(row)
            if source_id not in source_nodes:
                unit = source_units.get(
                    (row["source_id"], row["revision"].casefold(), row["source_unit"]), {}
                )
                self._add_node(
                    nodes,
                    source_id,
                    "source_unit",
                    row["source_unit"],
                    [],
                    [],
                    run_id=run_id,
                    revision=row["revision"],
                    path=row["path"],
                    span=unit.get("span"),
                    digest=unit.get("digest"),
                )
                source_nodes.add(source_id)
            self._add_edge(edges, edge_ids, source_id, row["id"], "contains")
            self._add_edge(edges, edge_ids, row["id"], row["claim_id"], "grounds")

        for row in claim_links:
            if (
                row["claim_id"] in selected_claim_ids
                and row["target_claim_id"] in selected_claim_ids
            ):
                self._add_edge(
                    edges,
                    edge_ids,
                    row["claim_id"],
                    row["target_claim_id"],
                    row["kind"],
                )
        return nodes, edges

    @staticmethod
    def _lineage_run_ids(connection: sqlite3.Connection, run_id: str) -> tuple[str, ...]:
        lineage: list[str] = []
        visiting: set[str] = set()

        def visit(current: str) -> None:
            if current in lineage:
                return
            if current in visiting:
                raise ValueError("Production Run lineage contains a cycle")
            visiting.add(current)
            row = connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (current,)
            ).fetchone()
            if row is None:
                visiting.remove(current)
                return
            try:
                source_set = json.loads(row["source_set_json"] or "{}")
            except json.JSONDecodeError:
                source_set = {}
            base_run_id = source_set.get("base_run_id")
            if isinstance(base_run_id, str) and base_run_id:
                visit(base_run_id)
            visiting.remove(current)
            lineage.append(current)

        visit(run_id)
        return tuple(lineage)

    @staticmethod
    def _events(
        connection: sqlite3.Connection, run_ids: tuple[str, ...]
    ) -> dict[tuple[str, str], list[dict[str, Any]]]:
        events: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for run_id in run_ids:
            for row in connection.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
            ):
                try:
                    details = json.loads(row["details"])
                except json.JSONDecodeError:
                    continue
                entity_type = details.get("entity_type")
                entity_id = details.get("entity_id")
                if not isinstance(entity_type, str) or not isinstance(entity_id, str):
                    continue
                events[(entity_type, entity_id)].append(
                    {
                        "run_id": run_id,
                        "entity_type": entity_type,
                        "sequence": row["sequence"],
                        "previous_state": row["previous_state"],
                        "state": row["state"],
                        "occurred_at": row["occurred_at"],
                        "candidate_id": details.get("candidate_id"),
                    }
                )
        return events

    @staticmethod
    def _candidates(
        connection: sqlite3.Connection, run_ids: tuple[str, ...]
    ) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for run_id in run_ids:
            findings: dict[str, list[VerificationFinding]] = defaultdict(list)
            for row in connection.execute(
                """SELECT candidate_id, finding_json FROM verification_findings
                   WHERE run_id = ? ORDER BY candidate_id, perspective""",
                (run_id,),
            ):
                try:
                    findings[row["candidate_id"]].append(
                        VerificationFinding.model_validate_json(row["finding_json"])
                    )
                except ValidationError:
                    continue
            for row in connection.execute(
                """SELECT candidate_id, status, proposal_json, decision_json
                   FROM verification_candidates
                   WHERE run_id = ? AND decision_json IS NOT NULL ORDER BY rowid""",
                (run_id,),
            ):
                try:
                    decision = AcceptanceDecision.model_validate_json(row["decision_json"])
                except ValidationError:
                    continue
                if row["status"] != decision.outcome:
                    continue
                candidates.append(
                    {
                        "run_id": run_id,
                        "candidate_id": row["candidate_id"],
                        "status": row["status"],
                        "proposal_json": row["proposal_json"],
                        "decision": decision,
                        "findings": findings[row["candidate_id"]],
                    }
                )
        return candidates

    @staticmethod
    def _proposal_targets(proposal_json: str) -> tuple[dict[str, str], dict[str, str]]:
        try:
            proposal = WorkerProposal.model_validate_json(proposal_json)
        except ValidationError:
            return {}, {}
        claims = {
            claim.id: claim_record_id(
                subject=claim.subject,
                predicate=claim.predicate,
                statement=claim.text,
                modality=claim.modality,
                conditions=claim.conditions,
            )
            for claim in proposal.claims
        }
        concepts: dict[str, str] = {}
        for concept in proposal.concepts:
            defining = concept.defining_claim_ids or sorted(concept.claim_ids)
            if any(claim_id not in claims for claim_id in defining):
                continue
            concepts[concept.id] = concept_record_id([claims[claim_id] for claim_id in defining])
        return claims, concepts

    @staticmethod
    def _bundle_manifest(source_set: dict[str, Any]) -> dict[str, str]:
        manifest = source_set.get("bundle_manifest")
        if not isinstance(manifest, dict):
            return {}
        return {
            path: digest
            for path, digest in manifest.items()
            if isinstance(path, str)
            and isinstance(digest, str)
            and re.fullmatch(r"[0-9a-f]{64}", digest)
        }

    @staticmethod
    def _source_units(source_set: dict[str, Any]) -> dict[tuple[str, str, str], dict]:
        return {
            (unit["source_id"], unit["revision"].casefold(), unit["source_unit"]): unit
            for unit in source_set.get("source_universe", [])
            if isinstance(unit, dict)
            and all(key in unit for key in ("source_id", "revision", "source_unit"))
        }

    @staticmethod
    def _source_node_id(row: sqlite3.Row) -> str:
        return f"source-unit:{row['source_id']}@{row['revision']}:{row['source_unit']}"

    @staticmethod
    def _add_node(
        nodes: list[dict[str, Any]],
        node_id: str,
        node_type: str,
        label: str,
        states: list[str],
        events: list[dict[str, Any]],
        *,
        run_id: str,
        **details: Any,
    ) -> None:
        nodes.append(
            {
                "id": node_id,
                "stable_id": node_id,
                "run_id": run_id,
                "type": node_type,
                "label": label,
                "states": states,
                "events": events,
                "revision": details.pop("revision", None),
                "path": details.pop("path", None),
                "span": details.pop("span", None),
                "digest": details.pop("digest", None),
                "decision": details.pop("decision", None),
                **details,
            }
        )

    @staticmethod
    def _add_edge(
        edges: list[dict[str, str]],
        edge_ids: set[str],
        source: str,
        target: str,
        relation: str,
    ) -> None:
        edge_id = f"{source}|{relation}|{target}"
        if edge_id in edge_ids:
            return
        edge_ids.add(edge_id)
        edges.append(
            {
                "id": edge_id,
                "source": source,
                "target": target,
                "relation": relation,
            }
        )
