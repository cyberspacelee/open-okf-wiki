#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "PyYAML>=6,<7",
#   "psycopg[binary]>=3.2,<4",
# ]
# ///
"""Deterministic kernel for the repo-wiki skill. Run from the repository root
(the hub root in hub mode); status, validate and impact also run from below it."""

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _config
import _git
import _page

MAX_SHOWN = 50


def root() -> pathlib.Path:
    return pathlib.Path.cwd()


def workspace_root() -> pathlib.Path:
    """The workspace root for the read-only commands (status, validate, impact):
    the git toplevel of the current directory, or the hub root when that toplevel
    is a configured source of an enclosing hub. Commands that write still run
    from the root itself."""
    cwd = root().resolve()
    top = _git.toplevel(cwd)
    if top is None:
        return cwd  # load reports that this is not a git repository
    return _config.enclosing_hub(top) or top


def workspace(args) -> _config.Workspace:
    return _config.load(root(), args.wiki)


def emit(data, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
        return
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, (list, dict)):
                value = json.dumps(value, ensure_ascii=False, default=str)
            print(f"{key}: {value}")
    else:
        print(data)


def emit_issues(issues: list[dict], as_json: bool, extra: dict | None = None) -> int:
    errors = sum(i["severity"] == "error" for i in issues)
    pending = sum(i["severity"] == "pending" for i in issues)
    warnings = sum(i["severity"] == "warning" for i in issues)
    if as_json:
        emit({"errors": errors, "pending": pending, "warnings": warnings, "issues": issues} | (extra or {}), True)
    else:
        for item in issues[:MAX_SHOWN]:
            where = item["page"] or "-"
            if item.get("line"):
                where += f":{item['line']}"
            print(f"{item['severity']}[{item['code']}] {where}: {item['message']}\n  fix: {item['fix']}")
        if len(issues) > MAX_SHOWN:
            print(f"... and {len(issues) - MAX_SHOWN} more; use --json")
        print(f"{errors} error(s), {pending} pending, {warnings} warning(s)")
    return 1 if errors else 0


# --- commands ----------------------------------------------------------------------


def cmd_init(args) -> int:
    if bool(args.source) != args.hub:
        raise _config.ConfigError("--hub needs at least one --source NAME, and --source needs --hub")
    ws = _config.init(root(), args.wiki or "docs/wiki", args.lang, args.source if args.hub else None)
    emit(
        {
            "wiki": ws.wiki_rel,
            "config": f"{ws.wiki_rel}/{_config.CONFIG}",
            "pages": [f"{ws.wiki_rel}/{p}" for p in _page.CANON.values()],
            "next": "okf status --json",
        },
        args.json,
    )
    return 0


def cmd_status(args) -> int:
    import _status

    emit(_status.status(workspace_root(), args.wiki), args.json)
    return 0


def cmd_scan(args) -> int:
    import _scan

    emit(_scan.scan(workspace(args)), True)
    return 0


def cmd_new(args) -> int:
    ws = workspace(args)
    path = args.path.removeprefix(ws.wiki_rel + "/")
    page = _page.new_page(ws, path, args.type, args.description, args.scope or (), args.title)
    emit({"page": f"{ws.wiki_rel}/{page.path}", "type": page.type, "scope": page.scope}, args.json)
    return 0


def cmd_validate(args) -> int:
    import _validate

    ws = _config.load(workspace_root(), args.wiki)
    only = None
    if args.paths:
        only = [p.replace("\\", "/").removeprefix("./").removeprefix(ws.wiki_rel + "/") for p in args.paths]
        missing = [p for p in only if not _page.is_page_path(p) or not (ws.wiki / p).is_file()]
        if missing:
            raise _page.PageError(
                f"not a wiki page: {', '.join(missing)}; pass page paths such as "
                "modules/billing.md (relative to the wiki directory)"
            )
    issues = _validate.validate(ws, only=only)
    return emit_issues([i.to_dict() for i in issues], args.json)


def cmd_review(args) -> int:
    import _review

    ws = workspace(args)
    pages = _page.load_pages(ws)
    if not _review.drafts(pages):
        emit({"pages": [], "message": "no draft pages; nothing to review"}, args.json)
        return 0
    state, report = _review.state(ws, pages)
    result = _review.subject(ws, pages) | {"state": state}
    if report and state in ("changes_requested", "stale"):
        result["previous_issues"] = len(report.get("issues") or [])
    emit(result, args.json)
    return 0


