import hashlib
import json
import os
import re
import shutil
import sqlite3
from datetime import UTC, datetime
from hmac import compare_digest
from pathlib import Path, PurePosixPath
from urllib.parse import unquote_to_bytes

from .accepted_knowledge import AcceptedKnowledgeStore
from .bundle import (
    authoritative_digest,
    bundle_diff,
    file_manifest,
    validate_bundle,
    verification_blockers,
    verification_findings,
)
from .coverage import obligation_rows, refresh_run_coverage
from .fault_injection import crash_if_requested
from .run_events import append_entity_event
from .run_state import RunTransitionError, transition_run
from .security import git_read_bytes


MAX_EVIDENCE_LINES = 200
MAX_REVIEW_TEXT_CHARS = 40_000


class ReviewError(ValueError):
    pass


class ReviewStaleError(ReviewError):
    def __init__(self, snapshot: dict) -> None:
        super().__init__("Review changed; refresh and decide against the new digest")
        self.snapshot = snapshot


def _run(database: Path, run_id: str) -> sqlite3.Row:
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise ReviewError(f"Unknown Production Run: {run_id}")
    return row


def _accepted_evidence(database: Path, run_ids: tuple[str, ...]) -> dict[str, tuple[dict, str]]:
    records: dict[str, tuple[dict, str]] = {}
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        for evidence_run_id in run_ids:
            for row in connection.execute(
                "SELECT * FROM accepted_evidence WHERE run_id = ? ORDER BY id",
                (evidence_run_id,),
            ):
                evidence = dict(row)
                evidence.pop("run_id")
                records.setdefault(evidence["id"], (evidence, evidence_run_id))
    return records


def _changes(database: Path, run_id: str, base_run_id: str | None) -> dict:
    store = AcceptedKnowledgeStore(database)
    current_claims = {item["id"]: item for item in store.list_claims(run_id)}
    previous_claims = (
        {item["id"]: item for item in store.list_claims(base_run_id)} if base_run_id else {}
    )
    current_concepts = {item["id"]: item for item in store.knowledge_summary(run_id)}
    previous_concepts = (
        {item["id"]: item for item in store.knowledge_summary(base_run_id)} if base_run_id else {}
    )

    claim_supersedes = {
        claim_id: set(item["supersedes"]) & previous_claims.keys()
        for claim_id, item in current_claims.items()
    }
    superseded_by: dict[str, set[str]] = {}
    for claim_id, targets in claim_supersedes.items():
        for target in targets:
            superseded_by.setdefault(target, set()).add(claim_id)
    merged_claims = {claim_id for claim_id, targets in claim_supersedes.items() if len(targets) > 1}
    split_claims = {
        claim_id
        for claim_id, targets in claim_supersedes.items()
        if any(len(superseded_by[target]) > 1 for target in targets)
    }

    current_defining = {
        concept_id: set(item["defining_claim_ids"]) for concept_id, item in current_concepts.items()
    }
    previous_defining = {
        concept_id: set(item["defining_claim_ids"])
        for concept_id, item in previous_concepts.items()
    }
    concept_overlaps = {
        concept_id: {
            previous_id
            for previous_id, defining in previous_defining.items()
            if current_defining[concept_id] & defining
        }
        for concept_id in current_concepts
    }
    overlapped_by: dict[str, set[str]] = {}
    for concept_id, previous_ids in concept_overlaps.items():
        for previous_id in previous_ids:
            overlapped_by.setdefault(previous_id, set()).add(concept_id)
    merged_concepts = {
        concept_id for concept_id, previous_ids in concept_overlaps.items() if len(previous_ids) > 1
    }
    split_concepts = {
        concept_id
        for concept_id, previous_ids in concept_overlaps.items()
        if any(len(overlapped_by[previous_id]) > 1 for previous_id in previous_ids)
    }

    excluded_obligations: set[str] = set()
    claim_obligations: dict[str, set[str]] = {}
    if base_run_id:
        with sqlite3.connect(database) as connection:
            excluded_obligations = {
                row[0]
                for row in connection.execute(
                    """SELECT id FROM coverage_obligations
                       WHERE run_id = ? AND disposition = 'excluded'""",
                    (run_id,),
                )
            }
            for obligation_id, claim_id in connection.execute(
                "SELECT obligation_id, claim_id FROM obligation_claims WHERE run_id = ?",
                (base_run_id,),
            ):
                claim_obligations.setdefault(claim_id, set()).add(obligation_id)
    excluded_claims = {
        claim_id
        for claim_id in previous_claims.keys() - current_claims.keys()
        if claim_obligations.get(claim_id) and claim_obligations[claim_id] <= excluded_obligations
    }
    excluded_concepts = {
        concept_id
        for concept_id in previous_concepts.keys() - current_concepts.keys()
        if previous_defining[concept_id] and previous_defining[concept_id] <= excluded_claims
    }

    def grouped(
        current: dict,
        previous: dict,
        status_key: str,
        merged: set[str],
        split: set[str],
        excluded: set[str],
    ) -> dict:
        groups = {
            bucket: []
            for bucket in (
                "added",
                "changed",
                "removed",
                "stale",
                "disputed",
                "merged",
                "split",
                "excluded",
            )
        }
        for item_id in sorted(current):
            item = current[item_id]
            status = item[status_key]
            bucket = (
                "disputed"
                if status == "disputed"
                else "stale"
                if status == "stale"
                else "merged"
                if item_id in merged
                else "split"
                if item_id in split
                else "added"
                if item_id not in previous
                else "changed"
                if item != previous[item_id]
                else None
            )
            if bucket is not None:
                groups[bucket].append(item)
        for item_id in sorted(previous.keys() - current.keys()):
            item = previous[item_id]
            status = item[status_key]
            bucket = (
                "disputed"
                if status == "disputed"
                else "stale"
                if status == "stale"
                else "excluded"
                if item_id in excluded
                else "removed"
            )
            groups[bucket].append(item)
        return groups

    return {
        "claims": grouped(
            current_claims,
            previous_claims,
            "epistemic_status",
            merged_claims,
            split_claims,
            excluded_claims,
        ),
        "concepts": grouped(
            current_concepts,
            previous_concepts,
            "status",
            merged_concepts,
            split_concepts,
            excluded_concepts,
        ),
    }


