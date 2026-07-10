import argparse
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
from urllib.parse import unquote, urlsplit

import yaml


ALLOWED_TRANSITIONS = {
    "preparing": {"rendering", "failed", "cancelled"},
    "rendering": {"checking", "failed", "cancelled"},
    "checking": {"review_required", "failed", "cancelled"},
    "review_required": {"publishing", "failed", "cancelled"},
    "publishing": {"published", "failed"},
}
TERMINAL_STATES = {"published", "failed", "cancelled"}
REQUIRED_BUNDLE_FILES = {"index.md", "log.md", "overview.md", "reports/coverage.md"}
LINK_RE = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
INDEX_ENTRY_RE = re.compile(r"^[*-] \[[^]]+\]\([^)]+\)(?: - .+)?$")
LOG_DATE_RE = re.compile(r"^## \d{4}-\d{2}-\d{2}$")
LOG_ENTRY_RE = re.compile(r"^[*-] .+$")


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


def create_run(
    connection: sqlite3.Connection,
    run_id: str,
    project_id: str,
    repository: Path,
    revision: str,
    publish_dir: Path,
    staging_dir: Path,
) -> None:
    timestamp = now()
    with connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?)""",
            (
                run_id,
                project_id,
                str(repository),
                revision,
                str(publish_dir),
                str(staging_dir),
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            """INSERT INTO run_events (run_id, previous_state, state, occurred_at)
               VALUES (?, NULL, 'preparing', ?)""",
            (run_id, timestamp),
        )


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
    if next_state not in ALLOWED_TRANSITIONS.get(previous_state, set()):
        raise UserError(f"Illegal Production Run transition: {previous_state} -> {next_state}")
    event_details = dict(details or {})
    if error:
        event_details["error"] = error
    timestamp = now()
    with connection:
        changed = connection.execute(
            """UPDATE runs
               SET state = ?, coverage_json = COALESCE(?, coverage_json), error = ?, updated_at = ?
               WHERE id = ? AND state = ?""",
            (
                next_state,
                json.dumps(coverage, sort_keys=True) if coverage is not None else None,
                error,
                timestamp,
                run_id,
                previous_state,
            ),
        )
        if changed.rowcount != 1:
            raise UserError(f"Run {run_id} is not in {previous_state}")
        connection.execute(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES (?, ?, ?, ?, ?)""",
            (
                run_id,
                previous_state,
                next_state,
                timestamp,
                json.dumps(event_details, sort_keys=True),
            ),
        )


