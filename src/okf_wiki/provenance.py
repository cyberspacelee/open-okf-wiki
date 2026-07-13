import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any

from .state_schema import migrate_state


MAX_GRAPH_NODES = 200


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
    ) -> dict[str, Any]:
        if not 1 <= limit <= MAX_GRAPH_NODES:
            raise ValueError(f"limit must be between 1 and {MAX_GRAPH_NODES}")
        with self._connect() as connection:
            run = connection.execute(
                "SELECT state, source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise ValueError(f"Unknown Production Run: {run_id}")
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
            nodes, edges = self._graph(connection, run_id, selected, run["source_set_json"])

        total_nodes = len(nodes)
        total_edges = len(edges)
        bounded_nodes = nodes[:limit]
        node_ids = {node["id"] for node in bounded_nodes}
        bounded_edges = [
            edge for edge in edges if edge["source"] in node_ids and edge["target"] in node_ids
        ][: limit * 2]
        return {
            "run_id": run_id,
            "run_state": run["state"],
            "selected_concept_id": selected,
            "concepts": [
                {
                    "id": row["id"],
                    "name": row["canonical_name"],
                    "status": row["status"],
                    "page": row["path"],
                }
                for row in concepts
            ],
            "nodes": bounded_nodes,
            "edges": bounded_edges,
            "bounds": {
                "limit": limit,
                "total_nodes": total_nodes,
                "total_edges": total_edges,
                "truncated": total_nodes > len(bounded_nodes) or total_edges > len(bounded_edges),
            },
        }

    def _graph(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        concept_id: str | None,
        source_set_json: str | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if concept_id is None:
            return [], []
        events = self._events(connection, run_id)
        concept = connection.execute(
            """SELECT c.*, p.path, p.title FROM accepted_concepts c JOIN page_plans p
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
        source_units = self._source_units(source_set_json)
        candidate_ids = {
            event["candidate_id"]
            for entity_id in [concept_id, *claim_ids]
            for event in events.get(entity_id, [])
            if event["candidate_id"] is not None
        }
        candidates = list(
            connection.execute(
                """SELECT candidate_id, status, decision_json FROM verification_candidates
                   WHERE run_id = ? AND decision_json IS NOT NULL ORDER BY rowid""",
                (run_id,),
            )
        )
        findings: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in connection.execute(
            """SELECT candidate_id, finding_json FROM verification_findings
               WHERE run_id = ? ORDER BY candidate_id, perspective""",
            (run_id,),
        ):
            findings[row["candidate_id"]].append(json.loads(row["finding_json"]))
        blocked = list(
            connection.execute(
                """SELECT id, source, source_unit, reason FROM coverage_obligations
                   WHERE run_id = ? AND disposition = 'blocked' ORDER BY id""",
                (run_id,),
            )
        )
        selected_targets = {concept_id, *claim_ids}
        selected_sources = {(row["source_id"], row["source_unit"]) for row in evidence}

        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, str]] = []
        self._add_node(
            nodes,
            concept_id,
            "concept",
            concept["canonical_name"],
            [concept["status"]],
            events.get(concept_id, []),
            decision=concept["status"],
        )
        page_id = f"page:{concept['path']}"
        self._add_node(
            nodes,
            page_id,
            "page",
            concept["title"],
            [],
            [],
            path=concept["path"],
        )
        self._add_edge(edges, concept_id, page_id, "renders")

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
                events.get(claim["id"], []),
                role=role_by_claim[claim["id"]],
                decision=claim["epistemic_status"],
            )

        for candidate in candidates:
            candidate_id = candidate["candidate_id"]
            direct_targets = {
                finding["target_id"]
                for finding in findings[candidate_id]
                if finding["target_id"] in selected_targets
            }
            if candidate_id not in candidate_ids and not direct_targets:
                continue
            decision = json.loads(candidate["decision_json"])
            states = [candidate["status"]]
            states.extend(
                "disputed" for finding in findings[candidate_id] if finding["verdict"] == "disputed"
            )
            node_id = f"verification:{candidate_id}"
            self._add_node(
                nodes,
                node_id,
                "verification",
                f"Verification · {candidate_id}",
                list(dict.fromkeys(states)),
                events.get(candidate_id, []),
                candidate_id=candidate_id,
                decision=decision["outcome"],
                metadata={"findings": findings[candidate_id], "reasons": decision["reasons"]},
            )
            if candidate_id in candidate_ids:
                for claim_id in claim_ids:
                    if any(
                        event["candidate_id"] == candidate_id for event in events.get(claim_id, [])
                    ):
                        self._add_edge(edges, claim_id, node_id, "verified_by")
                if any(
                    event["candidate_id"] == candidate_id for event in events.get(concept_id, [])
                ):
                    self._add_edge(edges, node_id, concept_id, "forms")
            for target_id in direct_targets:
                self._add_edge(edges, target_id, node_id, "assesses")

        for obligation in blocked:
            if (obligation["source"], obligation["source_unit"]) not in selected_sources:
                continue
            node_id = f"verification:obligation:{obligation['id']}"
            self._add_node(
                nodes,
                node_id,
                "verification",
                f"Blocked · {obligation['id']}",
                ["blocked"],
                events.get(obligation["id"], []),
                decision="blocked",
                metadata={"reason": obligation["reason"]},
            )
            matching_evidence = next(
                row
                for row in evidence
                if row["source_id"] == obligation["source"]
                and row["source_unit"] == obligation["source_unit"]
            )
            self._add_edge(edges, self._source_node_id(matching_evidence), node_id, "blocked_by")

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
                    revision=row["revision"],
                    path=row["path"],
                    span={"start_line": row["start_line"], "end_line": row["end_line"]},
                    digest=row["digest"],
                )
                evidence_nodes.add(row["id"])
            source_id = self._source_node_id(row)
            if source_id not in source_nodes:
                unit = source_units.get((row["source_id"], row["revision"], row["source_unit"]), {})
                self._add_node(
                    nodes,
                    source_id,
                    "source_unit",
                    row["source_unit"],
                    [],
                    [],
                    revision=row["revision"],
                    path=row["path"],
                    span=unit.get("span"),
                    digest=unit.get("digest"),
                )
                source_nodes.add(source_id)
            self._add_edge(edges, source_id, row["id"], "contains")
            self._add_edge(edges, row["id"], row["claim_id"], "grounds")

        for row in claim_links:
            if row["claim_id"] in claim_ids and row["target_claim_id"] in claim_ids:
                self._add_edge(edges, row["claim_id"], row["target_claim_id"], row["kind"])
        return nodes, edges

    @staticmethod
    def _events(connection: sqlite3.Connection, run_id: str) -> dict[str, list[dict[str, Any]]]:
        events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in connection.execute(
            "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
        ):
            details = json.loads(row["details"])
            entity_id = details.get("entity_id")
            if not isinstance(entity_id, str):
                continue
            events[entity_id].append(
                {
                    "sequence": row["sequence"],
                    "previous_state": row["previous_state"],
                    "state": row["state"],
                    "occurred_at": row["occurred_at"],
                    "candidate_id": details.get("candidate_id"),
                }
            )
        return events

    @staticmethod
    def _source_units(source_set_json: str | None) -> dict[tuple[str, str, str], dict]:
        source_set = json.loads(source_set_json) if source_set_json else {}
        return {
            (unit["source_id"], unit["revision"].casefold(), unit["source_unit"]): unit
            for unit in source_set.get("source_universe", [])
            if all(key in unit for key in ("source_id", "revision", "source_unit"))
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
        **details: Any,
    ) -> None:
        nodes.append(
            {
                "id": node_id,
                "stable_id": node_id,
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
    def _add_edge(edges: list[dict[str, str]], source: str, target: str, relation: str) -> None:
        edges.append(
            {
                "id": f"{source}|{relation}|{target}",
                "source": source,
                "target": target,
                "relation": relation,
            }
        )