def review_snapshot(database: Path, run_id: str) -> dict:
    row = _run(database, run_id)
    if row["state"] != "review_required":
        raise ReviewError(f"Run {run_id} is not Review Required")
    source_set = json.loads(row["source_set_json"] or "{}")
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        obligations = obligation_rows(connection, run_id)
    changes = _changes(database, run_id, source_set.get("base_run_id"))
    evidence_records = _accepted_evidence(
        database, tuple(filter(None, (run_id, source_set.get("base_run_id"))))
    )
    evidence = {evidence_id: record[0] for evidence_id, record in evidence_records.items()}
    findings = verification_findings(database, run_id)
    with sqlite3.connect(database) as connection:
        proposals = {
            row[0]: json.loads(row[1]).get("evidence", [])
            for row in connection.execute(
                "SELECT candidate_id, proposal_json FROM verification_candidates WHERE run_id = ?",
                (run_id,),
            )
        }
    for finding in findings:
        references = []
        for recorded_id in finding.get("evidence", []):
            if recorded_id in evidence:
                references.append(recorded_id)
                continue
            proposal = next(
                (
                    item
                    for item in proposals.get(finding["candidate_id"], [])
                    if item.get("id") == recorded_id
                ),
                None,
            )
            if proposal is None:
                continue
            match = next(
                (
                    item["id"]
                    for item in evidence.values()
                    if item["source_id"] == proposal.get("source_id")
                    and item["revision"].casefold() == str(proposal.get("revision", "")).casefold()
                    and item["path"] == proposal.get("path")
                    and item["start_line"] == proposal.get("start_line")
                    and item["end_line"] == proposal.get("end_line")
                    and item["digest"] == proposal.get("digest")
                ),
                None,
            )
            if match is not None:
                references.append(match)
        finding["evidence_reference_ids"] = list(dict.fromkeys(references))
    return {
        "authoritative_digest": authoritative_digest(database, run_id, obligations),
        "base_run_id": source_set.get("base_run_id"),
        "bundle_diff": bundle_diff(Path(row["staging_dir"]), Path(row["publish_dir"])),
        "coverage": json.loads(row["coverage_json"] or "{}"),
        "coverage_obligations": obligations,
        "evidence_references": [evidence[item] for item in sorted(evidence)],
        "knowledge_changes": changes,
        "project_id": row["project_id"],
        "run_id": run_id,
        "source_set_digest": source_set.get("digest"),
        "state": row["state"],
        "verification_findings": findings,
    }


