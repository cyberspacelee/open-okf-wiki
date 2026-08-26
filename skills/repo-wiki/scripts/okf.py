#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""okf: deterministic backbone for the repo-wiki skill.

Subcommands: init | source | state | validate | db | publish.
State may only change through `state` (see docs/adr/0003-state-gate.md).
"""

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path.cwd()
MAX_ISSUES_SHOWN = 20


def _emit(data, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
        return
    if isinstance(data, dict):
        for key, value in data.items():
            print(f"{key}: {value}")
    else:
        print(data)


def _emit_issues(issues: list[dict], as_json: bool) -> int:
    errors = [i for i in issues if i.get("severity") == "error"]
    if as_json:
        print(json.dumps({"errors": len(errors), "total": len(issues),
                          "issues": issues[:MAX_ISSUES_SHOWN]}, ensure_ascii=False, indent=2))
    else:
        for issue in issues[:MAX_ISSUES_SHOWN]:
            line = f":{issue['line']}" if issue.get("line") else ""
            print(f"{issue['severity']}[{issue['code']}] {issue['path']}{line}: {issue['message']}")
            if issue.get("suggestion"):
                print(f"  -> {issue['suggestion']}")
        hidden = len(issues) - MAX_ISSUES_SHOWN
        if hidden > 0:
            print(f"... and {hidden} more (use --json for machine output)")
        print(f"{len(errors)} error(s), {len(issues) - len(errors)} warning(s)")
    return 1 if errors else 0


def cmd_init(args) -> int:
    import _workspace
    ws = _workspace.init(ROOT, language=args.lang)
    _emit({"workspace": str(ws.root), "language": ws.language, "implicit": ws.implicit}, args.json)
    return 0


def cmd_source(args) -> int:
    import _workspace
    if args.action == "add":
        src = _workspace.add_source(ROOT, args.target, name=args.name)
        _emit({"name": src.name, "origin": src.origin, "path": str(src.path)}, args.json)
        return 0
    ws = _workspace.load(ROOT)
    _emit({name: {"origin": s.origin, "path": str(s.path)} for name, s in ws.sources.items()}, args.json)
    return 0


def cmd_state(args) -> int:
    import _state
    if args.action == "init":
        _emit(_state.init_run(ROOT), args.json)
        return 0
    if args.action == "status":
        _emit(_state.status(ROOT), args.json)
        return 0
    if args.action == "abandon":
        _state.abandon(ROOT)
        _emit({"abandoned": True}, args.json)
        return 0
    if not args.phase or not args.target:
        print("start/complete/fail require --phase and --target", file=sys.stderr)
        return 2
    if args.action == "start":
        _emit(_state.start_target(ROOT, args.phase, args.target), args.json)
        return 0
    if args.action == "complete":
        result = _state.complete_target(ROOT, args.phase, args.target)
        if not result.get("ok"):
            return _emit_issues(result.get("issues", []), args.json)
        _emit({"ok": True, "phase": args.phase, "target": args.target}, args.json)
        return 0
    if args.action == "fail":
        _emit(_state.fail_target(ROOT, args.phase, args.target, args.reason or ""), args.json)
        return 0
    return 2


def cmd_validate(args) -> int:
    import _validate
    import _workspace
    ws = _workspace.load(ROOT)
    if args.target and args.phase:
        issues = _validate.validate_target(ws, args.phase, args.target)
    else:
        issues = _validate.validate_candidate(ws)
    return _emit_issues(issues, args.json)


def cmd_db(args) -> int:
    import _db
    url = _db.resolve_url(ROOT, args.url_env)
    if args.action == "tables":
        _emit(_db.tables(url, schema=args.schema), args.json)
    else:
        if not args.table:
            print("describe requires --table", file=sys.stderr)
            return 2
        _emit(_db.describe(url, args.table, schema=args.schema), args.json)
    return 0


def cmd_publish(args) -> int:
    import _publish
    result = _publish.publish(ROOT)
    _emit(result, args.json)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="okf")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create workspace config")
    p_init.add_argument("--lang", default="en", choices=("en", "zh"))

    p_source = sub.add_parser("source", help="manage sources")
    p_source.add_argument("action", choices=("add", "list"))
    p_source.add_argument("target", nargs="?")
    p_source.add_argument("--name")

    p_state = sub.add_parser("state", help="run state machine (the only state writer)")
    p_state.add_argument("action", choices=("init", "status", "start", "complete", "fail", "abandon"))
    p_state.add_argument("--phase")
    p_state.add_argument("--target")
    p_state.add_argument("--reason")

    p_validate = sub.add_parser("validate", help="validate candidate or one target")
    p_validate.add_argument("--phase")
    p_validate.add_argument("--target")

    p_db = sub.add_parser("db", help="read-only catalog evidence")
    p_db.add_argument("action", choices=("tables", "describe"))
    p_db.add_argument("--url-env", default="DATABASE_URL")
    p_db.add_argument("--schema", default="public")
    p_db.add_argument("--table")

    sub.add_parser("publish", help="validate everything and install wiki/ transactionally")

    for p in sub.choices.values():
        p.add_argument("--json", action="store_true")

    args = parser.parse_args()
    handler = {"init": cmd_init, "source": cmd_source, "state": cmd_state,
               "validate": cmd_validate, "db": cmd_db, "publish": cmd_publish}[args.command]
    try:
        return handler(args)
    except Exception as exc:  # workspace/state/db/publish errors are user-facing
        if type(exc).__name__ in ("WorkspaceError", "StateError", "DbError", "PublishError"):
            print(f"error: {exc}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    sys.exit(main())
