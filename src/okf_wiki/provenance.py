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
MAX_REPLAY_EVENTS = 100
MAX_REPLAY_PATHS = 100
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


def _bounded_text(value: str) -> str:
    return value[:MAX_DETAIL_TEXT]


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

    def replay(
        self,
        run_id: str,
        *,
        event_limit: int = 50,
        event_offset: int = 0,
        event_sequence: int | None = None,
        entity_id: str | None = None,
        impact_limit: int = 100,
        impact_offset: int = 0,
        path_limit: int = 50,
        path_offset: int = 0,
    ) -> dict[str, Any]:
        if not 1 <= event_limit <= MAX_REPLAY_EVENTS:
            raise ValueError(f"event_limit must be between 1 and {MAX_REPLAY_EVENTS}")
        if event_offset < 0:
            raise ValueError("event_offset must be non-negative")
        if event_sequence is not None and event_sequence < 1:
            raise ValueError("event_sequence must be positive")
        if entity_id is not None and (not entity_id or len(entity_id) > MAX_DETAIL_TEXT):
            raise ValueError("entity_id must be a non-empty bounded string")
        if event_sequence is not None and entity_id is not None:
            raise ValueError("Choose either event_sequence or entity_id")
        if not 1 <= impact_limit <= MAX_GRAPH_NODES:
            raise ValueError(f"impact_limit must be between 1 and {MAX_GRAPH_NODES}")
        if impact_offset < 0:
            raise ValueError("impact_offset must be non-negative")
        if not 1 <= path_limit <= MAX_REPLAY_PATHS:
            raise ValueError(f"path_limit must be between 1 and {MAX_REPLAY_PATHS}")
        if path_offset < 0:
            raise ValueError("path_offset must be non-negative")
        with self._connect() as connection:
            run = connection.execute(
                "SELECT state, source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise ValueError(f"Unknown Production Run: {run_id}")
            lineage = self._lineage_run_ids(connection, run_id)
            placeholders = ",".join("?" for _ in lineage)
            event_where = f"""run_id IN ({placeholders}) AND json_valid(details) AND (
                (json_extract(details, '$.entity_type') = 'verification_candidate'
                 AND state IN ('staged', 'accepted', 'rejected',
                               'review_required', 'revision_required'))
                OR (json_extract(details, '$.entity_type') = 'claim'
                    AND state IN ('supported', 'disputed', 'stale'))
                OR (json_extract(details, '$.entity_type') = 'concept'
                    AND state IN ('active', 'disputed', 'stale'))
                OR (state = 'published' AND (
                    json_extract(details, '$.entity_type') IS NULL
                    OR json_extract(details, '$.entity_type') = 'production_run'
                ))
            )"""
            total = connection.execute(
                f"SELECT COUNT(*) FROM run_events WHERE {event_where}", lineage
            ).fetchone()[0]
            located_sequence = event_sequence
            if entity_id is not None:
                located = connection.execute(
                    f"""SELECT sequence FROM run_events WHERE {event_where} AND
                        CASE
                          WHEN state = 'published'
                               AND json_extract(details, '$.entity_id') IS NULL
                            THEN run_id
                          ELSE json_extract(details, '$.entity_id')
                        END = ?
                        ORDER BY sequence LIMIT 1""",
                    (*lineage, entity_id),
                ).fetchone()
                if located is None:
                    raise ValueError(f"Unknown replay entity: {entity_id}")
                located_sequence = located[0]
            elif event_sequence is not None:
                located = connection.execute(
                    f"""SELECT sequence FROM run_events
                        WHERE {event_where} AND sequence = ?""",
                    (*lineage, event_sequence),
                ).fetchone()
                if located is None:
                    raise ValueError(f"Unknown replay event sequence: {event_sequence}")
            if located_sequence is not None:
                rank = (
                    connection.execute(
                        f"""SELECT COUNT(*) FROM run_events
                        WHERE {event_where} AND sequence <= ?""",
                        (*lineage, located_sequence),
                    ).fetchone()[0]
                    - 1
                )
                event_offset = (rank // event_limit) * event_limit
            rows = list(
                connection.execute(
                    f"""SELECT * FROM run_events WHERE {event_where}
                        ORDER BY sequence LIMIT ? OFFSET ?""",
                    (*lineage, event_limit, event_offset),
                )
            )
            events = [event for row in rows if (event := self._replay_event(row, {})) is not None]
            labels = self._replay_labels(connection, lineage, events)
            for event in events:
                event["entity_label"] = _bounded_text(
                    labels.get(
                        (event["entity_type"], event["entity_id"]),
                        event["entity_id"],
                    )
                )
            try:
                source_set = json.loads(run["source_set_json"] or "{}")
            except json.JSONDecodeError:
                source_set = {}
            if not isinstance(source_set, dict):
                source_set = {}
            impact = self._bounded_impact_snapshot(
                connection,
                run_id,
                source_set,
                limit=impact_limit,
                offset=impact_offset,
                path_limit=path_limit,
                path_offset=path_offset,
            )
        return {
            "run_id": run_id,
            "run_state": run["state"],
            "lineage_run_ids": list(lineage),
            "events": events,
            "located_event_sequence": located_sequence,
            "event_bounds": {
                "limit": event_limit,
                "offset": event_offset,
                "previous_offset": max(0, event_offset - event_limit) if event_offset else None,
                "next_offset": event_offset + event_limit
                if event_offset + event_limit < total
                else None,
                "total": total,
                "truncated": event_offset > 0 or event_offset + event_limit < total,
            },
            "impact": impact,
        }

    def _bounded_impact_snapshot(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        source_set: dict[str, Any],
        *,
        limit: int,
        offset: int,
        path_limit: int,
        path_offset: int,
    ) -> dict[str, Any]:
        refresh = source_set.get("refresh")
        refresh = refresh if isinstance(refresh, dict) else {}
        diff = refresh.get("diff")
        diff = diff if isinstance(diff, dict) else {}
        changes = self._impact_changes(diff)
        graph_run_id = source_set.get("base_run_id")
        if (
            not isinstance(graph_run_id, str)
            or not connection.execute("SELECT 1 FROM runs WHERE id = ?", (graph_run_id,)).fetchone()
        ):
            graph_run_id = run_id
        mode = refresh.get("mode") if refresh.get("mode") in {"incremental", "full"} else "full"
        recorded_reason = refresh.get("fallback_reason")
        fallback_reason = (
            _bounded_text(recorded_reason)
            if isinstance(recorded_reason, str) and recorded_reason
            else None
        )
        full_analysis = mode == "full"
        affected_claims = self._string_set(refresh.get("reverify_claims"))
        affected_concepts = self._string_set(refresh.get("reverify_concepts"))
        affected_pages = self._string_set(refresh.get("rerender_pages"))

        change_nodes: list[dict[str, Any]] = []
        source_nodes: dict[str, str] = {}
        for change in changes:
            unit = change["after"] or change["before"]
            if unit is None:
                continue
            node_id = f"source-unit:{change['status']}:{unit['id']}"
            change_nodes.append(
                {
                    "id": node_id,
                    "entity_id": unit["id"],
                    "type": "source_unit",
                    "label": _bounded_text(unit["label"] or unit["path"]),
                    "status": change["status"],
                    "before": change["before"],
                    "after": change["after"],
                }
            )
            if change["status"] in {"changed", "removed"} and change["before"]:
                source_nodes[change["before"]["id"]] = node_id
        connection.execute(
            "CREATE TEMP TABLE replay_changed_units (source_unit TEXT PRIMARY KEY, node_id TEXT)"
        )
        connection.executemany(
            "INSERT INTO replay_changed_units VALUES (?, ?)", source_nodes.items()
        )

        counts = {
            "evidence": connection.execute(
                "SELECT COUNT(*) FROM accepted_evidence WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0],
            "claims": connection.execute(
                "SELECT COUNT(*) FROM accepted_claims WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0],
            "concepts": connection.execute(
                "SELECT COUNT(*) FROM accepted_concepts WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0],
            "pages": connection.execute(
                "SELECT COUNT(*) FROM page_plans WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0],
        }
        affected_evidence_count = (
            counts["evidence"]
            if full_analysis
            else connection.execute(
                """SELECT COUNT(*) FROM accepted_evidence evidence
                   JOIN replay_changed_units changed
                     ON changed.source_unit = evidence.source_unit
                   WHERE evidence.run_id = ?""",
                (graph_run_id,),
            ).fetchone()[0]
        )
        total_nodes = len(change_nodes) + sum(counts.values())
        remaining = limit
        skipped = offset
        page_nodes: list[dict[str, Any]] = []

        if skipped < len(change_nodes):
            selected = change_nodes[skipped : skipped + remaining]
            page_nodes.extend(selected)
            remaining -= len(selected)
            skipped = 0
        else:
            skipped -= len(change_nodes)

        def take(total: int, query: str) -> list[sqlite3.Row]:
            nonlocal remaining, skipped
            if remaining == 0:
                return []
            if skipped >= total:
                skipped -= total
                return []
            rows = list(connection.execute(query, (graph_run_id, remaining, skipped)))
            remaining -= len(rows)
            skipped = 0
            return rows

        for row in take(
            counts["evidence"],
            """SELECT evidence.*,
                      EXISTS (
                        SELECT 1 FROM replay_changed_units changed
                        WHERE changed.source_unit = evidence.source_unit
                      ) AS affected
               FROM accepted_evidence evidence WHERE evidence.run_id = ?
               ORDER BY evidence.id LIMIT ? OFFSET ?""",
        ):
            page_nodes.append(
                {
                    "id": row["id"],
                    "entity_id": row["id"],
                    "type": "evidence",
                    "label": _bounded_text(f"{row['path']}:{row['start_line']}-{row['end_line']}"),
                    "status": "affected" if full_analysis or row["affected"] else "stable",
                    "before": None,
                    "after": None,
                }
            )
        for row in take(
            counts["claims"],
            """SELECT id, statement FROM accepted_claims WHERE run_id = ?
               ORDER BY id LIMIT ? OFFSET ?""",
        ):
            page_nodes.append(
                {
                    "id": row["id"],
                    "entity_id": row["id"],
                    "type": "claim",
                    "label": _bounded_text(row["statement"]),
                    "status": "affected"
                    if full_analysis or row["id"] in affected_claims
                    else "stable",
                    "before": None,
                    "after": None,
                }
            )
        for row in take(
            counts["concepts"],
            """SELECT id, canonical_name FROM accepted_concepts WHERE run_id = ?
               ORDER BY id LIMIT ? OFFSET ?""",
        ):
            page_nodes.append(
                {
                    "id": row["id"],
                    "entity_id": row["id"],
                    "type": "concept",
                    "label": _bounded_text(row["canonical_name"]),
                    "status": "affected"
                    if full_analysis or row["id"] in affected_concepts
                    else "stable",
                    "before": None,
                    "after": None,
                }
            )
        for row in take(
            counts["pages"],
            """SELECT path, title FROM page_plans WHERE run_id = ?
               ORDER BY path LIMIT ? OFFSET ?""",
        ):
            page_nodes.append(
                {
                    "id": f"page:{row['path']}",
                    "entity_id": row["path"],
                    "type": "page",
                    "label": _bounded_text(row["title"]),
                    "status": "affected"
                    if full_analysis or row["path"] in affected_pages
                    else "stable",
                    "before": None,
                    "after": None,
                }
            )

        paths, path_total = self._impact_paths(
            connection,
            graph_run_id,
            source_nodes,
            change_nodes,
            limit=path_limit,
            offset=path_offset,
        )
        visible = {node["id"]: node for node in page_nodes}
        visible_evidence = [node["id"] for node in page_nodes if node["type"] == "evidence"]
        visible_claims = [node["id"] for node in page_nodes if node["type"] == "claim"]
        visible_concepts = [node["id"] for node in page_nodes if node["type"] == "concept"]
        visible_pages = [node["entity_id"] for node in page_nodes if node["type"] == "page"]
        visible_sources = {
            node["entity_id"]: node["id"]
            for node in page_nodes
            if node["type"] == "source_unit" and node["status"] in {"changed", "removed"}
        }
        edges: list[dict[str, str]] = []
        if visible_sources and visible_evidence:
            source_placeholders = ",".join("?" for _ in visible_sources)
            evidence_placeholders = ",".join("?" for _ in visible_evidence)
            for row in connection.execute(
                f"""SELECT source_unit, id FROM accepted_evidence
                    WHERE run_id = ? AND source_unit IN ({source_placeholders})
                      AND id IN ({evidence_placeholders}) LIMIT {MAX_GRAPH_EDGES + 1}""",
                (graph_run_id, *visible_sources, *visible_evidence),
            ):
                self._add_impact_edge(
                    edges, visible_sources[row["source_unit"]], row["id"], "contains"
                )
        for source_ids, target_ids, table, source_column, target_column, relation in (
            (
                visible_evidence,
                visible_claims,
                "claim_evidence",
                "evidence_id",
                "claim_id",
                "grounds",
            ),
            (
                visible_claims,
                visible_concepts,
                "concept_claims",
                "claim_id",
                "concept_id",
                "forms",
            ),
        ):
            if not source_ids or not target_ids:
                continue
            source_placeholders = ",".join("?" for _ in source_ids)
            target_placeholders = ",".join("?" for _ in target_ids)
            for row in connection.execute(
                f"""SELECT {source_column}, {target_column} FROM {table}
                    WHERE run_id = ? AND {source_column} IN ({source_placeholders})
                      AND {target_column} IN ({target_placeholders})
                    LIMIT {MAX_GRAPH_EDGES + 1}""",
                (graph_run_id, *source_ids, *target_ids),
            ):
                self._add_impact_edge(edges, row[source_column], row[target_column], relation)
        if visible_concepts and visible_pages:
            concept_placeholders = ",".join("?" for _ in visible_concepts)
            page_placeholders = ",".join("?" for _ in visible_pages)
            for row in connection.execute(
                f"""SELECT concept_id, path FROM page_plans
                    WHERE run_id = ? AND concept_id IN ({concept_placeholders})
                      AND path IN ({page_placeholders}) LIMIT {MAX_GRAPH_EDGES + 1}""",
                (graph_run_id, *visible_concepts, *visible_pages),
            ):
                self._add_impact_edge(edges, row["concept_id"], f"page:{row['path']}", "renders")
        edges = [
            edge
            for edge in edges[:MAX_GRAPH_EDGES]
            if edge["source"] in visible and edge["target"] in visible
        ]
        total_edges = (
            connection.execute(
                """SELECT COUNT(*) FROM accepted_evidence evidence
                   JOIN replay_changed_units changed
                     ON changed.source_unit = evidence.source_unit
                   WHERE evidence.run_id = ?""",
                (graph_run_id,),
            ).fetchone()[0]
            + connection.execute(
                "SELECT COUNT(*) FROM claim_evidence WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0]
            + connection.execute(
                "SELECT COUNT(*) FROM concept_claims WHERE run_id = ?", (graph_run_id,)
            ).fetchone()[0]
            + counts["pages"]
        )
        next_offset = offset + limit if offset + limit < total_nodes else None
        return {
            "mode": mode,
            "fallback_reason": fallback_reason,
            "summary": {
                "changes": {
                    kind: sum(change["status"] == kind for change in changes)
                    for kind in ("added", "changed", "moved", "removed")
                },
                "affected": {
                    "evidence": affected_evidence_count,
                    "claims": counts["claims"] if full_analysis else len(affected_claims),
                    "concepts": counts["concepts"] if full_analysis else len(affected_concepts),
                    "pages": counts["pages"] if full_analysis else len(affected_pages),
                },
                "stable": {
                    "evidence": max(0, counts["evidence"] - affected_evidence_count),
                    "claims": 0
                    if full_analysis
                    else max(0, counts["claims"] - len(affected_claims)),
                    "concepts": 0
                    if full_analysis
                    else max(0, counts["concepts"] - len(affected_concepts)),
                    "pages": 0 if full_analysis else max(0, counts["pages"] - len(affected_pages)),
                },
            },
            "nodes": page_nodes,
            "edges": edges,
            "paths": paths,
            "path_bounds": {
                "limit": path_limit,
                "offset": path_offset,
                "previous_offset": max(0, path_offset - path_limit) if path_offset else None,
                "next_offset": path_offset + path_limit
                if path_offset + path_limit < path_total
                else None,
                "total": path_total,
                "truncated": path_offset > 0 or path_offset + path_limit < path_total,
            },
            "bounds": {
                "limit": limit,
                "offset": offset,
                "previous_offset": max(0, offset - limit) if offset else None,
                "next_offset": next_offset,
                "total_nodes": total_nodes,
                "total_edges": total_edges,
                "truncated": offset > 0 or next_offset is not None or len(edges) < total_edges,
            },
        }

    @staticmethod
    def _impact_paths(
        connection: sqlite3.Connection,
        run_id: str,
        source_nodes: dict[str, str],
        nodes: list[dict[str, Any]],
        *,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        if not source_nodes:
            return [], 0
        joins = """FROM replay_changed_units changed
            JOIN accepted_evidence evidence ON evidence.source_unit = changed.source_unit
            JOIN claim_evidence claim_evidence
              ON claim_evidence.run_id = evidence.run_id
             AND claim_evidence.evidence_id = evidence.id
            JOIN accepted_claims claim
              ON claim.run_id = claim_evidence.run_id
             AND claim.id = claim_evidence.claim_id
            JOIN concept_claims concept_claim
              ON concept_claim.run_id = claim.run_id
             AND concept_claim.claim_id = claim.id
            JOIN accepted_concepts concept
              ON concept.run_id = concept_claim.run_id
             AND concept.id = concept_claim.concept_id
            JOIN page_plans page
              ON page.run_id = concept.run_id
             AND page.concept_id = concept.id
            WHERE evidence.run_id = ?"""
        total = connection.execute(f"SELECT COUNT(*) {joins}", (run_id,)).fetchone()[0]
        rows = connection.execute(
            f"""SELECT changed.node_id, changed.source_unit,
                       evidence.id AS evidence_id, evidence.path AS evidence_path,
                       evidence.start_line, evidence.end_line,
                       claim.id AS claim_id, claim.statement,
                       concept.id AS concept_id, concept.canonical_name,
                       page.path AS page_path, page.title AS page_title
                {joins}
                ORDER BY changed.source_unit, evidence.id, claim.id, concept.id, page.path
                LIMIT ? OFFSET ?""",
            (run_id, limit, offset),
        )
        source_by_id = {node["id"]: node for node in nodes if node["type"] == "source_unit"}
        paths = []
        for row in rows:
            source = source_by_id[row["node_id"]]
            items = {
                "source": {
                    "id": source["id"],
                    "entity_id": row["source_unit"],
                    "type": "source_unit",
                    "label": _bounded_text(source["label"]),
                },
                "evidence": {
                    "id": row["evidence_id"],
                    "entity_id": row["evidence_id"],
                    "type": "evidence",
                    "label": _bounded_text(
                        f"{row['evidence_path']}:{row['start_line']}-{row['end_line']}"
                    ),
                },
                "claim": {
                    "id": row["claim_id"],
                    "entity_id": row["claim_id"],
                    "type": "claim",
                    "label": _bounded_text(row["statement"]),
                },
                "concept": {
                    "id": row["concept_id"],
                    "entity_id": row["concept_id"],
                    "type": "concept",
                    "label": _bounded_text(row["canonical_name"]),
                },
                "page": {
                    "id": f"page:{row['page_path']}",
                    "entity_id": row["page_path"],
                    "type": "page",
                    "label": _bounded_text(row["page_title"]),
                },
            }
            paths.append(
                {
                    "id": "|".join(items[stage]["id"] for stage in items),
                    **items,
                }
            )
        return paths, total

    @classmethod
    def _impact_changes(cls, diff: dict[str, Any]) -> list[dict[str, Any]]:
        changes: list[dict[str, Any]] = []
        for status in ("added", "removed"):
            values = diff.get(status)
            if not isinstance(values, list):
                continue
            for value in values:
                if unit := cls._impact_unit(value):
                    changes.append(
                        {
                            "status": status,
                            "before": unit if status == "removed" else None,
                            "after": unit if status == "added" else None,
                        }
                    )
        for status in ("changed", "moved"):
            values = diff.get(status)
            if not isinstance(values, list):
                continue
            for value in values:
                if not isinstance(value, dict):
                    continue
                before = cls._impact_unit(value.get("before"))
                after = cls._impact_unit(value.get("after"))
                if before is not None and after is not None:
                    changes.append({"status": status, "before": before, "after": after})
        order = {"changed": 0, "moved": 1, "added": 2, "removed": 3}
        return sorted(
            changes,
            key=lambda item: (
                order[item["status"]],
                (item["after"] or item["before"])["source_id"],
                (item["after"] or item["before"])["path"],
                (item["after"] or item["before"])["id"],
            ),
        )

    @staticmethod
    def _impact_unit(value: object) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        required = ("id", "source_id", "revision", "path", "kind")
        unit = {key: value.get(key) for key in required}
        if any(
            not isinstance(item, str) or not item or len(item) > MAX_DETAIL_TEXT
            for item in unit.values()
        ):
            return None
        digest = value.get("digest")
        label = value.get("label")
        if digest is not None:
            if not isinstance(digest, str):
                return None
            if re.fullmatch(r"[0-9a-f]{64}", digest):
                digest = f"sha256:{digest}"
            elif re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
                return None
        if label is not None and not isinstance(label, str):
            return None
        return {
            **unit,
            "digest": digest,
            "label": _bounded_text(label) if label else None,
        }

    @staticmethod
    def _string_set(value: object) -> set[str]:
        return (
            {item for item in value if isinstance(item, str)} if isinstance(value, list) else set()
        )

    @staticmethod
    def _add_impact_edge(
        edges: list[dict[str, str]], source: str, target: str, relation: str
    ) -> None:
        edges.append(
            {
                "id": f"{source}|{relation}|{target}",
                "source": source,
                "target": target,
                "relation": relation,
            }
        )

    @staticmethod
    def _replay_labels(
        connection: sqlite3.Connection,
        run_ids: tuple[str, ...],
        events: list[dict[str, Any]],
    ) -> dict[tuple[str, str], str]:
        placeholders = ",".join("?" for _ in run_ids)
        labels: dict[tuple[str, str], str] = {}
        for entity_type, table, column in (
            ("claim", "accepted_claims", "statement"),
            ("concept", "accepted_concepts", "canonical_name"),
        ):
            ids = sorted(
                {event["entity_id"] for event in events if event["entity_type"] == entity_type}
            )
            if not ids:
                continue
            id_placeholders = ",".join("?" for _ in ids)
            labels.update(
                {
                    (entity_type, row["id"]): _bounded_text(row[column])
                    for row in connection.execute(
                        f"""SELECT id, {column} FROM {table}
                            WHERE run_id IN ({placeholders})
                              AND id IN ({id_placeholders}) ORDER BY rowid""",
                        (*run_ids, *ids),
                    )
                }
            )
        return labels

    @staticmethod
    def _replay_event(
        row: sqlite3.Row, labels: dict[tuple[str, str], str]
    ) -> dict[str, Any] | None:
        try:
            details = json.loads(row["details"])
        except json.JSONDecodeError:
            return None
        entity_type = details.get("entity_type")
        entity_id = details.get("entity_id")
        state = row["state"]
        if entity_type is None and state == "published":
            entity_type = "production_run"
            entity_id = row["run_id"]
        if not isinstance(entity_type, str) or not isinstance(entity_id, str):
            return None
        if entity_type == "verification_candidate":
            if state == "staged":
                stage = "proposed"
            elif state == "rejected":
                stage = "rejected"
            elif state in {"accepted", "review_required", "revision_required"}:
                stage = "verified"
            else:
                return None
        elif entity_type in {"claim", "concept"}:
            stage = "stale" if state == "stale" else "accepted"
        elif entity_type == "production_run" and state == "published":
            stage = "published"
        else:
            return None
        candidate_id = details.get("candidate_id")
        return {
            "run_id": row["run_id"],
            "sequence": row["sequence"],
            "occurred_at": row["occurred_at"],
            "stage": stage,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "entity_label": _bounded_text(labels.get((entity_type, entity_id), entity_id)),
            "previous_state": row["previous_state"],
            "state": state,
            "candidate_id": candidate_id if isinstance(candidate_id, str) else None,
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
                obligation_id=obligation["id"],
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