def evidence_excerpt(database: Path, run_id: str, evidence_id: str) -> dict:
    row = _run(database, run_id)
    source_set = json.loads(row["source_set_json"] or "{}")
    evidence_records = _accepted_evidence(
        database, tuple(filter(None, (run_id, source_set.get("base_run_id"))))
    )
    record = evidence_records.get(evidence_id)
    if record is None:
        raise ReviewError(f"Unknown Evidence Reference: {evidence_id}")
    evidence, evidence_run_id = record
    source_set = json.loads(_run(database, evidence_run_id)["source_set_json"] or "{}")
    source = next(
        (
            item
            for item in source_set.get("sources", [])
            if item["id"] == evidence["source_id"]
            and item["revision"].casefold() == evidence["revision"].casefold()
        ),
        None,
    )
    if source is None:
        raise ReviewError("Evidence Reference is outside the fixed Source Set")
    try:
        content = git_read_bytes(
            Path(source["repository"]),
            "show",
            f"{evidence['revision']}:{os.fsdecode(unquote_to_bytes(evidence['path']))}",
        ).decode("utf-8")
    except (OSError, UnicodeError, ValueError) as error:
        raise ReviewError(f"Evidence Reference cannot be resolved: {error}") from error
    lines = content.splitlines()
    requested_start = evidence["start_line"]
    requested_end = evidence["end_line"]
    if requested_start < 1 or requested_end < requested_start or requested_end > len(lines):
        raise ReviewError("Evidence Reference span is outside the fixed Source Snapshot")
    full_text = "\n".join(lines[requested_start - 1 : requested_end])
    if f"sha256:{hashlib.sha256(full_text.encode()).hexdigest()}" != evidence["digest"]:
        raise ReviewError("Evidence Reference digest does not match the fixed Source Snapshot")
    visible = lines[
        requested_start - 1 : min(requested_end, requested_start + MAX_EVIDENCE_LINES - 1)
    ]
    text = "\n".join(visible)
    truncated = (
        len(visible) < requested_end - requested_start + 1 or len(text) > MAX_REVIEW_TEXT_CHARS
    )
    text = text[:MAX_REVIEW_TEXT_CHARS]
    return {
        **evidence,
        "end_line": requested_start + len(visible) - 1,
        "requested_end_line": requested_end,
        "text": text,
        "truncated": truncated,
    }


def bundle_file_detail(database: Path, run_id: str, path: str) -> dict:
    row = _run(database, run_id)
    relative = PurePosixPath(path)
    if not path or relative.is_absolute() or ".." in relative.parts or relative.as_posix() != path:
        raise ReviewError("Bundle path must be a canonical relative path")
    staging = Path(row["staging_dir"])
    published = Path(row["publish_dir"])
    diff = bundle_diff(staging, published)
    status = next((name for name, paths in diff.items() if path in paths), None)
    if status is None:
        raise ReviewError("Bundle path is not part of the staged-versus-published diff")

    def read(root: Path) -> str | None:
        target = root / Path(*relative.parts)
        if not target.is_file():
            return None
        text = target.read_text(encoding="utf-8")
        return text[:MAX_REVIEW_TEXT_CHARS]

    return {
        "path": path,
        "published": read(published),
        "staged": read(staging),
        "status": status,
    }


def validation_errors(
    database: Path,
    row: sqlite3.Row,
    source_set: dict,
    obligations: list[dict] | None = None,
) -> list[str]:
    if obligations is None:
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            obligations = obligation_rows(connection, row["id"])
    coverage = json.loads(row["coverage_json"] or "null")
    staging = Path(row["staging_dir"])
    errors = validate_bundle(staging, row["revision"], coverage)
    expected_manifest = source_set.get("bundle_manifest")
    if expected_manifest is not None and file_manifest(staging) != expected_manifest:
        errors.append("Staged Bundle differs from the authoritative rendering")
    expected_digest = source_set.get("authoritative_digest")
    if (
        expected_digest is not None
        and authoritative_digest(database, row["id"], obligations) != expected_digest
    ):
        errors.append("Authoritative knowledge changed after the Bundle was rendered")
    return errors


def publish(staging: Path, destination: Path, run_id: str) -> str | None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(destination) and not destination.is_symlink():
        raise ReviewError("Published Bundle path must be absent or a producer-managed symlink")
    previous_target = os.readlink(destination) if destination.is_symlink() else None
    releases = destination.parent / f".{destination.name}.releases"
    releases.mkdir(exist_ok=True)
    final_release = releases / run_id
    temporary_release = releases / f".{run_id}.tmp"
    temporary_link = destination.parent / f".{destination.name}.{run_id}.tmp"
    shutil.rmtree(temporary_release, ignore_errors=True)
    temporary_link.unlink(missing_ok=True)
    try:
        if final_release.exists():
            if file_manifest(final_release) != file_manifest(staging):
                raise ReviewError("Existing release differs from the staged Bundle")
        else:
            shutil.copytree(staging, temporary_release)
            os.replace(temporary_release, final_release)
        os.symlink(
            os.path.relpath(final_release, destination.parent),
            temporary_link,
            target_is_directory=True,
        )
        os.replace(temporary_link, destination)
    finally:
        shutil.rmtree(temporary_release, ignore_errors=True)
        temporary_link.unlink(missing_ok=True)
    return previous_target


