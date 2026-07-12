import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .accepted_knowledge import AcceptedKnowledgeStore, ClaimRecord, ConceptRecord
from .coverage import obligation_rows, summarize_obligations
from .impact_graph import KnowledgeImpactGraph, diff_source_units, plan_refresh


@dataclass(frozen=True)
class ClonePlan:
    base_run_id: str
    previous_units: dict[str, dict]
    current_units: dict[str, dict]
    relocations: dict[str, str]
    stale_claim_ids: set[str]
    stale_concept_ids: set[str]
    obligation_ids: dict[str, str]


@dataclass(frozen=True)
class PreparedRefresh:
    metadata: dict
    obligations: list[dict]
    clone: ClonePlan | None = None


def _empty_metadata() -> dict:
    return {
        "mode": "full",
        "fallback_reason": None,
        "new_source_units": [],
        "reverify_claims": [],
        "reverify_concepts": [],
        "rerender_pages": [],
        "relocations": {},
        "diff": {
            "added": [],
            "changed": [],
            "moved": [],
            "removed": [],
            "by_source": {},
        },
    }


def _reverification_obligations(
    *,
    base_run_id: str,
    sources: list[dict],
    current_units: dict[str, dict],
    claims: list[ClaimRecord],
    concepts: list[ConceptRecord],
    stale_claim_ids: set[str],
    stale_concept_ids: set[str],
) -> list[dict]:
    if not stale_claim_ids and not stale_concept_ids:
        return []
    units = sorted(
        current_units.values(),
        key=lambda item: (
            item["source_id"],
            item["source_unit_kind"] != "file",
            item["path"],
            item["source_unit"],
        ),
    )
    if not units:
        return []
    roles = {source["id"]: source["role"] for source in sources}
    claims_by_source: dict[str, set[str]] = {}
    for claim in claims:
        if claim["id"] not in stale_claim_ids:
            continue
        source_ids = {item["source_id"] for item in claim["evidence"]} or {units[0]["source_id"]}
        for source_id in source_ids:
            claims_by_source.setdefault(source_id, set()).add(claim["id"])
    if not claims_by_source:
        claims_by_source[units[0]["source_id"]] = set()
    obligations: list[dict] = []
    assigned_concepts: set[str] = set()
    for source_id, claim_ids in sorted(claims_by_source.items()):
        scope = next((item for item in units if item["source_id"] == source_id), units[0])
        concept_ids = {
            concept["id"]
            for concept in concepts
            if concept["id"] in stale_concept_ids
            and claim_ids
            & set(
                [
                    *concept["defining_claim_ids"],
                    *concept["supporting_claim_ids"],
                ]
            )
        }
        assigned_concepts.update(concept_ids)
        text = (
            "Reverify impacted Claims "
            + ", ".join(sorted(claim_ids))
            + " and Concepts "
            + ", ".join(sorted(concept_ids))
            + " after the Source Set changed."
        )
        identity = json.dumps(
            [base_run_id, scope["source_id"], sorted(claim_ids), sorted(concept_ids)],
            separators=(",", ":"),
        ).encode()
        span = scope.get("span", {"start_line": 1, "end_line": 1})
        obligations.append(
            {
                "id": f"obligation:{hashlib.sha256(identity).hexdigest()}",
                "source": scope["source_id"],
                "role": roles.get(scope["source_id"], "implementation"),
                "path": scope["path"],
                "source_unit": scope["source_unit"],
                "kind": "impact_reverification",
                "priority": "major",
                "disposition": "open",
                "reason": None,
                "span": span,
                "text": text,
                "reverify_claim_ids": sorted(claim_ids),
                "reverify_concept_ids": sorted(concept_ids),
            }
        )
    unassigned = stale_concept_ids - assigned_concepts
    if unassigned:
        existing = cast(list[str], obligations[0]["reverify_concept_ids"])
        obligations[0]["reverify_concept_ids"] = sorted({*existing, *unassigned})
        obligations[0]["text"] = (
            str(obligations[0]["text"])
            + " Additional Concepts: "
            + ", ".join(sorted(unassigned))
            + "."
        )
    return obligations