def get_run(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise UserError(f"Unknown Production Run: {run_id}")
    return row


def git(repository: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise UserError(result.stderr.strip() or "Git command failed")
    return result.stdout


def inspect_source(repository: Path, revision: str) -> tuple[list[str], str]:
    if not repository.is_dir():
        raise UserError(f"Repository does not exist: {repository}")
    if re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", revision) is None:
        raise UserError("Revision must be a full Git commit ID")
    resolved = git(repository, "rev-parse", "--verify", f"{revision}^{{commit}}").strip()
    if resolved.lower() != revision.lower():
        raise UserError("Revision does not resolve to the exact requested commit")
    files = git(repository, "ls-tree", "-r", "--name-only", "-z", revision).split("\0")
    markdown = sorted(path for path in files if path.lower().endswith(".md"))
    if not markdown:
        raise UserError("Fixed source revision contains no tracked Markdown files")
    commit_date = git(repository, "show", "-s", "--format=%cs", revision).strip()
    return markdown, commit_date


def load_config(path_text: str) -> tuple[str, Path, str, Path]:
    path = Path(path_text).resolve()
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise UserError(f"Cannot read Producer Project config: {error}") from error
    required = {"project_id", "repository", "revision", "publish_dir"}
    missing = sorted(required - config.keys())
    if missing:
        raise UserError(f"Missing config fields: {', '.join(missing)}")
    if any(not isinstance(config[key], str) or not config[key].strip() for key in required):
        raise UserError("Producer Project config fields must be non-empty strings")
    repository = Path(config["repository"])
    publish_dir = Path(config["publish_dir"])
    if not repository.is_absolute():
        repository = path.parent / repository
    if not publish_dir.is_absolute():
        publish_dir = path.parent / publish_dir
    return config["project_id"], repository.resolve(), config["revision"], publish_dir.absolute()


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


def render_bundle(
    staging: Path,
    project_id: str,
    revision: str,
    markdown_files: list[str],
    commit_date: str,
) -> None:
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "reports").mkdir(parents=True)
    (staging / "index.md").write_text(
        f"# {project_id} Knowledge Bundle\n\n"
        "* [Overview](overview.md) - Fixed-revision source overview.\n"
        "* [Coverage Report](reports/coverage.md) - Major obligation disposition.\n",
        encoding="utf-8",
    )
    (staging / "log.md").write_text(
        "# Bundle Update Log\n\n"
        f"## {commit_date}\n"
        f"* **Creation**: Staged the bundle for source revision `{revision}`.\n",
        encoding="utf-8",
    )
    (staging / "overview.md").write_text(
        frontmatter(
            "Overview",
            f"{project_id} Overview",
            "Overview of the fixed source revision.",
            revision,
        )
        + f"\n# Overview\n\nProducer Project `{project_id}` covers "
        f"{len(markdown_files)} tracked Markdown document(s) at revision `{revision}`.\n",
        encoding="utf-8",
    )
    covered = "\n".join(f"* `{path}` — covered" for path in markdown_files)
    (staging / "reports" / "coverage.md").write_text(
        frontmatter(
            "Coverage Report",
            "Coverage Report",
            "Disposition of Major Coverage Obligations.",
            revision,
            major_obligations=len(markdown_files),
            covered_obligations=len(markdown_files),
            open_obligations=0,
        )
        + "\n# Coverage Report\n\n"
        + covered
        + "\n",
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
    for field in ("major_obligations", "covered_obligations"):
        value = coverage.get(field)
        if type(value) is not int or value < 0:
            errors.append(f"reports/coverage.md: {field} must be a non-negative integer")
    major_obligations = coverage.get("major_obligations")
    covered_obligations = coverage.get("covered_obligations")
    if (
        type(major_obligations) is int
        and type(covered_obligations) is int
        and major_obligations != covered_obligations
    ):
        errors.append("reports/coverage.md: all Major Obligations must be covered")
    open_obligations = coverage.get("open_obligations")
    if type(open_obligations) is not int or open_obligations != 0:
        errors.append("reports/coverage.md: open_obligations must be the integer 0")
    if expected_coverage is not None:
        for report_field, ledger_field in {
            "major_obligations": "major",
            "covered_obligations": "covered",
            "open_obligations": "open",
        }.items():
            if coverage.get(report_field) != expected_coverage.get(ledger_field):
                errors.append(f"reports/coverage.md: {report_field} does not match run coverage")
    return errors


def build(config_path: str) -> int:
    project_id, repository, revision, publish_dir = load_config(config_path)
    run_id = uuid.uuid4().hex
    staging = state_dir() / "runs" / run_id / "staging"
    connection = connect()
    initialize(connection)
    create_run(connection, run_id, project_id, repository, revision, publish_dir, staging)
    state = "preparing"
    try:
        markdown_files, commit_date = inspect_source(repository, revision)
        coverage = {"covered": len(markdown_files), "major": len(markdown_files), "open": 0}
        transition(connection, run_id, state, "rendering", coverage=coverage)
        state = "rendering"
        render_bundle(staging, project_id, revision, markdown_files, commit_date)
        transition(connection, run_id, state, "checking")
        state = "checking"
        errors = validate_bundle(staging, revision, coverage)
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
                "details": json.loads(event["details"]),
                "occurred_at": event["occurred_at"],
                "previous_state": event["previous_state"],
                "sequence": event["sequence"],
                "state": event["state"],
            }
            for event in connection.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
            )
        ]
    emit(
        {
            "coverage": json.loads(row["coverage_json"]) if row["coverage_json"] else None,
            "error": row["error"],
            "events": events,
            "ok": True,
            "project_id": row["project_id"],
            "published_bundle": row["publish_dir"],
            "run_id": row["id"],
            "source": {"repository": row["repository"], "revision": row["revision"]},
            "staging_bundle": row["staging_dir"],
            "state": row["state"],
        }
    )
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


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="okf-wiki")
    subcommands = command.add_subparsers(dest="command", required=True)
    build_command = subcommands.add_parser("build")
    build_command.add_argument("project_config")
    status_command = subcommands.add_parser("status")
    status_command.add_argument("run_id")
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
        if arguments.command == "check":
            return check(arguments.target)
        if arguments.command == "review":
            return review(arguments.run_id, arguments.approve)
        return cancel(arguments.run_id)
    except UserError as error:
        emit({"errors": [str(error)], "ok": False})
        return 1
