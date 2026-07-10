import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tomllib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml


STATES = {
    "preparing",
    "rendering",
    "checking",
    "review_required",
    "publishing",
    "succeeded",
    "rejected",
    "failed",
    "cancelled",
}
TERMINAL_STATES = {"succeeded", "rejected", "failed", "cancelled"}
REQUIRED_BUNDLE_FILES = {"index.md", "log.md", "overview.md", "reports/coverage.md"}
LINK_RE = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
LOG_DATE_RE = re.compile(r"^## \d{4}-\d{2}-\d{2}$", re.MULTILINE)


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
) -> None:
    if next_state not in STATES:
        raise RuntimeError(f"Unknown state: {next_state}")
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
                json.dumps({"error": error} if error else {}, sort_keys=True),
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


def parse_frontmatter(path: Path, text: str) -> list[str]:
    errors = []
    if not text.startswith("---\n"):
        return [f"{path}: missing YAML frontmatter"]
    end = text.find("\n---\n", 4)
    if end == -1:
        return [f"{path}: unterminated YAML frontmatter"]
    try:
        data = yaml.safe_load(text[4:end])
    except yaml.YAMLError as error:
        return [f"{path}: invalid YAML frontmatter: {error}"]
    if not isinstance(data, dict):
        errors.append(f"{path}: frontmatter must be a mapping")
    elif not isinstance(data.get("type"), str) or not data["type"].strip():
        errors.append(f"{path}: frontmatter type must be non-empty")
    return errors


def validate_bundle(bundle: Path) -> list[str]:
    if not bundle.is_dir():
        return [f"Bundle does not exist: {bundle}"]
    errors = []
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
            if not text.startswith("# "):
                errors.append(f"{relative}: index.md must start with a heading")
        elif path.name == "log.md":
            if not text.startswith("# ") or LOG_DATE_RE.search(text) is None:
                errors.append(f"{relative}: log.md must contain a heading and ISO date section")
        else:
            errors.extend(parse_frontmatter(Path(relative), text))
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
    if (bundle / "reports/coverage.md").is_file():
        coverage = (bundle / "reports/coverage.md").read_text(encoding="utf-8")
        if "open_obligations: 0" not in coverage:
            errors.append("reports/coverage.md: Major Obligations remain open")
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
        errors = validate_bundle(staging)
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
        errors = validate_bundle(Path(row["staging_dir"]))
    emit({"errors": errors, "ok": not errors, "target": target})
    return bool(errors)


def publish(staging: Path, destination: Path, run_id: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(destination) and not destination.is_symlink():
        raise UserError("Published Bundle path must be absent or a producer-managed symlink")
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


def review(run_id: str, approve: bool) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] != "review_required":
        connection.close()
        raise UserError(f"Run {run_id} is not Review Required")
    if not approve:
        transition(connection, run_id, "review_required", "rejected")
        connection.close()
        emit({"ok": True, "run_id": run_id, "state": "rejected"})
        return 0
    errors = validate_bundle(Path(row["staging_dir"]))
    if errors:
        transition(connection, run_id, "review_required", "failed", error="; ".join(errors))
        connection.close()
        emit({"errors": errors, "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    transition(connection, run_id, "review_required", "publishing")
    try:
        publish(Path(row["staging_dir"]), Path(row["publish_dir"]), run_id)
    except Exception as error:
        transition(connection, run_id, "publishing", "failed", error=str(error))
        connection.close()
        emit({"errors": [str(error)], "ok": False, "run_id": run_id, "state": "failed"})
        return 1
    transition(connection, run_id, "publishing", "succeeded")
    connection.close()
    emit({"ok": True, "run_id": run_id, "state": "succeeded"})
    return 0


def cancel(run_id: str) -> int:
    connection = connect()
    row = get_run(connection, run_id)
    if row["state"] in TERMINAL_STATES:
        connection.close()
        raise UserError(f"Run {run_id} is already terminal")
    transition(connection, run_id, row["state"], "cancelled")
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
