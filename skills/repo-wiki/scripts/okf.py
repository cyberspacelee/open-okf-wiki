#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pydantic>=2.12,<3",
#   "PyYAML>=6,<7",
#   "psycopg[binary]>=3.2,<4",
# ]
# ///
"""Deterministic kernel for the repo-wiki v3 skill."""

import argparse
import hashlib
import json
import pathlib
import secrets
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path.cwd()
MAX_ISSUES = 50


def emit(data, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
    elif isinstance(data, dict):
        for key, value in data.items():
            print(f"{key}: {value}")
    else:
        print(data)


def emit_issues(issues: list[dict], as_json: bool) -> int:
    errors = [item for item in issues if item.get("severity") == "error"]
    if as_json:
        print(
            json.dumps(
                {"errors": len(errors), "total": len(issues), "issues": issues},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in issues[:MAX_ISSUES]:
            line = f":{item['line']}" if item.get("line") else ""
            print(
                f"{item['severity']}[{item['code']}] {item['path']}{line}: {item['message']}"
            )
        if len(issues) > MAX_ISSUES:
            print(f"... and {len(issues) - MAX_ISSUES} more; use --json")
        print(f"{len(errors)} error(s), {len(issues) - len(errors)} warning(s)")
    return 1 if errors else 0


def cmd_workspace(args) -> int:
    import _workspace

    if args.action == "init":
        workspace = _workspace.init(ROOT, args.lang, args.freshness_days)
        emit(
            {
                "workspace": str(workspace.root),
                "language": workspace.language,
                "freshness_days": workspace.freshness_days,
                "sources": sorted(workspace.sources),
            },
            args.json,
        )
    else:
        workspace = _workspace.load(ROOT)
        emit(
            {
                "version": 3,
                "language": workspace.language,
                "freshness_days": workspace.freshness_days,
                "sources": {
                    name: source.__dict__ for name, source in workspace.sources.items()
                },
            },
            args.json,
        )
    return 0


def cmd_source(args) -> int:
    import _workspace

    if args.action == "list":
        workspace = _workspace.load(ROOT)
        emit(
            {name: source.__dict__ for name, source in workspace.sources.items()},
            args.json,
        )
        return 0
    if args.kind == "git":
        if not args.target:
            raise _workspace.WorkspaceError("Git source requires a path or URL")
        source = _workspace.add_git_source(ROOT, args.target, args.name)
    else:
        source = _workspace.add_postgres_source(
            ROOT,
            args.name,
            args.url_env,
            args.schema,
            args.table or [],
        )
    emit(source.__dict__, args.json)
    return 0


def cmd_run(args) -> int:
    import _state

    if args.action == "start":
        result = _state.start_run(ROOT, args.producer, args.session)
    elif args.action == "status":
        result = _state.status(ROOT)
    else:
        result = _state.abandon(ROOT)
    emit(result, args.json)
    return 0


def cmd_task(args) -> int:
    import _state

    if args.action == "start":
        result = _state.task_start(ROOT, args.target)
    elif args.action == "complete":
        result = _state.task_complete(ROOT, args.target)
        if not result.get("ok"):
            return emit_issues(result["issues"], args.json)
    else:
        result = _state.task_fail(ROOT, args.target, args.reason or "")
    emit(result, args.json)
    return 0


def cmd_review(args) -> int:
    import _state

    if args.action == "start":
        result = _state.review_start(ROOT, args.actor, args.session)
    else:
        result = _state.review_submit(ROOT, pathlib.Path(args.report).resolve())
    emit(result, args.json)
    return 0


def cmd_publication(args) -> int:
    import _publish

    if args.action == "publish":
        result = _publish.publish(ROOT)
    elif args.action == "current":
        result = _publish.current(ROOT) or {"publication": None}
    elif args.action == "rollback":
        result = _publish.rollback(ROOT)
    elif args.action == "export":
        result = _publish.export(ROOT, ROOT / args.to)
    else:
        result = _publish.gc(ROOT)
    emit(result, args.json)
    return 0


def cmd_validate(args) -> int:
    import _publish
    import _state
    import _validate

    if args.published:
        current = _publish.current(ROOT)
        if current is None:
            raise _publish.PublishError("nothing has been published")
        issues = _validate.validate_publication(ROOT, pathlib.Path(current["path"]))
    else:
        state = _state.read(ROOT)
        if state is None:
            raise _state.StateError("no run")
        issues = _validate.validate_candidate(
            ROOT, state, published=state["status"] in ("approved", "published")
        )
    return emit_issues(issues, args.json)


def cmd_db(args) -> int:
    import _db

    url = _db.resolve_url(ROOT, args.url_env)
    result = (
        _db.tables(url, args.schema)
        if args.action == "tables"
        else _db.describe(
            url,
            args.table,
            args.schema,
        )
    )
    emit(result, args.json)
    return 0


def cmd_receipt(args) -> int:
    import _state
    import _workspace

    state = _state.read(ROOT)
    if state is None or state["status"] != "active":
        raise _state.StateError("receipt commands require an active run")
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("receipt run requires a command after --", file=sys.stderr)
        return 2
    workspace = _workspace.load(ROOT)
    source = workspace.sources.get(args.source)
    if source is None or source.kind != "git" or source.path is None:
        raise _workspace.WorkspaceError(f"unknown Git source: {args.source}")
    started = datetime.now(timezone.utc)
    result = subprocess.run(
        command, cwd=source.path, capture_output=True, text=True, check=False
    )
    receipt_id = f"cmd-{started.strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(2)}"
    receipt = {
        "id": receipt_id,
        "source": args.source,
        "argv": command,
        "platform": sys.platform,
        "started_at": started.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "exit_code": result.returncode,
        "stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(),
        "stderr_sha256": hashlib.sha256(result.stderr.encode()).hexdigest(),
    }
    path = _state.run_dir(ROOT, state["run_id"]) / "receipts" / f"{receipt_id}.json"
    path.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    emit({"receipt": str(path), **receipt}, args.json)
    if result.returncode:
        if result.stdout:
            print(result.stdout, file=sys.stderr, end="")
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
    return result.returncode


def cmd_verify(args) -> int:
    import _publish

    result = _publish.verify(ROOT, args.actor, args.page)
    emit(result, args.json)
    return 0


def leaf(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument("--json", action="store_true")
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="okf")
    commands = parser.add_subparsers(dest="command", required=True)

    workspace = commands.add_parser("workspace")
    workspace_actions = workspace.add_subparsers(dest="action", required=True)
    init = leaf(workspace_actions.add_parser("init"))
    init.add_argument("--lang", choices=("en", "zh"), default="en")
    init.add_argument("--freshness-days", type=int, default=90)
    leaf(workspace_actions.add_parser("show"))

    source = commands.add_parser("source")
    source_actions = source.add_subparsers(dest="action", required=True)
    add = leaf(source_actions.add_parser("add"))
    add.add_argument("--kind", choices=("git", "postgres"), required=True)
    add.add_argument("--name", required=True)
    add.add_argument("target", nargs="?", default="")
    add.add_argument("--url-env", default="DATABASE_URL")
    add.add_argument("--schema", default="public")
    add.add_argument("--table", action="append")
    leaf(source_actions.add_parser("list"))

    run = commands.add_parser("run")
    run_actions = run.add_subparsers(dest="action", required=True)
    start = leaf(run_actions.add_parser("start"))
    start.add_argument("--producer", required=True)
    start.add_argument("--session", required=True)
    leaf(run_actions.add_parser("status"))
    leaf(run_actions.add_parser("abandon"))

    task = commands.add_parser("task")
    task_actions = task.add_subparsers(dest="action", required=True)
    for action in ("start", "complete"):
        target = leaf(task_actions.add_parser(action))
        target.add_argument("target")
    fail = leaf(task_actions.add_parser("fail"))
    fail.add_argument("target")
    fail.add_argument("--reason")

    review = commands.add_parser("review")
    review_actions = review.add_subparsers(dest="action", required=True)
    review_start = leaf(review_actions.add_parser("start"))
    review_start.add_argument("--actor", required=True)
    review_start.add_argument("--session", required=True)
    review_submit = leaf(review_actions.add_parser("submit"))
    review_submit.add_argument("--report", required=True)

    publication = commands.add_parser("publication")
    publication_actions = publication.add_subparsers(dest="action", required=True)
    for action in ("publish", "current", "rollback", "gc"):
        leaf(publication_actions.add_parser(action))
    export = leaf(publication_actions.add_parser("export"))
    export.add_argument("--to", default="wiki")

    validate = leaf(commands.add_parser("validate"))
    validate.add_argument("--published", action="store_true")

    db = commands.add_parser("db")
    db_actions = db.add_subparsers(dest="action", required=True)
    tables = leaf(db_actions.add_parser("tables"))
    tables.add_argument("--url-env", default="DATABASE_URL")
    tables.add_argument("--schema", default="public")
    describe = leaf(db_actions.add_parser("describe"))
    describe.add_argument("table")
    describe.add_argument("--url-env", default="DATABASE_URL")
    describe.add_argument("--schema", default="public")

    receipt = commands.add_parser("receipt")
    receipt_actions = receipt.add_subparsers(dest="action", required=True)
    receipt_run = leaf(receipt_actions.add_parser("run"))
    receipt_run.add_argument("--source", required=True)
    receipt_run.add_argument("command", nargs=argparse.REMAINDER)

    verify = leaf(commands.add_parser("verify"))
    verify.add_argument("--actor", required=True)
    verify.add_argument("--page", action="append", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    handlers = {
        "workspace": cmd_workspace,
        "source": cmd_source,
        "run": cmd_run,
        "task": cmd_task,
        "review": cmd_review,
        "publication": cmd_publication,
        "validate": cmd_validate,
        "db": cmd_db,
        "receipt": cmd_receipt,
        "verify": cmd_verify,
    }
    try:
        return handlers[args.command](args)
    except Exception as exc:
        if type(exc).__name__ in {
            "WorkspaceError",
            "StateError",
            "PublishError",
            "DbError",
        }:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    raise SystemExit(main())