def restore_publication(destination: Path, previous_target: str | None, run_id: str) -> None:
    temporary = destination.parent / f".{destination.name}.{run_id}.rollback"
    temporary.unlink(missing_ok=True)
    try:
        if previous_target is None:
            destination.unlink(missing_ok=True)
        else:
            os.symlink(previous_target, temporary, target_is_directory=True)
            os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def previous_publication_target(row: sqlite3.Row, source_set: dict) -> str | None:
    base_run_id = source_set.get("base_run_id")
    if not base_run_id:
        return None
    destination = Path(row["publish_dir"])
    return os.path.relpath(
        destination.parent / f".{destination.name}.releases" / base_run_id,
        destination.parent,
    )


def complete_publication(connection: sqlite3.Connection, row: sqlite3.Row) -> None:
    run_id = row["id"]
    destination = Path(row["publish_dir"])
    source_set = json.loads(row["source_set_json"])
    previous_target = previous_publication_target(row, source_set)
    failure: Exception | None = None
    try:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT state FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            if current is None or current["state"] != "publishing":
                raise ReviewError(f"Run {run_id} is not in publishing")
            connection.execute("SAVEPOINT publication")
            try:
                publish(Path(row["staging_dir"]), destination, run_id)
                crash_if_requested("after_publication")
                transition_run(connection, run_id, "publishing", "published")
            except Exception as error:
                connection.execute("ROLLBACK TO publication")
                connection.execute("RELEASE publication")
                try:
                    restore_publication(destination, previous_target, run_id)
                except Exception as rollback_error:
                    error = ReviewError(f"{error}; publication rollback failed: {rollback_error}")
                transition_run(connection, run_id, "publishing", "failed", error=str(error))
                failure = error
            else:
                connection.execute("RELEASE publication")
    except RunTransitionError as error:
        raise ReviewError(str(error)) from error
    if failure is not None:
        raise ReviewError(str(failure)) from failure


def decide_review(database: Path, run_id: str, decision: str, expected_digest: str) -> dict:
    if decision not in {"approve", "reject"}:
        raise ReviewError("Review decision must be approve or reject")
    if (
        not isinstance(expected_digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_digest) is None
    ):
        raise ReviewError("expected_digest must be the authoritative 64-character digest")
    snapshot = review_snapshot(database, run_id)
    if not compare_digest(expected_digest, snapshot["authoritative_digest"]):
        raise ReviewStaleError(snapshot)
    row = _run(database, run_id)
    source_set = json.loads(row["source_set_json"] or "{}")
    knowledge = AcceptedKnowledgeStore(database)
    if decision == "reject":
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            with connection:
                transition_run(
                    connection,
                    run_id,
                    "review_required",
                    "exploring",
                    details={"decision": "rejected", "expected_digest": expected_digest},
                )
                reopened = list(
                    connection.execute(
                        """SELECT id, disposition FROM coverage_obligations
                           WHERE run_id = ? AND disposition IN ('covered', 'excluded', 'deferred')
                           ORDER BY id""",
                        (run_id,),
                    )
                )
                connection.execute(
                    """UPDATE coverage_obligations SET disposition = 'open', reason = NULL
                       WHERE run_id = ? AND disposition IN ('covered', 'excluded', 'deferred')""",
                    (run_id,),
                )
                for obligation_id, previous in reopened:
                    append_entity_event(
                        connection,
                        run_id,
                        "coverage_obligation",
                        obligation_id,
                        previous,
                        "open",
                    )
                knowledge.reject_run(connection, run_id)
                source_set["accepted_knowledge"] = []
                connection.execute(
                    "UPDATE runs SET source_set_json = ?, updated_at = ? WHERE id = ?",
                    (
                        json.dumps(source_set, sort_keys=True),
                        datetime.now(UTC).isoformat(),
                        run_id,
                    ),
                )
                refresh_run_coverage(connection, run_id)
        return {"decision": "rejected", "run_id": run_id, "state": "exploring"}

    blockers = verification_blockers(database, run_id)
    approval_details = {
        "decision": "approved",
        "expected_digest": expected_digest,
        "resolved_findings": blockers,
    }
    errors = validation_errors(database, row, source_set)
    if errors:
        with sqlite3.connect(database) as connection, connection:
            transition_run(
                connection,
                run_id,
                "review_required",
                "failed",
                error="; ".join(errors),
                details=approval_details,
            )
        return {"errors": errors, "run_id": run_id, "state": "failed"}
    with sqlite3.connect(database) as connection, connection:
        transition_run(
            connection,
            run_id,
            "review_required",
            "publishing",
            details=approval_details,
        )
    crash_if_requested("before_publication")
    try:
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            complete_publication(connection, row)
    except Exception as error:
        return {"errors": [str(error)], "run_id": run_id, "state": "failed"}
    return {"decision": "approved", "run_id": run_id, "state": "published"}