def _new_unit_obligations(
    *,
    added_unit_ids: set[str],
    sources: list[dict],
    current_units: dict[str, dict],
    existing: list[dict],
) -> list[dict]:
    roles = {source["id"]: source["role"] for source in sources}
    covered_units = {item["source_unit"] for item in existing}
    obligations = []
    for unit_id in sorted(added_unit_ids):
        unit = current_units[unit_id]
        if unit_id in covered_units:
            continue
        identity = json.dumps(
            [unit["source_id"], unit["revision"], unit_id, unit["source_unit_kind"]],
            separators=(",", ":"),
        ).encode()
        obligations.append(
            {
                "id": f"obligation:{hashlib.sha256(identity).hexdigest()}",
                "source": unit["source_id"],
                "role": roles.get(unit["source_id"], "implementation"),
                "path": unit["path"],
                "source_unit": unit["source_unit"],
                "kind": "new_source_unit",
                "priority": "supporting",
                "disposition": "open",
                "reason": None,
                "span": unit.get("span", {"start_line": 1, "end_line": 1}),
                "text": f"Review new Source Unit {unit['source_id']}/{unit['path']}.",
            }
        )
        covered_units.add(unit_id)
    return obligations


def prepare_refresh(
    connection: sqlite3.Connection,
    database: Path,
    *,
    base_run_id: str | None,
    project_id: str,
    profile_id: str,
    sources: list[dict],
    source_universe: list[dict],
    obligations: list[dict],
) -> PreparedRefresh:
    prepared_obligations = [dict(item) for item in obligations]
    if base_run_id is None:
        return PreparedRefresh(_empty_metadata(), prepared_obligations)
    base_row = connection.execute("SELECT * FROM runs WHERE id = ?", (base_run_id,)).fetchone()
    if base_row is None:
        metadata = _empty_metadata()
        metadata["fallback_reason"] = "Published run is missing"
        return PreparedRefresh(metadata, prepared_obligations)
    try:
        base_source_set = json.loads(base_row["source_set_json"])
        previous_universe = list(base_source_set.get("source_universe", []))
    except TypeError, json.JSONDecodeError:
        base_source_set = {}
        previous_universe = []
    current_units = {item["source_unit"]: item for item in source_universe}
    previous_units = {item["source_unit"]: item for item in previous_universe}
    diff = diff_source_units(previous_universe, source_universe)
    knowledge = AcceptedKnowledgeStore(database)
    claims = knowledge.list_claims(base_run_id)
    concepts = knowledge.list_concepts(base_run_id)
    graph = KnowledgeImpactGraph.from_records(
        source_units=previous_universe,
        evidence=[evidence for claim in claims for evidence in claim["evidence"]],
        claims=claims,
        concepts=concepts,
        pages=[
            {
                "concept_id": concept["id"],
                "path": knowledge.get_page_plan(base_run_id, concept["id"])["path"],
            }
            for concept in concepts
        ],
    )
    planned = plan_refresh(diff, graph)
    previous_sources = [
        {key: item[key] for key in ("id", "repository", "role")}
        for item in base_source_set.get("sources", [])
    ]
    current_sources = [{key: item[key] for key in ("id", "repository", "role")} for item in sources]
    fallback_reason = None
    if base_row["state"] != "published":
        fallback_reason = "Published Bundle does not name a published run"
    elif base_row["project_id"] != project_id or previous_sources != current_sources:
        fallback_reason = "Published Source Set is incompatible"
    elif base_source_set.get("producer_profile_id") != profile_id:
        fallback_reason = "Producer Profile changed"
    elif not previous_universe:
        fallback_reason = "Published run lacks impact metadata"
    elif diff.full_analysis:
        fallback_reason = diff.fallback_reason
    incremental = fallback_reason is None
    if incremental:
        stale_claim_ids = set(planned.reverify_claims)
        stale_concept_ids = set(planned.reverify_concepts)
        metadata = {**planned.as_dict(), "diff": diff.as_dict()}
    else:
        stale_claim_ids = {item["id"] for item in claims}
        stale_concept_ids = {item["id"] for item in concepts}
        metadata = {
            "mode": "full",
            "fallback_reason": fallback_reason,
            "new_source_units": sorted(item.id for item in diff.added),
            "reverify_claims": sorted(stale_claim_ids),
            "reverify_concepts": sorted(stale_concept_ids),
            "rerender_pages": sorted(
                knowledge.get_page_plan(base_run_id, concept["id"])["path"] for concept in concepts
            ),
            "relocations": dict(sorted(diff.relocations.items())),
            "diff": diff.as_dict(),
        }
    obligation_ids: dict[str, str] = {}
    if incremental:
        base_obligations = obligation_rows(connection, base_run_id)
        prior = {
            (diff.relocations.get(item["source_unit"]), item["kind"], item["text"]): item
            for item in base_obligations
            if item["source_unit"] in diff.relocations
        }
        for item in prepared_obligations:
            old = prior.get((item["source_unit"], item["kind"], item["text"]))
            if old:
                item["disposition"] = old["disposition"]
                item["reason"] = old["reason"]
                obligation_ids[old["id"]] = item["id"]
            elif item["disposition"] == "covered":
                item["disposition"] = "open"
                item["reason"] = None
    prepared_obligations.extend(
        _new_unit_obligations(
            added_unit_ids={item.id for item in diff.added},
            sources=sources,
            current_units=current_units,
            existing=prepared_obligations,
        )
    )
    prepared_obligations.extend(
        _reverification_obligations(
            base_run_id=base_run_id,
            sources=sources,
            current_units=current_units,
            claims=claims,
            concepts=concepts,
            stale_claim_ids=stale_claim_ids,
            stale_concept_ids=stale_concept_ids,
        )
    )
    prepared_obligations.sort(
        key=lambda item: (
            item["source"],
            item["path"],
            item["span"]["start_line"],
            item["kind"],
        )
    )
    return PreparedRefresh(
        metadata,
        prepared_obligations,
        ClonePlan(
            base_run_id,
            previous_units,
            current_units,
            diff.relocations,
            stale_claim_ids,
            stale_concept_ids,
            obligation_ids,
        ),
    )


