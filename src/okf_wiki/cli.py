import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tomllib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote_from_bytes

from .accepted_knowledge import AcceptedKnowledgeStore
from .bundle import (
    authoritative_digest,
    file_manifest,
    published_run_id,
    render_bundle,
    review_status,
    validate_bundle,
    verification_blockers,
)
from .coverage import (
    DISPOSITIONS,
    major_blockers,
    obligation_rows,
    refresh_run_coverage,
)
from .gateway_common import GatewayError
from .gateway_profiles import GatewayApplication
from .fault_injection import crash_if_requested
from .java_analysis import (
    DEFAULT_JAVA_EXCLUDED_PATHS,
    JAVA_DEFAULT_PRIORITIES,
    JAVA_OBLIGATION_KINDS,
    accept_data_contracts,
    aggregate_data_contracts,
    analyze_java_source,
    is_java_input,
)
from .refresh import persist_inspection, prepare_refresh
from .run_events import append_entity_event, append_run_event
from .run_state import RunTransitionError, transition_run
from .security import MAX_ANALYZABLE_FILE_BYTES, git_read, git_read_bytes
from .source_identity import source_unit_id, stable_span_id
from .state_schema import migrate_state
from .workspace import WorkspaceApplication, WorkspaceError


TERMINAL_STATES = {"published", "failed", "cancelled"}
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
SETEXT_RE = re.compile(r"^\s*(=+|-+)\s*$")
NUMBERED_REQUIREMENT_RE = re.compile(
    r"^\s*(?:[-*+]\s+)?(?:REQ(?:UIREMENT)?[- _]?\d+[:.]?|\d+[.)])\s+.+$",
    re.IGNORECASE,
)
NORMATIVE_RE = re.compile(r"\b(?:MUST|SHALL|SHOULD|MAY)(?: NOT)?\b", re.IGNORECASE)
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+).+$")
GLOSSARY_RE = re.compile(r"^\s*(?:[-*+]\s+)?[^:#\n][^:\n]{0,100}:\s+.+$")
OBLIGATION_KINDS = JAVA_OBLIGATION_KINDS | {
    "acceptance_criterion",
    "glossary_definition",
    "normative_statement",
    "numbered_requirement",
    "table",
}
DEFAULT_PRIORITIES = {
    "acceptance_criterion": "major",
    "glossary_definition": "major",
    "normative_statement": "major",
    "numbered_requirement": "major",
    "table": "supporting",
    **JAVA_DEFAULT_PRIORITIES,
}
DEFAULT_DISPOSITIONS = {
    "major": {"disposition": "covered", "reason": None},
    "supporting": {"disposition": "covered", "reason": None},
}


class UserError(Exception):
    pass


def now() -> str:
    return datetime.now(UTC).isoformat()


def emit(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True))


def state_dir() -> Path:
    return Path.cwd() / ".okf-wiki"


def db_path() -> Path:
    return state_dir() / "runs.db"


def connect(read_only: bool = False) -> sqlite3.Connection:
    database = db_path()
    if read_only:
        if not database.is_file():
            raise UserError("Production Run ledger does not exist")
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    else:
        state_dir().mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    migrate_state(connection)


