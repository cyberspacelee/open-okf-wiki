import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tomllib
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.parse import quote_from_bytes, unquote, urlsplit

import yaml

from .accepted_knowledge import AcceptedKnowledgeStore
from .coverage import DISPOSITIONS, major_blockers, obligation_rows, summarize_obligations
from .java_analysis import (
    DEFAULT_JAVA_EXCLUDED_PATHS,
    JAVA_DEFAULT_PRIORITIES,
    JAVA_OBLIGATION_KINDS,
    accept_data_contracts,
    aggregate_data_contracts,
    analyze_java_source,
    is_java_input,
)
from .source_identity import source_unit_id, stable_span_id
from .run_events import append_run_event
from .run_state import RunTransitionError, transition_run


TERMINAL_STATES = {"published", "failed", "cancelled"}
REQUIRED_BUNDLE_FILES = {"index.md", "log.md", "overview.md", "reports/coverage.md"}
LINK_RE = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
INDEX_ENTRY_RE = re.compile(r"^[*-] \[[^]]+\]\([^)]+\)(?: - .+)?$")
LOG_DATE_RE = re.compile(r"^## \d{4}-\d{2}-\d{2}$")
LOG_ENTRY_RE = re.compile(r"^[*-] .+$")
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
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            repository TEXT NOT NULL,
            revision TEXT NOT NULL,
            publish_dir TEXT NOT NULL,
            staging_dir TEXT NOT NULL,
            state TEXT NOT NULL,
            coverage_json TEXT,
            source_set_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES runs(id),
            previous_state TEXT,
            state TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS coverage_obligations (
            id TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES runs(id),
            source TEXT NOT NULL,
            role TEXT NOT NULL,
            path TEXT NOT NULL,
            source_unit TEXT NOT NULL,
            kind TEXT NOT NULL,
            priority TEXT NOT NULL,
            disposition TEXT NOT NULL,
            reason TEXT,
            span TEXT NOT NULL,
            text TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (run_id, id)
        );
        CREATE TRIGGER IF NOT EXISTS run_events_no_update
        BEFORE UPDATE ON run_events BEGIN
            SELECT RAISE(ABORT, 'Run Events are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS run_events_no_delete
        BEFORE DELETE ON run_events BEGIN
            SELECT RAISE(ABORT, 'Run Events are immutable');
        END;
        """
    )
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(runs)")}
    if "source_set_json" not in columns:
        connection.execute("ALTER TABLE runs ADD COLUMN source_set_json TEXT")
    obligation_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(coverage_obligations)")
    }
    if "details" not in obligation_columns:
        connection.execute(
            "ALTER TABLE coverage_obligations ADD COLUMN details TEXT NOT NULL DEFAULT '{}'"
        )


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
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        capture_output=True,
    )
    if result.returncode:
        raise UserError(result.stderr.decode(errors="replace").strip() or "Git command failed")
    return result.stdout


def git(repository: Path, *arguments: str) -> str:
    return git_bytes(repository, *arguments).decode()


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
        universe.append(
            {
                "path": path,
                "revision": revision,
                "source_id": source["id"],
                "source_unit": unit_id,
                "source_unit_kind": "file",
            }
        )
        if object_type != b"blob":
            continue
        is_markdown = path_bytes.lower().endswith(b".md")
        is_java = is_java_input(path)
        if not (is_markdown or is_java):
            continue
        content = git_bytes(repository, "cat-file", "blob", object_id.decode())
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


def load_config(path_text: str) -> tuple[str, list[dict], Path, dict]:
    path = Path(path_text).resolve()
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise UserError(f"Cannot read Producer Project config: {error}") from error
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


def report_metadata(coverage: dict) -> dict:
    major = coverage.get("by_priority", {}).get("major", {}).get("dispositions", {})
    return {
        "blocked_major_obligations": major.get("blocked", 0),
        "blocked_obligations": coverage["blocked"],
        "covered_major_obligations": major.get("covered", 0),
        "covered_obligations": coverage["covered"],
        "deferred_obligations": coverage["deferred"],
        "excluded_major_obligations": major.get("excluded", 0),
        "excluded_obligations": coverage["excluded"],
        "failed_major_obligations": major.get("failed", 0),
        "failed_obligations": coverage["failed"],
        "major_obligations": coverage["major"],
        "open_major_obligations": major.get("open", 0),
        "open_obligations": coverage["open"],
        "supporting_obligations": coverage["supporting"],
        "total_obligations": coverage["total"],
    }


def frontmatter(
    type_name: str,
    title: str,
    description: str,
    revision: str,
    **metadata: int,
) -> str:
    return (
        "---\n"
        + yaml.safe_dump(
            {
                "type": type_name,
                "title": title,
                "description": description,
                "source_revision": revision,
                **metadata,
            },
            allow_unicode=True,
            sort_keys=False,
        )
        + "---\n"
    )


def render_coverage_group(title: str, groups: dict) -> str:
    rows = [f"## {title}", "", "| Value | Total | Dispositions |", "| --- | ---: | --- |"]
    rows.extend(
        f"| `{value}` | {group['total']} | "
        + ", ".join(
            f"`{disposition}`: {count}" for disposition, count in group["dispositions"].items()
        )
        + " |"
        for value, group in groups.items()
    )
    return "\n".join(rows)


def render_bundle(
    staging: Path,
    project_id: str,
    revision: str,
    sources: list[dict],
    evidence: list[dict],
    obligations: list[dict],
    coverage: dict,
    commit_date: str,
    accepted_knowledge: list[dict] | None = None,
    database: Path | None = None,
    run_id: str | None = None,
) -> None:
    accepted_knowledge = accepted_knowledge or []
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "reports").mkdir(parents=True)
    knowledge_links = "".join(
        f"* [{concept['canonical_name']}]({concept['page']}) - Accepted source knowledge.\n"
        for concept in sorted(accepted_knowledge, key=lambda item: item["page"])
    )
    (staging / "index.md").write_text(
        f"# {project_id} Knowledge Bundle\n\n"
        "* [Overview](overview.md) - Fixed-revision source overview.\n"
        "* [Coverage Report](reports/coverage.md) - Major obligation disposition.\n"
        + knowledge_links,
        encoding="utf-8",
    )
    (staging / "log.md").write_text(
        "# Bundle Update Log\n\n"
        f"## {commit_date}\n"
        f"* **Creation**: Staged the bundle for Source Set `{revision}`.\n",
        encoding="utf-8",
    )
    source_summary = "\n".join(
        f"* `{source['id']}` ({source['role']}) at revision `{source['revision']}` "
        f"with tree digest `{source['digest']}`."
        for source in sources
    )
    (staging / "overview.md").write_text(
        frontmatter(
            "Overview",
            f"{project_id} Overview",
            "Overview of the fixed source revision.",
            revision,
        )
        + f"\n# Overview\n\nProducer Project `{project_id}` covers "
        f"{len(evidence)} tracked source file(s) from {len(sources)} source(s).\n\n"
        + source_summary
        + "\n",
        encoding="utf-8",
    )
    obligation_lines = []
    for item in obligations:
        span = item["span"]
        reason = f" — {item['reason']}" if item["reason"] else ""
        obligation_lines.append(
            f"* `{item['id']}` — `{item['source']}/{item['path']}` "
            f"lines {span['start_line']}-{span['end_line']}; `{item['kind']}`, "
            f"`{item['priority']}`, `{item['disposition']}`{reason}"
        )
    source_lines = [
        f"* `{source['id']}` ({source['role']}) at revision `{source['revision']}` "
        f"with tree digest `{source['digest']}`."
        for source in sources
    ]
    (staging / "reports" / "coverage.md").write_text(
        frontmatter(
            "Coverage Report",
            "Coverage Report",
            "Disposition of Coverage Obligations.",
            revision,
            **report_metadata(coverage),
        )
        + "\n# Coverage Report\n\n"
        + "## Sources\n\n"
        + "\n".join(source_lines)
        + "\n\n"
        + render_coverage_group("By Source", coverage["by_source"])
        + "\n\n"
        + render_coverage_group("By Role", coverage["by_role"])
        + "\n\n"
        + render_coverage_group("By Priority", coverage["by_priority"])
        + "\n\n## Obligations\n\n"
        + ("\n".join(obligation_lines) if obligation_lines else "No Coverage Obligations.")
        + "\n",
        encoding="utf-8",
    )
    if accepted_knowledge and database is not None and run_id is not None:
        store = AcceptedKnowledgeStore(database)
        for concept in accepted_knowledge:
            path = staging / concept["page"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                frontmatter(
                    "Concept",
                    concept["canonical_name"],
                    "Accepted source-grounded knowledge.",
                    revision,
                )
                + "\n"
                + store.derive_concept_page(run_id, concept["id"]),
                encoding="utf-8",
            )


def parse_frontmatter(path: Path, text: str) -> tuple[dict | None, list[str]]:
    errors = []
    if not text.startswith("---\n"):
        return None, [f"{path}: missing YAML frontmatter"]
    end = text.find("\n---\n", 4)
    if end == -1:
        return None, [f"{path}: unterminated YAML frontmatter"]
    try:
        data = yaml.safe_load(text[4:end])
    except yaml.YAMLError as error:
        return None, [f"{path}: invalid YAML frontmatter: {error}"]
    if not isinstance(data, dict):
        errors.append(f"{path}: frontmatter must be a mapping")
        return None, errors
    elif not isinstance(data.get("type"), str) or not data["type"].strip():
        errors.append(f"{path}: frontmatter type must be non-empty")
    return data, errors


def validate_index(text: str) -> list[str]:
    lines = text.splitlines()
    if not lines:
        return ["index.md: must contain a section"]
    seen_section = False
    entries = 0
    for line in lines:
        if line == "":
            continue
        if line.startswith("# ") and line != "# ":
            if seen_section and not entries:
                return ["index.md: every section must contain a Markdown link bullet"]
            seen_section = True
            entries = 0
        elif seen_section and INDEX_ENTRY_RE.fullmatch(line):
            entries += 1
        else:
            return ["index.md: only sections, blank lines, and Markdown link bullets are allowed"]
    return (
        [] if seen_section and entries else ["index.md: every section must contain a link bullet"]
    )


def validate_log(text: str) -> list[str]:
    lines = text.splitlines()
    if not lines or not lines[0].startswith("# ") or lines[0] == "# ":
        return ["log.md: must start with a non-empty title"]
    seen_date = False
    entries = 0
    for line in lines[1:]:
        if line == "":
            continue
        if LOG_DATE_RE.fullmatch(line):
            try:
                date.fromisoformat(line.removeprefix("## "))
            except ValueError:
                return ["log.md: date sections must use valid ISO dates"]
            if seen_date and not entries:
                return ["log.md: every ISO date section must contain a bullet"]
            seen_date = True
            entries = 0
        elif seen_date and LOG_ENTRY_RE.fullmatch(line):
            entries += 1
        else:
            return ["log.md: only a title, ISO date sections, and bullets are allowed"]
    return [] if seen_date and entries else ["log.md: must contain a dated bullet entry"]


def validate_bundle(
    bundle: Path,
    expected_revision: str | None = None,
    expected_coverage: dict | None = None,
) -> list[str]:
    if not bundle.is_dir():
        return [f"Bundle does not exist: {bundle}"]
    errors = []
    documents = {}
    present = {path.relative_to(bundle).as_posix() for path in bundle.rglob("*.md")}
    for missing in sorted(REQUIRED_BUNDLE_FILES - present):
        errors.append(f"Missing required Bundle file: {missing}")
    for relative in sorted(present):
        path = bundle / relative
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            errors.append(f"{relative}: cannot read UTF-8 Markdown: {error}")
            continue
        if path.name == "index.md":
            errors.extend(
                f"{relative}: {error.removeprefix('index.md: ')}" for error in validate_index(text)
            )
        elif path.name == "log.md":
            errors.extend(
                f"{relative}: {error.removeprefix('log.md: ')}" for error in validate_log(text)
            )
        else:
            data, frontmatter_errors = parse_frontmatter(Path(relative), text)
            errors.extend(frontmatter_errors)
            if data is not None:
                documents[relative] = data
                if (
                    expected_revision is not None
                    and data.get("source_revision") != expected_revision
                ):
                    errors.append(
                        f"{relative}: source_revision does not match Production Run revision"
                    )
        for raw_target in LINK_RE.findall(text):
            target = unquote(urlsplit(raw_target.strip().split()[0]).path)
            if not target or urlsplit(raw_target).scheme or target.startswith("#"):
                continue
            resolved = (
                (bundle / target.lstrip("/")) if target.startswith("/") else path.parent / target
            )
            try:
                resolved.resolve().relative_to(bundle.resolve())
            except ValueError:
                errors.append(f"{relative}: link escapes Bundle: {raw_target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: broken internal link: {raw_target}")
    if expected_revision is None:
        overview_revision = documents.get("overview.md", {}).get("source_revision")
        coverage_revision = documents.get("reports/coverage.md", {}).get("source_revision")
        if not isinstance(overview_revision, str) or overview_revision != coverage_revision:
            errors.append("overview.md and reports/coverage.md source_revision must match")
    coverage = documents.get("reports/coverage.md", {})
    metadata_fields = (
        "blocked_major_obligations",
        "blocked_obligations",
        "covered_major_obligations",
        "covered_obligations",
        "deferred_obligations",
        "excluded_major_obligations",
        "excluded_obligations",
        "failed_major_obligations",
        "failed_obligations",
        "major_obligations",
        "open_major_obligations",
        "open_obligations",
        "supporting_obligations",
        "total_obligations",
    )
    for field in metadata_fields:
        value = coverage.get(field)
        if type(value) is not int or value < 0:
            errors.append(f"reports/coverage.md: {field} must be a non-negative integer")
    if all(type(coverage.get(field)) is int for field in metadata_fields):
        if coverage["total_obligations"] != (
            coverage["major_obligations"] + coverage["supporting_obligations"]
        ):
            errors.append("reports/coverage.md: priority totals must equal total_obligations")
        if coverage["total_obligations"] != sum(
            coverage[f"{disposition}_obligations"]
            for disposition in ("blocked", "covered", "deferred", "excluded", "failed", "open")
        ):
            errors.append("reports/coverage.md: disposition totals must equal total_obligations")
    major_obligations = coverage.get("major_obligations")
    covered_major = coverage.get("covered_major_obligations")
    excluded_major = coverage.get("excluded_major_obligations")
    if (
        type(major_obligations) is int
        and type(covered_major) is int
        and type(excluded_major) is int
        and major_obligations != covered_major + excluded_major
    ):
        errors.append("reports/coverage.md: all Major Obligations must be covered or excluded")
    for field in (
        "blocked_major_obligations",
        "failed_major_obligations",
        "open_major_obligations",
    ):
        if coverage.get(field) != 0:
            errors.append(f"reports/coverage.md: {field} must be the integer 0")
    if expected_coverage is not None:
        expected_metadata = (
            report_metadata(expected_coverage)
            if "total" in expected_coverage
            else {
                "covered_obligations": expected_coverage.get("covered"),
                "major_obligations": expected_coverage.get("major"),
                "open_obligations": expected_coverage.get("open"),
            }
        )
        for report_field, expected in expected_metadata.items():
            if coverage.get(report_field) != expected:
                errors.append(f"reports/coverage.md: {report_field} does not match run coverage")
    return errors


def build(config_path: str) -> int:
    project_id, configured_sources, publish_dir, profile = load_config(config_path)
    profile_id = producer_profile_id(profile)
    configured_digest = source_set_digest(configured_sources)
    provisional_revision = (
        configured_sources[0]["revision"] if len(configured_sources) == 1 else configured_digest
    )
    run_id = uuid.uuid4().hex
    staging = state_dir() / "runs" / run_id / "staging"
    connection = connect()
    initialize(connection)
    source_set = {
        "digest": configured_digest,
        "evidence": [],
        "producer_profile_id": profile_id,
        "source_universe": [],
        "sources": configured_sources,
    }
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
    state = "preparing"
    try:
        sources = []
        source_universe = []
        evidence = []
        obligations = []
        commit_dates = []
        for configured_source in configured_sources:
            try:
                source, source_files, source_evidence, source_obligations, commit_date = (
                    inspect_source(configured_source, profile)
                )
            except UserError as error:
                raise UserError(f"Source {configured_source['id']}: {error}") from error
            sources.append(source)
            source_universe.extend(source_files)
            evidence.extend(source_evidence)
            obligations.extend(source_obligations)
            commit_dates.append(commit_date)
        digest = source_set_digest(sources)
        bundle_revision = sources[0]["revision"] if len(sources) == 1 else digest
        obligations.sort(
            key=lambda item: (
                item["source"],
                item["path"],
                item["span"]["start_line"],
                item["kind"],
            )
        )
        with connection:
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
                            {
                                key: item[key]
                                for key in (
                                    "constraints",
                                    "carrier_promotion_reasons",
                                    "data_carriers",
                                    "data_contract_name",
                                    "evidence_source_units",
                                    "matched_rule",
                                    "promoted",
                                    "promotion_reasons",
                                )
                                if key in item
                            },
                            sort_keys=True,
                        ),
                    )
                    for item in obligations
                ],
            )
            obligations = obligation_rows(connection, run_id)
            coverage = summarize_obligations(obligations, sources)
            for source in sources:
                source["coverage"] = summarize_obligations(
                    [item for item in obligations if item["source"] == source["id"]], [source]
                )
            source_set = {
                "digest": digest,
                "evidence": sorted(evidence, key=lambda item: (item["source_id"], item["path"])),
                "producer_profile_id": profile_id,
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
                """UPDATE runs
                   SET revision = ?, source_set_json = ?, coverage_json = ?, updated_at = ?
                   WHERE id = ?""",
                (
                    bundle_revision,
                    json.dumps(source_set, sort_keys=True),
                    json.dumps(coverage, sort_keys=True),
                    now(),
                    run_id,
                ),
            )
        if not evidence:
            raise UserError("Fixed Source Set contains no tracked Java or Markdown files")
        major = coverage.get("by_priority", {}).get("major", {}).get("dispositions", {})
        if major.get("blocked", 0) or major.get("failed", 0):
            error = "Major Coverage Obligations are blocked or failed"
            transition(connection, run_id, state, "failed", coverage=coverage, error=error)
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
        transition(connection, run_id, state, "exploring", coverage=coverage)
        state = "exploring"
        if coverage.get("open", 0):
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
        transition(connection, run_id, state, "verifying", coverage=coverage)
        state = "verifying"
        accepted_knowledge = accept_data_contracts(db_path(), run_id, source_universe, obligations)
        source_set["accepted_knowledge"] = accepted_knowledge
        with connection:
            connection.execute(
                "UPDATE runs SET source_set_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(source_set, sort_keys=True), now(), run_id),
            )
        transition(connection, run_id, state, "rendering", coverage=coverage)
        state = "rendering"
        render_bundle(
            staging,
            project_id,
            bundle_revision,
            sources,
            evidence,
            obligations,
            coverage,
            max(commit_dates),
            accepted_knowledge,
            db_path(),
            run_id,
        )
        transition(connection, run_id, state, "checking")
        state = "checking"
        errors = validate_bundle(staging, bundle_revision, coverage)
        if errors:
            raise UserError("; ".join(errors))
        transition(connection, run_id, state, "review_required")
    except Exception as error:
        transition(connection, run_id, state, "failed", error=str(error))
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
    payload = {
        "blocked": bool(coverage and "total" in coverage and major_blockers(coverage)),
        "accepted_knowledge": source_set.get("accepted_knowledge", []),
        "coverage": coverage,
        "evidence": source_set["evidence"],
        "error": row["error"],
        "events": events,
        "obligations": obligations,
        "ok": True,
        "project_id": row["project_id"],
        "producer_profile_id": source_set.get("producer_profile_id"),
        "published_bundle": row["publish_dir"],
        "run_id": row["id"],
        "source_set_digest": source_set["digest"],
        "source_universe": source_set["source_universe"],
        "sources": source_set["sources"],
        "staging_bundle": row["staging_dir"],
        "state": row["state"],
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
    else:
        with connect(read_only=True) as connection:
            row = get_run(connection, target)
        expected_coverage = json.loads(row["coverage_json"]) if row["coverage_json"] else None
        errors = validate_bundle(Path(row["staging_dir"]), row["revision"], expected_coverage)
    emit({"errors": errors, "ok": not errors, "target": target})
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


def review(run_id: str, approve: bool) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] != "review_required":
        connection.close()
        raise UserError(f"Run {run_id} is not Review Required")
    if not approve:
        transition(
            connection,
            run_id,
            "review_required",
            "cancelled",
            details={"decision": "rejected"},
        )
        connection.close()
        emit({"decision": "rejected", "ok": True, "run_id": run_id, "state": "cancelled"})
        return 0
    expected_coverage = json.loads(row["coverage_json"]) if row["coverage_json"] else None
    errors = validate_bundle(Path(row["staging_dir"]), row["revision"], expected_coverage)
    if errors:
        transition(connection, run_id, "review_required", "failed", error="; ".join(errors))
        connection.close()
        emit({"errors": errors, "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    transition(connection, run_id, "review_required", "publishing")
    publication_changed = False
    try:
        previous_target = publish(Path(row["staging_dir"]), Path(row["publish_dir"]), run_id)
        publication_changed = True
        transition(connection, run_id, "publishing", "published")
    except Exception as error:
        if publication_changed:
            try:
                restore_publication(Path(row["publish_dir"]), previous_target, run_id)
            except Exception as rollback_error:
                error = UserError(f"{error}; publication rollback failed: {rollback_error}")
        transition(connection, run_id, "publishing", "failed", error=str(error))
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
        transition(connection, run_id, row["state"], "cancelled")
    finally:
        connection.close()
    emit({"ok": True, "run_id": run_id, "state": "cancelled"})
    return 0


def explore(run_id: str) -> int:
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
    with connect(read_only=True) as connection:
        get_run(connection, run_id)

    from .planner import PlannerAgent
    from .scheduler import Scheduler
    from .worker import GatewaySettings, WorkerAgent, build_gateway_model

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
            )
            scheduler = Scheduler(
                db_path(),
                PlannerAgent(model),
                worker,
                max_concurrency=concurrency,
            )
            return await scheduler.run_until_terminal(run_id)
        finally:
            client = getattr(model.provider, "client", None)
            if client is not None:
                await client.close()

    outcome = asyncio.run(execute())
    emit({"ok": outcome.status == "complete", "run_id": run_id, **outcome.model_dump(mode="json")})
    return 0 if outcome.status == "complete" else 1


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
        return cancel(arguments.run_id)
    except UserError as error:
        emit({"errors": [str(error)], "ok": False})
        return 1