def persist_inspection(
    connection: sqlite3.Connection,
    knowledge: AcceptedKnowledgeStore,
    *,
    run_id: str,
    bundle_revision: str,
    base_run_id: str | None,
    bundle_date: str,
    digest: str,
    evidence: list[dict],
    profile_id: str,
    source_universe: list[dict],
    sources: list[dict],
    prepared: PreparedRefresh,
    updated_at: str,
) -> tuple[list[dict], dict, dict]:
    row = connection.execute("SELECT source_set_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown Production Run: {run_id}")
    initial_source_set = json.loads(row["source_set_json"])
    standard = {
        "id",
        "source",
        "role",
        "path",
        "source_unit",
        "kind",
        "priority",
        "disposition",
        "reason",
        "span",
        "text",
    }
    connection.executemany(
        """INSERT INTO coverage_obligations
           (id, run_id, source, role, path, source_unit, kind, priority,
            disposition, reason, span, text, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                item["id"],
                run_id,
                item["source"],
                item["role"],
                item["path"],
                item["source_unit"],
                item["kind"],
                item["priority"],
                item["disposition"],
                item["reason"],
                json.dumps(item["span"], sort_keys=True),
                item["text"],
                json.dumps(
                    {key: value for key, value in item.items() if key not in standard},
                    sort_keys=True,
                ),
            )
            for item in prepared.obligations
        ],
    )
    obligations = obligation_rows(connection, run_id)
    coverage = summarize_obligations(obligations, sources)
    for source in sources:
        source["coverage"] = summarize_obligations(
            [item for item in obligations if item["source"] == source["id"]], [source]
        )
    source_set = {
        **initial_source_set,
        "base_run_id": base_run_id,
        "bundle_date": bundle_date,
        "digest": digest,
        "evidence": sorted(evidence, key=lambda item: (item["source_id"], item["path"])),
        "producer_profile_id": profile_id,
        "refresh": prepared.metadata,
        "source_universe": sorted(
            source_universe,
            key=lambda item: (
                item["source_id"],
                item["path"],
                item.get("span", {}).get("start_line", 0),
                item["source_unit_kind"],
            ),
        ),
        "sources": sources,
    }
    connection.execute(
        """UPDATE runs SET revision = ?, source_set_json = ?, coverage_json = ?, updated_at = ?
           WHERE id = ?""",
        (
            bundle_revision,
            json.dumps(source_set, sort_keys=True),
            json.dumps(coverage, sort_keys=True),
            updated_at,
            run_id,
        ),
    )
    if prepared.clone is not None:
        clone = prepared.clone
        knowledge.clone_for_refresh(
            connection,
            clone.base_run_id,
            run_id,
            previous_units=clone.previous_units,
            current_units=clone.current_units,
            relocations=clone.relocations,
            stale_claim_ids=clone.stale_claim_ids,
            stale_concept_ids=clone.stale_concept_ids,
            obligation_ids=clone.obligation_ids,
        )
        source_set["accepted_knowledge"] = knowledge.knowledge_summary(run_id, connection)
        connection.execute(
            "UPDATE runs SET source_set_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(source_set, sort_keys=True), updated_at, run_id),
        )
    return obligations, coverage, source_set