def cmd_stamp(args) -> int:
    import _stamp

    ws = workspace(args)
    result = _stamp.stamp(ws, args.by, args.unreviewed)
    if result["blocked"]:
        return emit_issues(result["blocked"], args.json, {"stamped": []}) or 1
    if args.json:
        emit(result, True)
        return 0
    emit({k: v for k, v in result.items() if k not in ("warnings", "blocked")}, False)
    for item in result["warnings"]:
        where = item["page"] or "-"
        if item.get("line"):
            where += f":{item['line']}"
        print(f"warning[{item['code']}] {where}: {item['message']}")
    print(f"{len(result['warnings'])} warning(s) remain; they do not block a stamp")
    return 0


def cmd_impact(args) -> int:
    import _impact

    ws = _config.load(workspace_root(), args.wiki)
    if not args.files:
        emit(_impact.impact(ws), args.json)
        return 0
    # Relative paths start from the current directory (source-relative inside a hub
    # source, repository-relative at the root).
    base = root().resolve()
    emit(_impact.impact_files(ws, [_relative(ws, p, base) for p in args.files]), args.json)
    return 0


def _relative(ws: _config.Workspace, path: str, base: pathlib.Path) -> str:
    """A path as given on the command line, made relative to the workspace root.

    A relative path is relative to ``base``, the current directory: inside a hub
    source it gets the source prefix, in a subdirectory the subdirectory prefix."""
    candidate = pathlib.Path(path)
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        return _posix_relative(candidate, ws.root)
    except ValueError:
        raise _config.ConfigError(
            f"{path} is outside {ws.root}; pass paths inside the workspace"
        ) from None


def _posix_relative(path: pathlib.Path, root: pathlib.Path) -> str:
    """``path`` relative to ``root``, without resolving the file itself (it may be deleted)."""
    import os

    rel = pathlib.Path(os.path.normpath(path.parent.resolve() / path.name)).relative_to(root)
    return rel.as_posix()


def cmd_update(args) -> int:
    import _impact

    emit(_impact.update(workspace(args)), args.json)
    return 0


def cmd_verify(args) -> int:
    import _stamp

    emit(_stamp.verify(workspace(args), args.actor, args.pages), args.json)
    return 0


def cmd_pointer(args) -> int:
    import _stamp

    ws = workspace(args)
    if args.write:
        emit(_stamp.write_pointer(ws, args.write), args.json)
    else:
        print(_stamp.pointer(ws), end="")
    return 0


def cmd_db(args) -> int:
    import _db

    ws_root = root()
    url = _db.resolve_url(ws_root, args.url_env)
    if args.action == "tables":
        emit(_db.tables(url, args.schema), args.json)
        return 0
    if args.action == "describe":
        emit(_db.describe(url, args.table, args.schema), args.json)
        return 0
    import _dbpages
    import _files
    import _stamp

    ws = workspace(args)
    capture = _db.capture(url, args.schema, args.table)
    rendered = _dbpages.render_all(args.name, capture, ws.lang, args.into, _stamp.now())
    written = []
    for rel, text in sorted(rendered.items()):
        file = ws.wiki / rel
        if not file.is_file() or file.read_text(encoding="utf-8") != text:
            _files.atomic_text(file, text)
            written.append(f"{ws.wiki_rel}/{rel}")
    emit({"pages": [f"{ws.wiki_rel}/{rel}" for rel in sorted(rendered)], "written": written}, args.json)
    return 0