def create_run(
    connection: sqlite3.Connection,
    run_id: str,
    project_id: str,
    repository: Path,
    revision: str,
    publish_dir: Path,
    staging_dir: Path,
    source_set: dict,
) -> None:
    timestamp = now()
    with connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)""",
            (
                run_id,
                project_id,
                str(repository),
                revision,
                str(publish_dir),
                str(staging_dir),
                json.dumps(source_set, sort_keys=True),
                timestamp,
                timestamp,
            ),
        )
        append_run_event(connection, run_id, None, "preparing")


def transition(
    connection: sqlite3.Connection,
    run_id: str,
    previous_state: str,
    next_state: str,
    *,
    coverage: dict | None = None,
    error: str | None = None,
    details: dict | None = None,
) -> None:
    try:
        with connection:
            transition_run(
                connection,
                run_id,
                previous_state,
                next_state,
                coverage=coverage,
                error=error,
                details=details,
            )
    except RunTransitionError as transition_error:
        raise UserError(str(transition_error)) from transition_error


def get_run(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise UserError(f"Unknown Production Run: {run_id}")
    return row


def git_bytes(repository: Path, *arguments: str) -> bytes:
    try:
        return git_read_bytes(repository, *arguments)
    except ValueError as error:
        raise UserError(str(error)) from error


def git(repository: Path, *arguments: str) -> str:
    try:
        return git_read(repository, *arguments)
    except ValueError as error:
        raise UserError(str(error)) from error


def is_table_separator(line: str) -> bool:
    cells = line.strip().strip("|").split("|")
    return "|" in line and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def markdown_inventory(
    source: dict,
    revision: str,
    path: str,
    text: str,
    file_unit: str,
    profile: dict,
) -> tuple[list[dict], list[dict]]:
    lines = text.splitlines()
    headings = []
    code_lines = set()
    setext_lines = set()
    fence = None
    for index, line in enumerate(lines):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker.group(1)[0]
            if fence is None:
                fence = token
            elif fence == token:
                fence = None
            code_lines.add(index)
            continue
        if fence is not None:
            code_lines.add(index)
            continue
        match = HEADING_RE.fullmatch(line)
        if match:
            headings.append((index, len(match.group(1)), match.group(2)))
    for index in range(len(lines) - 1):
        marker = SETEXT_RE.fullmatch(lines[index + 1])
        if (
            marker
            and index not in code_lines
            and index + 1 not in code_lines
            and lines[index].strip()
            and not HEADING_RE.fullmatch(lines[index])
        ):
            headings.append((index, 1 if marker.group(1)[0] == "=" else 2, lines[index].strip()))
            setext_lines.update((index, index + 1))
    headings.sort()

    sections: list[dict] = []
    for position, (start, level, heading) in enumerate(headings):
        end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
        section_text = "\n".join(lines[start:end])
        sections.append(
            {
                "content_digest": hashlib.sha256(section_text.encode()).hexdigest(),
                "heading": heading,
                "level": level,
                "path": path,
                "revision": revision,
                "source_id": source["id"],
                "source_unit": stable_span_id(
                    "section",
                    source["id"],
                    revision,
                    path,
                    "markdown_section",
                    start + 1,
                    end,
                    section_text,
                ),
                "source_unit_kind": "markdown_section",
                "span": {"end_line": end, "start_line": start + 1},
            }
        )

    def section_for(index: int) -> dict | None:
        return next(
            (
                section
                for section in reversed(sections)
                if section["span"]["start_line"] <= index + 1 <= section["span"]["end_line"]
            ),
            None,
        )

    table_ranges = []
    index = 1
    while index < len(lines):
        if index not in code_lines and "|" in lines[index - 1] and is_table_separator(lines[index]):
            end = index + 1
            while end < len(lines) and end not in code_lines and "|" in lines[end]:
                end += 1
            table_ranges.append((index - 1, end))
            index = end
        else:
            index += 1
    table_lines = {line for start, end in table_ranges for line in range(start, end)}

    obligations = []

    def add(kind: str, start: int, end: int, obligation_text: str) -> None:
        section = section_for(start)
        priority = profile["priorities"][kind]
        disposition = profile["dispositions"][priority]
        obligations.append(
            {
                "disposition": disposition["disposition"],
                "id": stable_span_id(
                    "obligation",
                    source["id"],
                    revision,
                    path,
                    kind,
                    start + 1,
                    end,
                    obligation_text,
                ),
                "kind": kind,
                "path": path,
                "priority": priority,
                "reason": disposition["reason"],
                "role": source["role"],
                "source": source["id"],
                "source_unit": section["source_unit"] if section else file_unit,
                "span": {"end_line": end, "start_line": start + 1},
                "text": obligation_text,
            }
        )

    for start, end in table_ranges:
        add("table", start, end, "\n".join(lines[start:end]))
    for index, line in enumerate(lines):
        if (
            index in code_lines
            or index in table_lines
            or index in setext_lines
            or not line.strip()
            or HEADING_RE.fullmatch(line)
        ):
            continue
        section = section_for(index)
        heading = section["heading"].casefold() if section else ""
        if NUMBERED_REQUIREMENT_RE.fullmatch(line):
            add("numbered_requirement", index, index + 1, line)
        if NORMATIVE_RE.search(line):
            add("normative_statement", index, index + 1, line)
        if "acceptance criter" in heading and LIST_ITEM_RE.fullmatch(line):
            add("acceptance_criterion", index, index + 1, line)
        if "glossary" in heading and GLOSSARY_RE.fullmatch(line):
            add("glossary_definition", index, index + 1, line)
    return sections, obligations


def inspect_source(
    source: dict, profile: dict
) -> tuple[dict, list[dict], list[dict], list[dict], str]:
    repository = Path(source["repository"])
    requested_revision = source["revision"]
    if not repository.is_dir():
        raise UserError(f"Repository does not exist: {repository}")
    if re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", requested_revision) is None:
        raise UserError("Revision must be a full Git commit ID")
    revision = git(repository, "rev-parse", "--verify", f"{requested_revision}^{{commit}}").strip()
    if revision.lower() != requested_revision.lower():
        raise UserError("Revision does not resolve to the exact requested commit")
    tree = git_bytes(repository, "ls-tree", "-r", "--full-tree", "-z", revision)
    snapshot = {**source, "digest": hashlib.sha256(tree).hexdigest(), "revision": revision}
    universe = []
    evidence = []
    obligations = []
    java_facts: dict[str, dict] = {}
    for record in tree.split(b"\0"):
        if not record:
            continue
        metadata, path_bytes = record.split(b"\t", 1)
        _mode, object_type, object_id = metadata.split(b" ", 2)
        path = quote_from_bytes(path_bytes, safe="/")
        unit_id = source_unit_id(source["id"], revision, path)
        file_unit = {
            "content_digest": object_id.decode(),
            "path": path,
            "revision": revision,
            "source_id": source["id"],
            "source_unit": unit_id,
            "source_unit_kind": "file",
        }
        universe.append(file_unit)
        if object_type != b"blob":
            continue
        is_markdown = path_bytes.lower().endswith(b".md")
        is_java = is_java_input(path)
        if not (is_markdown or is_java):
            continue
        if int(git(repository, "cat-file", "-s", object_id.decode())) > MAX_ANALYZABLE_FILE_BYTES:
            raise UserError(
                f"Tracked analyzable file exceeds the static-analysis size limit: {path}"
            )
        content = git_bytes(repository, "cat-file", "blob", object_id.decode())
        file_unit["content_digest"] = hashlib.sha256(content).hexdigest()
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as error:
            kind = "Markdown" if is_markdown else "Java source"
            raise UserError(f"Tracked {kind} is not UTF-8: {path}") from error
        evidence.append(
            {
                "content_digest": hashlib.sha256(content).hexdigest(),
                "path": path,
                "revision": revision,
                "source_id": source["id"],
                "source_unit": unit_id,
                "source_unit_kind": "file",
                "span": {"end_line": max(1, len(text.splitlines())), "start_line": 1},
            }
        )
        if is_markdown:
            sections, markdown_obligations = markdown_inventory(
                source, revision, path, text, unit_id, profile
            )
            universe.extend(sections)
            obligations.extend(markdown_obligations)
        else:
            java_units, java_obligations, facts = analyze_java_source(
                source, revision, path, text, profile
            )
            universe.extend(java_units)
            obligations.extend(java_obligations)
            java_facts.update(facts)
    contract_units, contract_obligations = aggregate_data_contracts(
        source, revision, java_facts, profile
    )
    universe.extend(contract_units)
    obligations.extend(contract_obligations)
    commit_date = git(repository, "show", "-s", "--format=%cs", revision).strip()
    return snapshot, universe, evidence, obligations, commit_date


def load_profile(config: dict) -> dict:
    raw = config.get("profile", {})
    if not isinstance(raw, dict):
        raise UserError("Producer Profile must be a table")
    unknown = sorted(set(raw) - {"dispositions", "java_excluded_paths", "priorities"})
    if unknown:
        raise UserError(f"Unknown Producer Profile fields: {', '.join(unknown)}")

    priorities = dict(DEFAULT_PRIORITIES)
    raw_priorities = raw.get("priorities", {})
    if not isinstance(raw_priorities, dict):
        raise UserError("Producer Profile priorities must be a table")
    for kind, priority in raw_priorities.items():
        if kind not in OBLIGATION_KINDS:
            raise UserError(f"Unknown Coverage Obligation kind: {kind}")
        if not isinstance(priority, str) or priority.casefold() not in DEFAULT_DISPOSITIONS:
            raise UserError(f"Producer Profile priority for {kind} must be major or supporting")
        priorities[kind] = priority.casefold()

    java_excluded_paths = raw.get("java_excluded_paths", DEFAULT_JAVA_EXCLUDED_PATHS)
    if (
        not isinstance(java_excluded_paths, list | tuple)
        or not java_excluded_paths
        or any(not isinstance(rule, str) or not rule.strip() for rule in java_excluded_paths)
    ):
        raise UserError("Producer Profile java_excluded_paths must be a non-empty string array")
    for rule in java_excluded_paths:
        if rule.startswith("/") or ".." in Path(rule).parts:
            raise UserError("Producer Profile java_excluded_paths rules must stay relative")

    dispositions = {priority: dict(value) for priority, value in DEFAULT_DISPOSITIONS.items()}
    raw_dispositions = raw.get("dispositions", {})
    if not isinstance(raw_dispositions, dict):
        raise UserError("Producer Profile dispositions must be a table")
    for priority, settings in raw_dispositions.items():
        if priority not in dispositions or not isinstance(settings, dict):
            raise UserError("Producer Profile dispositions must define major or supporting tables")
        unknown = sorted(set(settings) - {"disposition", "reason"})
        if unknown:
            raise UserError(f"Unknown {priority} disposition fields: {', '.join(unknown)}")
        dispositions[priority].update(settings)

    for priority, settings in dispositions.items():
        disposition = settings["disposition"]
        reason = settings["reason"]
        if not isinstance(disposition, str) or disposition.casefold() not in DISPOSITIONS:
            raise UserError(f"Invalid {priority} Coverage Obligation disposition")
        disposition = disposition.casefold()
        if reason is not None and not isinstance(reason, str):
            raise UserError("Coverage Obligation reason must be a string")
        reason = reason.strip() if isinstance(reason, str) else None
        if disposition in {"deferred", "excluded"} and not reason:
            raise UserError(
                f"{disposition.upper()} Coverage Obligations require a non-empty reason"
            )
        if disposition == "deferred" and priority != "supporting":
            raise UserError("DEFERRED is available only to Supporting Obligations")
        settings.update(disposition=disposition, reason=reason)
    return {
        "dispositions": dispositions,
        "java_excluded_paths": list(java_excluded_paths),
        "priorities": priorities,
        "priority_overrides": set(raw_priorities),
    }


def load_config(path_text: str) -> tuple[str, list[dict], Path, dict, dict | None]:
    path = Path(path_text).resolve()
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise UserError(f"Cannot read Producer Project config: {error}") from error
    if "schema_version" in config and path.name != "workspace.toml":
        raise UserError("Workspace configuration must be named workspace.toml")
    if "schema_version" in config:
        try:
            snapshot = WorkspaceApplication(path.parent).open()
        except WorkspaceError as error:
            raise UserError(str(error)) from error
        missing_checkouts = [source.id for source in snapshot.sources if source.checkout is None]
        if not snapshot.sources:
            raise UserError("Workspace has no configured Sources")
        if missing_checkouts:
            raise UserError(
                "Sources lack Local Workspace Settings checkout bindings: "
                + ", ".join(missing_checkouts)
            )
        workspace_configuration = snapshot.model_dump(mode="json")
        if snapshot.models.gateway_profile is not None:
            try:
                workspace_configuration["resolved_models"] = GatewayApplication().resolve_models(
                    snapshot.models,
                    allow_missing=True,
                )
            except GatewayError as error:
                raise UserError(str(error)) from error
        return (
            snapshot.project.id,
            [
                {
                    "id": source.id,
                    "repository": str(source.checkout),
                    "revision": source.revision,
                    "role": source.role,
                }
                for source in snapshot.sources
            ],
            snapshot.publication.path,
            load_profile({"profile": snapshot.profile.model_dump(exclude_none=True)}),
            workspace_configuration,
        )
    required = {"project_id", "publish_dir"}
    missing = sorted(required - config.keys())
    if missing:
        raise UserError(f"Missing config fields: {', '.join(missing)}")
    if any(not isinstance(config[key], str) or not config[key].strip() for key in required):
        raise UserError("Producer Project config fields must be non-empty strings")
    publish_dir = Path(config["publish_dir"])
    if not publish_dir.is_absolute():
        publish_dir = path.parent / publish_dir
    if "sources" not in config:
        source_required = {"repository", "revision"}
        source_missing = sorted(source_required - config.keys())
        if source_missing:
            raise UserError(f"Missing config fields: {', '.join(source_missing)}")
        raw_sources = [
            {
                "id": "source",
                "role": "implementation",
                "repository": config["repository"],
                "revision": config["revision"],
            }
        ]
    else:
        if "repository" in config or "revision" in config:
            raise UserError("Use either sources or repository/revision config fields")
        raw_sources = config["sources"]
        if not isinstance(raw_sources, list) or not raw_sources:
            raise UserError("Producer Project sources must be a non-empty array")
    sources = []
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            raise UserError("Each Producer Project source must be a table")
        source_required = {"id", "role", "repository", "revision"}
        source_missing = sorted(source_required - raw_source.keys())
        if source_missing:
            raise UserError(f"Missing source fields: {', '.join(source_missing)}")
        if any(
            not isinstance(raw_source[field], str) or not raw_source[field].strip()
            for field in source_required
        ):
            raise UserError("Producer Project source fields must be non-empty strings")
        repository = Path(raw_source["repository"])
        if not repository.is_absolute():
            repository = path.parent / repository
        sources.append(
            {
                "id": raw_source["id"],
                "repository": str(repository.resolve()),
                "revision": raw_source["revision"],
                "role": raw_source["role"],
            }
        )
    if len({source["id"] for source in sources}) != len(sources):
        raise UserError("Producer Project source IDs must be unique")
    return (
        config["project_id"],
        sorted(sources, key=lambda source: source["id"]),
        publish_dir.absolute(),
        load_profile(config),
        None,
    )


def source_set_digest(sources: list[dict]) -> str:
    identity = [
        {key: source.get(key) for key in ("digest", "id", "revision", "role")} for source in sources
    ]
    return hashlib.sha256(
        json.dumps(identity, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()


def producer_profile_id(profile: dict) -> str:
    resolved = {**profile, "priority_overrides": sorted(profile["priority_overrides"])}
    digest = hashlib.sha256(
        json.dumps(resolved, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return f"profile:{digest}"


def run_validation_errors(row: sqlite3.Row, source_set: dict, obligations: list[dict]) -> list[str]:
    coverage = json.loads(row["coverage_json"]) if row["coverage_json"] else None
    staging = Path(row["staging_dir"])
    errors = validate_bundle(staging, row["revision"], coverage)
    expected_manifest = source_set.get("bundle_manifest")
    if expected_manifest is not None and file_manifest(staging) != expected_manifest:
        errors.append("Staged Bundle differs from the authoritative rendering")
    expected_digest = source_set.get("authoritative_digest")
    if (
        expected_digest is not None
        and authoritative_digest(db_path(), row["id"], obligations) != expected_digest
    ):
        errors.append("Authoritative knowledge changed after the Bundle was rendered")
    return errors


def render_checkpoint(connection: sqlite3.Connection, row: sqlite3.Row) -> None:
    run_id = row["id"]
    source_set = json.loads(row["source_set_json"])
    obligations = obligation_rows(connection, run_id)
    coverage = json.loads(row["coverage_json"])
    accepted_knowledge = AcceptedKnowledgeStore(db_path()).knowledge_summary(run_id)
    source_set["accepted_knowledge"] = accepted_knowledge
    crash_if_requested("before_staging")
    review = render_bundle(
        Path(row["staging_dir"]),
        row["project_id"],
        row["revision"],
        source_set["sources"],
        source_set["evidence"],
        obligations,
        coverage,
        source_set["bundle_date"],
        accepted_knowledge,
        db_path(),
        run_id,
        source_set.get("base_run_id"),
        Path(row["publish_dir"]),
    )
    crash_if_requested("after_staging")
    crash_if_requested("before_review")
    source_set["authoritative_digest"] = authoritative_digest(db_path(), run_id, obligations)
    source_set["bundle_manifest"] = file_manifest(Path(row["staging_dir"]))
    source_set["review"] = review
    with connection:
        connection.execute(
            "UPDATE runs SET source_set_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(source_set, sort_keys=True), now(), run_id),
        )
    crash_if_requested("after_review")


def advance_rendering(
    connection: sqlite3.Connection, run_id: str, *, rerender_checking: bool = False
) -> str:
    row = get_run(connection, run_id)
    state = row["state"]
    if state == "verifying":
        source_set = json.loads(row["source_set_json"])
        accept_data_contracts(
            db_path(), run_id, source_set["source_universe"], obligation_rows(connection, run_id)
        )
        transition(
            connection,
            run_id,
            "verifying",
            "rendering",
            coverage=json.loads(row["coverage_json"]),
        )
        state = "rendering"
    if state == "rendering":
        render_checkpoint(connection, get_run(connection, run_id))
        transition(connection, run_id, "rendering", "checking")
        state = "checking"
    elif state == "checking" and rerender_checking:
        render_checkpoint(connection, get_run(connection, run_id))
    if state != "checking":
        raise UserError(f"Run {run_id} is not ready to render")
    current = get_run(connection, run_id)
    source_set = json.loads(current["source_set_json"])
    errors = run_validation_errors(current, source_set, obligation_rows(connection, run_id))
    if errors:
        raise UserError("; ".join(errors))
    transition(connection, run_id, "checking", "review_required")
    return "review_required"


def finish_run(run_id: str) -> None:
    connection = connect()
    try:
        advance_rendering(connection, run_id)
    except Exception as error:
        current = get_run(connection, run_id)["state"]
        if current != "failed":
            transition(connection, run_id, current, "failed", error=str(error))
        raise
    finally:
        connection.close()


def inspect_run(connection: sqlite3.Connection, run_id: str, profile: dict) -> tuple[dict, dict]:
    row = get_run(connection, run_id)
    initial = json.loads(row["source_set_json"])
    configured_sources = initial["sources"]
    profile_id = initial["producer_profile_id"]
    sources = []
    source_universe = []
    evidence = []
    obligations = []
    commit_dates = []
    for configured_source in configured_sources:
        try:
            source, source_files, source_evidence, source_obligations, commit_date = inspect_source(
                configured_source, profile
            )
        except UserError as error:
            raise UserError(f"Source {configured_source['id']}: {error}") from error
        sources.append(source)
        source_universe.extend(source_files)
        evidence.extend(source_evidence)
        obligations.extend(source_obligations)
        commit_dates.append(commit_date)
    digest = source_set_digest(sources)
    prepared = prepare_refresh(
        connection,
        db_path(),
        base_run_id=initial.get("base_run_id"),
        project_id=row["project_id"],
        profile_id=profile_id,
        sources=sources,
        source_universe=source_universe,
        obligations=obligations,
    )
    with connection:
        _, coverage, source_set = persist_inspection(
            connection,
            AcceptedKnowledgeStore(db_path()),
            run_id=run_id,
            bundle_revision=sources[0]["revision"] if len(sources) == 1 else digest,
            base_run_id=initial.get("base_run_id"),
            bundle_date=max(commit_dates),
            digest=digest,
            evidence=evidence,
            profile_id=profile_id,
            source_universe=source_universe,
            sources=sources,
            prepared=prepared,
            updated_at=now(),
        )
    crash_if_requested("after_inspection")
    return coverage, source_set


def advance_preparation(
    connection: sqlite3.Connection, run_id: str, profile: dict | None = None
) -> tuple[str, dict]:
    row = get_run(connection, run_id)
    source_set = json.loads(row["source_set_json"])
    if "bundle_date" not in source_set:
        if profile is None:
            profile = source_set.get("profile")
            if profile is None:
                raise UserError("Preparing Run lacks its persisted Producer Profile")
            profile["priority_overrides"] = set(profile["priority_overrides"])
        coverage, source_set = inspect_run(connection, run_id, profile)
    else:
        coverage = json.loads(row["coverage_json"])
    if not source_set["evidence"]:
        raise UserError("Fixed Source Set contains no tracked Java or Markdown files")
    major = coverage.get("by_priority", {}).get("major", {}).get("dispositions", {})
    if major.get("blocked", 0) or major.get("failed", 0):
        transition(
            connection,
            run_id,
            "preparing",
            "failed",
            coverage=coverage,
            error="Major Coverage Obligations are blocked or failed",
        )
        return "failed", coverage
    transition(connection, run_id, "preparing", "exploring", coverage=coverage)
    if coverage.get("open", 0):
        return "exploring", coverage
    transition(connection, run_id, "exploring", "verifying", coverage=coverage)
    return "verifying", coverage


def build(config_path: str) -> int:
    project_id, configured_sources, publish_dir, profile, workspace_configuration = load_config(
        config_path
    )
    profile_id = producer_profile_id(profile)
    configured_digest = source_set_digest(configured_sources)
    provisional_revision = (
        configured_sources[0]["revision"] if len(configured_sources) == 1 else configured_digest
    )
    run_id = uuid.uuid4().hex
    staging = state_dir() / "runs" / run_id / "staging"
    base_run_id = published_run_id(publish_dir)
    connection = connect()
    initialize(connection)
    source_set = {
        "digest": configured_digest,
        "base_run_id": base_run_id,
        "evidence": [],
        "profile": {**profile, "priority_overrides": sorted(profile["priority_overrides"])},
        "producer_profile_id": profile_id,
        "source_universe": [],
        "sources": configured_sources,
    }
    if workspace_configuration is not None:
        source_set["workspace_configuration"] = workspace_configuration
    create_run(
        connection,
        run_id,
        project_id,
        Path(configured_sources[0]["repository"]),
        provisional_revision,
        publish_dir,
        staging,
        source_set,
    )
    crash_if_requested("after_run_created")
    try:
        state, coverage = advance_preparation(connection, run_id, profile)
        if state == "failed":
            error = "Major Coverage Obligations are blocked or failed"
            emit(
                {
                    "blocked": True,
                    "coverage": coverage,
                    "errors": [error],
                    "ok": False,
                    "run_id": run_id,
                    "state": "failed",
                }
            )
            return 1
        if state == "exploring":
            error = "Open Coverage Obligations require semantic analysis"
            emit(
                {
                    "blocked": True,
                    "coverage": coverage,
                    "errors": [error],
                    "ok": False,
                    "run_id": run_id,
                    "state": state,
                }
            )
            return 1
        finish_run(run_id)
    except Exception as error:
        current = get_run(connection, run_id)["state"]
        if current != "failed":
            transition(connection, run_id, current, "failed", error=str(error))
        emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    finally:
        connection.close()
    emit({"ok": True, "run_id": run_id, "state": "review_required"})
    return 0


def status(run_id: str) -> int:
    with connect(read_only=True) as connection:
        row = get_run(connection, run_id)
        events = [
            {
                "details": details,
                "occurred_at": event["occurred_at"],
                "previous_state": event["previous_state"],
                "sequence": event["sequence"],
                "state": event["state"],
            }
            for event in connection.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
            )
            if (details := json.loads(event["details"])).get("entity_type")
            not in {"coverage_obligation", "analysis_task"}
        ]
        has_obligations = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coverage_obligations'"
        ).fetchone()
        obligations = obligation_rows(connection, run_id) if has_obligations else []
    source_set_json = row["source_set_json"] if "source_set_json" in row.keys() else None
    source_set: dict
    if source_set_json:
        source_set = json.loads(source_set_json)
    else:
        legacy_source = {
            "id": "source",
            "repository": row["repository"],
            "revision": row["revision"],
            "role": "implementation",
        }
        source_set = {
            "digest": source_set_digest([legacy_source]),
            "evidence": [],
            "source_universe": [],
            "sources": [legacy_source],
        }
    coverage = json.loads(row["coverage_json"]) if row["coverage_json"] else None
    blocking_findings = run_validation_errors(row, source_set, obligations)
    from .scheduler import scheduler_status

    scheduler = scheduler_status(db_path(), run_id)
    actionable_errors = list(
        dict.fromkeys(
            error
            for error in [
                row["error"],
                *scheduler["errors"],
                *blocking_findings,
            ]
            if error
        )
    )
    payload = {
        "actionable_errors": actionable_errors,
        "base_run_id": source_set.get("base_run_id"),
        "blocked": bool(coverage and "total" in coverage and major_blockers(coverage)),
        "accepted_knowledge": source_set.get("accepted_knowledge", []),
        "budgets": scheduler["budgets"],
        "coverage": coverage,
        "evidence": source_set["evidence"],
        "error": row["error"],
        "events": events,
        "obligations": obligations,
        "ok": True,
        "phase": row["state"],
        "project_id": row["project_id"],
        "producer_profile_id": source_set.get("producer_profile_id"),
        "published_bundle": row["publish_dir"],
        "refresh": source_set.get(
            "refresh",
            {
                "mode": "full",
                "fallback_reason": "Run predates impact tracking",
                "diff": {
                    "added": [],
                    "changed": [],
                    "moved": [],
                    "removed": [],
                    "by_source": {},
                },
            },
        ),
        "review": review_status(
            row["state"],
            blocking_findings,
            source_set.get("review"),
            [] if row["state"] == "published" else verification_blockers(db_path(), run_id),
        ),
        "run_id": row["id"],
        "source_set_digest": source_set["digest"],
        "source_universe": source_set["source_universe"],
        "sources": source_set["sources"],
        "staging_bundle": row["staging_dir"],
        "state": row["state"],
        "tasks": scheduler["tasks"],
    }
    if len(source_set["sources"]) == 1:
        source = source_set["sources"][0]
        payload["source"] = {"repository": source["repository"], "revision": source["revision"]}
    emit(payload)
    return 0


def check(target: str) -> int:
    bundle = Path(target)
    if bundle.is_dir():
        errors = validate_bundle(bundle.resolve())
        review = review_status("published", errors)
    else:
        with connect(read_only=True) as connection:
            row = get_run(connection, target)
            has_obligations = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coverage_obligations'"
            ).fetchone()
            obligations = obligation_rows(connection, target) if has_obligations else []
        source_set_json = row["source_set_json"] if "source_set_json" in row.keys() else None
        source_set = json.loads(source_set_json) if source_set_json else {}
        errors = run_validation_errors(row, source_set, obligations)
        snapshot = source_set.get("review")
        review = review_status(
            row["state"],
            errors,
            snapshot,
            [] if row["state"] == "published" else verification_blockers(db_path(), target),
        )
    emit({"errors": errors, "ok": not errors, "review": review, "target": target})
    return bool(errors)


def publish(staging: Path, destination: Path, run_id: str) -> str | None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(destination) and not destination.is_symlink():
        raise UserError("Published Bundle path must be absent or a producer-managed symlink")
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
                raise UserError("Existing release differs from the staged Bundle")
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
    temporary_link = destination.parent / f".{destination.name}.{run_id}.rollback"
    temporary_link.unlink(missing_ok=True)
    try:
        if previous_target is None:
            destination.unlink(missing_ok=True)
        else:
            os.symlink(previous_target, temporary_link, target_is_directory=True)
            os.replace(temporary_link, destination)
    finally:
        temporary_link.unlink(missing_ok=True)


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
    try:
        publish(Path(row["staging_dir"]), destination, run_id)
        crash_if_requested("after_publication")
        transition(connection, run_id, "publishing", "published")
    except Exception as error:
        try:
            restore_publication(destination, previous_target, run_id)
        except Exception as rollback_error:
            error = UserError(f"{error}; publication rollback failed: {rollback_error}")
        transition(connection, run_id, "publishing", "failed", error=str(error))
        raise UserError(str(error)) from error


def review(run_id: str, approve: bool) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] != "review_required":
        connection.close()
        raise UserError(f"Run {run_id} is not Review Required")
    if not approve:
        knowledge = AcceptedKnowledgeStore(db_path())
        with connection:
            source_set = json.loads(row["source_set_json"]) if row["source_set_json"] else {}
            transition_run(
                connection,
                run_id,
                "review_required",
                "exploring",
                details={"decision": "rejected"},
            )
            reopened = [
                (item[0], item[1])
                for item in connection.execute(
                    """SELECT id, disposition FROM coverage_obligations
                       WHERE run_id = ?
                         AND disposition IN ('covered', 'excluded', 'deferred')
                       ORDER BY id""",
                    (run_id,),
                )
            ]
            connection.execute(
                """UPDATE coverage_obligations SET disposition = 'open', reason = NULL
                   WHERE run_id = ?
                     AND disposition IN ('covered', 'excluded', 'deferred')""",
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
                (json.dumps(source_set, sort_keys=True), now(), run_id),
            )
            refresh_run_coverage(connection, run_id)
        connection.close()
        emit({"decision": "rejected", "ok": True, "run_id": run_id, "state": "exploring"})
        return 0
    source_set = json.loads(row["source_set_json"]) if row["source_set_json"] else {}
    obligations = obligation_rows(connection, run_id)
    errors = run_validation_errors(row, source_set, obligations)
    if errors:
        transition(connection, run_id, "review_required", "failed", error="; ".join(errors))
        connection.close()
        emit({"errors": errors, "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    blockers = verification_blockers(db_path(), run_id)
    transition(
        connection,
        run_id,
        "review_required",
        "publishing",
        details={"decision": "approved", "resolved_findings": blockers},
    )
    crash_if_requested("before_publication")
    try:
        complete_publication(connection, row)
    except Exception as error:
        connection.close()
        emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    connection.close()
    emit({"ok": True, "run_id": run_id, "state": "published"})
    return 0


def cancel(run_id: str) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] in TERMINAL_STATES:
        connection.close()
        raise UserError(f"Run {run_id} is already terminal")
    try:
        if row["state"] == "publishing" and published_run_id(Path(row["publish_dir"])) == run_id:
            source_set = json.loads(row["source_set_json"])
            restore_publication(
                Path(row["publish_dir"]),
                previous_publication_target(row, source_set),
                run_id,
            )
        transition(connection, run_id, row["state"], "cancelled")
    except OSError as error:
        raise UserError(f"Cannot restore the previous published Bundle: {error}") from error
    finally:
        connection.close()
    emit({"ok": True, "run_id": run_id, "state": "cancelled"})
    return 0


def recover(run_id: str) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] == "published":
        connection.close()
        emit({"ok": True, "recovered_tasks": [], "run_id": run_id, "state": "published"})
        return 0
    if row["state"] in {"failed", "cancelled"}:
        connection.close()
        raise UserError(f"Run {run_id} is {row['state']} and terminal")
    from .scheduler import recover_tasks

    recovered_tasks = recover_tasks(db_path(), run_id)
    state = row["state"]
    try:
        if state == "preparing":
            state, _coverage = advance_preparation(connection, run_id)
            if state == "failed":
                raise UserError("Major Coverage Obligations are blocked or failed")
        if state in {"verifying", "rendering", "checking"}:
            state = advance_rendering(connection, run_id, rerender_checking=state == "checking")
    except Exception as error:
        current = get_run(connection, run_id)["state"]
        if current not in TERMINAL_STATES:
            transition(connection, run_id, current, "failed", error=str(error))
            current = "failed"
        connection.close()
        emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": current})
        return 1
    if state == "publishing":
        current = get_run(connection, run_id)
        source_set = json.loads(current["source_set_json"])
        errors = run_validation_errors(current, source_set, obligation_rows(connection, run_id))
        if errors:
            transition(connection, run_id, "publishing", "failed", error="; ".join(errors))
            connection.close()
            emit({"errors": errors, "ok": False, "run_id": run_id, "state": "failed"})
            return 1
        try:
            complete_publication(connection, current)
        except Exception as error:
            connection.close()
            emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": "failed"})
            return 1
    final_state = get_run(connection, run_id)["state"]
    connection.close()
    emit(
        {
            "ok": True,
            "recovered_tasks": recovered_tasks,
            "run_id": run_id,
            "state": final_state,
        }
    )
    return 0


def agent_eval(manifest_path: str) -> int:
    from .agent_evals import ReleaseEvalManifest, evaluate_release

    try:
        payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        manifest = ReleaseEvalManifest.model_validate(payload)
    except (OSError, ValueError) as error:
        raise UserError(f"Invalid Agent Eval manifest: {error}") from error
    report = evaluate_release(manifest)
    emit(report.model_dump(mode="json"))
    return int(report.blocked)


def benchmark(manifest_path: str) -> int:
    from .benchmark import run_benchmark

    try:
        report = run_benchmark(manifest_path=Path(manifest_path))
    except (OSError, ValueError) as error:
        raise UserError(f"Invalid Benchmark manifest: {error}") from error
    emit(report.model_dump(mode="json"))
    return int(report.blocked)


def explore(run_id: str) -> int:
    with connect(read_only=True) as connection:
        row = get_run(connection, run_id)
    if row["state"] in TERMINAL_STATES:
        raise UserError(f"Run {run_id} is {row['state']} and terminal")
    required = {
        name: os.environ.get(name)
        for name in ("OKF_GATEWAY_BASE_URL", "OKF_GATEWAY_API_KEY", "OKF_GATEWAY_MODEL")
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise UserError(f"Missing gateway environment: {', '.join(missing)}")
    base_url = required["OKF_GATEWAY_BASE_URL"]
    api_key = required["OKF_GATEWAY_API_KEY"]
    model_name = required["OKF_GATEWAY_MODEL"]
    assert base_url is not None and api_key is not None and model_name is not None
    try:
        concurrency = int(os.environ.get("OKF_GATEWAY_CONCURRENCY", "4"))
    except ValueError as error:
        raise UserError("OKF_GATEWAY_CONCURRENCY must be a positive integer") from error
    if concurrency < 1:
        raise UserError("OKF_GATEWAY_CONCURRENCY must be a positive integer")
    headers_text = os.environ.get("OKF_GATEWAY_HEADERS")
    try:
        headers = json.loads(headers_text) if headers_text else None
    except json.JSONDecodeError as error:
        raise UserError("OKF_GATEWAY_HEADERS must be a JSON object") from error
    if headers is not None and (
        not isinstance(headers, dict)
        or any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in headers.items()
        )
    ):
        raise UserError("OKF_GATEWAY_HEADERS must be a JSON object of strings")
    from .planner import PlannerAgent
    from .scheduler import Scheduler
    from .verifier import VerifierAgent
    from .worker import GatewaySettings, WorkerAgent, build_gateway_model

    secrets = tuple(filter(None, (api_key, *(headers or {}).values())))

    model = build_gateway_model(
        GatewaySettings(
            base_url=base_url,
            api_key=api_key,
            model=model_name,
            default_headers=headers,
        )
    )

    async def execute():
        try:
            worker = WorkerAgent(
                model,
                audit_path=state_dir() / "runs" / run_id / "worker.db",
                gateway_id=os.environ.get("OKF_GATEWAY_ID", "enterprise"),
                model_name=model_name,
                max_concurrency=concurrency,
                secrets=secrets,
            )
            scheduler = Scheduler(
                db_path(),
                PlannerAgent(model, secrets=secrets),
                worker,
                max_concurrency=concurrency,
                verifier=VerifierAgent(model, secrets=secrets),
            )
            return await scheduler.run_until_terminal(run_id)
        finally:
            client = getattr(model.provider, "client", None)
            if client is not None:
                await client.close()

    outcome = asyncio.run(execute())
    if outcome.status == "complete":
        try:
            finish_run(run_id)
        except Exception as error:
            emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": "failed"})
            return 1
        emit({"ok": True, "run_id": run_id, "state": "review_required"})
        return 0
    emit({"ok": False, "run_id": run_id, **outcome.model_dump(mode="json")})
    return 1


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="okf-wiki")
    subcommands = command.add_subparsers(dest="command", required=True)
    build_command = subcommands.add_parser("build")
    build_command.add_argument("project_config")
    status_command = subcommands.add_parser("status")
    status_command.add_argument("run_id")
    explore_command = subcommands.add_parser("explore")
    explore_command.add_argument("run_id")
    check_command = subcommands.add_parser("check")
    check_command.add_argument("target")
    review_command = subcommands.add_parser("review")
    review_command.add_argument("run_id")
    decision = review_command.add_mutually_exclusive_group(required=True)
    decision.add_argument("--approve", action="store_true")
    decision.add_argument("--reject", action="store_true")
    cancel_command = subcommands.add_parser("cancel")
    cancel_command.add_argument("run_id")
    recover_command = subcommands.add_parser("recover")
    recover_command.add_argument("run_id")
    eval_command = subcommands.add_parser("eval")
    eval_command.add_argument("manifest")
    benchmark_command = subcommands.add_parser("benchmark")
    benchmark_command.add_argument("manifest")
    gateway_command = subcommands.add_parser("gateway")
    gateway_commands = gateway_command.add_subparsers(dest="gateway_command", required=True)
    gateway_list = gateway_commands.add_parser("list")
    gateway_list.add_argument("--config-root")
    gateway_save = gateway_commands.add_parser("save")
    gateway_save.add_argument("profile_id")
    gateway_save.add_argument("--name", required=True)
    gateway_save.add_argument("--gateway-id", required=True)
    gateway_save.add_argument("--base-url", required=True)
    gateway_save.add_argument("--header", action="append", default=[])
    gateway_save.add_argument("--credential-stdin", action="store_true")
    gateway_save.add_argument("--expected-revision", type=int)
    gateway_save.add_argument("--config-root")
    gateway_test = gateway_commands.add_parser("test")
    gateway_test.add_argument("profile_id")
    gateway_test.add_argument("--model")
    gateway_test.add_argument("--timeout", type=float, default=10)
    gateway_test.add_argument("--config-root")
    gateway_select = gateway_commands.add_parser("select")
    gateway_select.add_argument("root")
    gateway_select.add_argument("profile_id")
    gateway_select.add_argument("--model", required=True)
    gateway_select.add_argument("--concurrency", type=int, default=4)
    gateway_select.add_argument("--budget", action="append", default=[])
    gateway_select.add_argument("--role-model", action="append", default=[])
    gateway_select.add_argument("--config-root")
    gateway_snapshot = gateway_commands.add_parser("snapshot")
    gateway_snapshot.add_argument("root")
    gateway_snapshot.add_argument("--config-root")
    workspace_command = subcommands.add_parser("workspace")
    workspace_commands = workspace_command.add_subparsers(dest="workspace_command", required=True)
    workspace_init = workspace_commands.add_parser("init")
    workspace_init.add_argument("project_id")
    workspace_init.add_argument("--name")
    workspace_init.add_argument("--root", default=".")
    workspace_inspect = workspace_commands.add_parser("inspect")
    workspace_inspect.add_argument("root", nargs="?", default=".")
    workspace_validate = workspace_commands.add_parser("validate")
    workspace_validate.add_argument("root", nargs="?", default=".")
    workspace_settings = workspace_commands.add_parser("settings")
    workspace_settings.add_argument("root", nargs="?", default=".")
    workspace_update_settings = workspace_commands.add_parser("update-settings")
    workspace_update_settings.add_argument("payload")
    workspace_update_settings.add_argument("root", nargs="?", default=".")
    workspace_migrate = workspace_commands.add_parser("migrate")
    workspace_migrate.add_argument("project_config")
    workspace_migrate.add_argument("--root")
    workspace_console = workspace_commands.add_parser("console")
    workspace_console.add_argument("root", nargs="?", default=".")
    workspace_console.add_argument("--port", type=int, default=0)
    workspace_console.add_argument("--no-open", action="store_true")
    return command


def main() -> int:
    arguments = parser().parse_args()
    try:
        if arguments.command == "build":
            return build(arguments.project_config)
        if arguments.command == "status":
            return status(arguments.run_id)
        if arguments.command == "explore":
            return explore(arguments.run_id)
        if arguments.command == "check":
            return check(arguments.target)
        if arguments.command == "review":
            return review(arguments.run_id, arguments.approve)
        if arguments.command == "cancel":
            return cancel(arguments.run_id)
        if arguments.command == "eval":
            return agent_eval(arguments.manifest)
        if arguments.command == "benchmark":
            return benchmark(arguments.manifest)
        if arguments.command == "gateway":
            gateways = GatewayApplication(arguments.config_root)
            if arguments.gateway_command == "list":
                emit({"ok": True, "profiles": gateways.list_profiles()})
            elif arguments.gateway_command == "save":
                credential = sys.stdin.read() if arguments.credential_stdin else None
                emit(
                    {
                        "ok": True,
                        "profile": gateways.save_profile(
                            {
                                "id": arguments.profile_id,
                                "name": arguments.name,
                                "gateway_id": arguments.gateway_id,
                                "base_url": arguments.base_url,
                                "headers": _key_values(arguments.header, "header", str),
                            },
                            credential=credential.rstrip("\n") if credential is not None else None,
                            expected_revision=arguments.expected_revision,
                        ),
                    }
                )
            elif arguments.gateway_command == "test":
                emit(
                    {
                        "ok": True,
                        "result": gateways.test_profile(
                            arguments.profile_id,
                            model=arguments.model,
                            timeout_seconds=arguments.timeout,
                        ),
                    }
                )
            elif arguments.gateway_command == "select":
                emit(
                    {
                        "ok": True,
                        "workspace": gateways.select_workspace(
                            arguments.root,
                            profile_id=arguments.profile_id,
                            default_model=arguments.model,
                            concurrency=arguments.concurrency,
                            budgets=_key_values(arguments.budget, "budget", int),
                            role_overrides=_key_values(
                                arguments.role_model, "role-model", str
                            ),
                        ),
                    }
                )
            else:
                emit({"ok": True, "models": gateways.run_snapshot(arguments.root)})
            return 0
        if arguments.command == "workspace":
            if arguments.workspace_command == "console":
                from .console import run_console

                return run_console(
                    arguments.root, arguments.port, open_browser=not arguments.no_open
                )
            if arguments.workspace_command == "migrate":
                root = arguments.root or Path(arguments.project_config).resolve().parent
                app = WorkspaceApplication(root)
                snapshot = app.migrate_legacy(arguments.project_config)
            elif arguments.workspace_command == "init":
                app = WorkspaceApplication(arguments.root)
                snapshot = app.initialize(arguments.project_id, arguments.name)
            elif arguments.workspace_command == "settings":
                app = WorkspaceApplication(arguments.root)
                emit({"ok": True, **app.settings()})
                return 0
            elif arguments.workspace_command == "update-settings":
                app = WorkspaceApplication(arguments.root)
                try:
                    payload = json.loads(Path(arguments.payload).read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise UserError(f"Invalid settings update: {error}") from error
                emit({"ok": True, **app.update_settings_payload(payload)})
                return 0
            else:
                app = WorkspaceApplication(arguments.root)
                snapshot = app.open()
            emit({"ok": True, **snapshot.model_dump(mode="json")})
            return 0
        return recover(arguments.run_id)
    except (GatewayError, UserError, WorkspaceError) as error:
        emit({"errors": [str(error)], "ok": False})
        return 1


def _key_values(values: list[str], label: str, value_type: type) -> dict:
    parsed = {}
    for item in values:
        if "=" not in item:
            raise GatewayError(f"--{label} must use NAME=VALUE")
        key, value = item.split("=", 1)
        if not key or not value:
            raise GatewayError(f"--{label} must use non-empty NAME=VALUE")
        try:
            parsed[key] = value_type(value)
        except ValueError:
            raise GatewayError(f"--{label} has an invalid value for {key}") from None
    return parsed