# --- parser ------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="okf", description=__doc__)
    parser.add_argument("--wiki", help="wiki directory (the one holding repo-wiki.yaml)")
    commands = parser.add_subparsers(dest="command", required=True)

    def add(name, func, help):
        sub = commands.add_parser(name, help=help)
        # Also accepted after the subcommand (`okf init --wiki DIR`); SUPPRESS keeps a
        # value given before the subcommand when this one is absent.
        sub.add_argument("--wiki", default=argparse.SUPPRESS, help="wiki directory (as the global option)")
        sub.add_argument("--json", action="store_true", help="emit JSON")
        sub.set_defaults(func=func)
        return sub

    init = add("init", cmd_init, "create repo-wiki.yaml and the canon page stubs")
    init.add_argument("--lang", choices=_config.LANGS, default="en")
    init.add_argument("--hub", action="store_true", help="the wiki documents several child repositories")
    init.add_argument("--source", action="append", help="hub source directory (repeatable)")

    add("status", cmd_status, "derived phase and next actions")
    add("scan", cmd_scan, "repository facts at HEAD (JSON on stdout)")

    new = add("new", cmd_new, "create a draft page stub")
    new.add_argument("path", help="wiki-relative page path such as modules/billing.md")
    new.add_argument("--type", required=True, choices=_page.AUTHOR_TYPES)
    new.add_argument("--description", required=True, help='when to read it: "Read before ..."')
    new.add_argument("--title")
    new.add_argument("--scope", action="append", help="source glob (repeatable)")

    validate = add("validate", cmd_validate, "check every page; exit 1 on errors")
    validate.add_argument("paths", nargs="*", help="report only these pages")

    review = add("review", cmd_review, "review subject for the independent reviewer")
    review.add_argument("action", choices=["prepare"])

    stamp = add("stamp", cmd_stamp, "stamp reviewed drafts stable and rewrite index.md")
    stamp.add_argument("--by", required=True, help="producer actor, e.g. repo-wiki/<model>")
    stamp.add_argument("--unreviewed", action="store_true", help="stamp without an independent review")

    impact = add("impact", cmd_impact, "stale pages since their revision, or pages covering files")
    impact.add_argument("--files", nargs="+", help="paths you are about to change")

    add("update", cmd_update, "redraft stale pages with the changes in a todo block")

    verify = add("verify", cmd_verify, "record a human review of stamped pages")
    verify.add_argument("--actor", required=True, help="human:<id>")
    verify.add_argument("pages", nargs="+")

    pointer = add("pointer", cmd_pointer, "print (or write) the AGENTS.md pointer block")
    pointer.add_argument("--write", metavar="FILE", help="replace or append the block in FILE")

    db = add("db", cmd_db, "OpenGauss extension: inspect a schema or capture tables as pages")
    db.add_argument("action", choices=["tables", "describe", "capture"])
    db.add_argument("table", nargs="?", help="table name for describe")
    db.add_argument("--url-env", required=True, help="variable holding an opengauss:// URL")
    db.add_argument("--schema", default="public")
    db.add_argument("--table", dest="tables", action="append", help="table to capture (repeatable)")
    db.add_argument("--name", help="database name used in page paths and titles")
    db.add_argument("--into", default="reference", help="wiki directory for the pages")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "db":
        if args.action == "describe" and not args.table:
            print("okf db describe needs a TABLE argument", file=sys.stderr)
            return 2
        if args.action == "capture":
            if not args.tables or not args.name:
                print("okf db capture needs --table (repeatable) and --name", file=sys.stderr)
                return 2
            args.table = args.tables
    import _db
    import _impact
    import _stamp

    expected = (
        _config.ConfigError, _config.LocatorError, _page.PageError, _git.GitError,
        _stamp.StampError, _impact.ImpactError, _db.DbError,
    )
    try:
        return args.func(args)
    except expected as exc:
        return _fail(args, str(exc))
    except OSError as exc:
        # A command that fails midway has already rolled back what it wrote (init's undo
        # runs on any exception); report the file problem instead of a traceback.
        return _fail(args, os_error_message(exc))


def os_error_message(exc: OSError) -> str:
    """One user-facing line: what failed, on which path, and how to fix it."""
    # A failed rename (the atomic write's temp file -> target) names the target.
    where = next((f for f in (exc.filename2, exc.filename) if f is not None), "a file")
    reason = exc.strerror or type(exc).__name__
    if isinstance(exc, IsADirectoryError):
        fix = "pass a file path, not a directory"
    elif isinstance(exc, NotADirectoryError):
        fix = "a parent of that path is a file; pass a path under a directory"
    elif isinstance(exc, PermissionError):
        fix = "make the path writable (check its permissions and owner) and rerun"
    elif isinstance(exc, FileNotFoundError):
        fix = "create the missing file or directory, or pass an existing path, and rerun"
    else:
        fix = "fix the file system problem at that path and rerun"
    return f"cannot access {where}: {reason} ({type(exc).__name__}); {fix}"


def _fail(args, message: str) -> int:
    if getattr(args, "json", False):
        print(json.dumps({"error": message}, ensure_ascii=False))
    else:
        print(f"okf: {message}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
