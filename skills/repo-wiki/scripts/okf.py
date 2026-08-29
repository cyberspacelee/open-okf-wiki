#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pydantic>=2.12,<3",
#   "PyYAML>=6,<7",
#   "psycopg[binary]>=3.2,<4",
# ]
# ///
"""Deterministic kernel for the repo-wiki skill."""

import argparse
import json
import pathlib
import sys

MAX_ISSUES = 50


def workspace_root() -> pathlib.Path:
    return pathlib.Path.cwd()


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
        workspace = _workspace.init(workspace_root(), args.lang, args.freshness_days)
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
        workspace = _workspace.load(workspace_root())
        emit(
            {
                "version": _workspace.VERSION,
                "language": workspace.language,
                "freshness_days": workspace.freshness_days,
                "sources": {
                    name: source.to_dict() for name, source in workspace.sources.items()
                },
            },
            args.json,
        )
    return 0


def cmd_source(args) -> int:
    import _workspace

    if args.action == "list":
        workspace = _workspace.load(workspace_root())
        emit(
            {name: source.to_dict() for name, source in workspace.sources.items()},
            args.json,
        )
        return 0
    root = workspace_root()
    if args.kind == "link":
        source = _workspace.add_git_link(root, args.target, args.name)
    elif args.kind == "clone":
        source = _workspace.add_git_clone(root, args.target, args.name, args.ref)
    elif args.kind == "files":
        source = _workspace.add_files_source(root, args.target, args.name)
    else:
        source = _workspace.add_opengauss_source(
            root,
            args.name,
            args.url_env,
            args.schema,
            args.table or [],
        )
    emit(source.to_dict(), args.json)
    return 0


def cmd_run(args) -> int:
    import _state

    root = workspace_root()
    if args.action == "start":
        result = _state.start_run(root)
    elif args.action == "status":
        result = _state.status(root)
    elif args.action == "block":
        result = _state.block(root, args.reason)
    elif args.action == "resume":
        result = _state.resume(root)
    else:
        result = _state.abandon(root)
    emit(result, args.json)
    return 0


def cmd_evidence(args) -> int:
    import _state

    root = workspace_root()
    if args.action == "outline":
        result = _state.evidence_outline(
            root,
            source=args.source,
            path=args.path,
            after=args.after,
        )
    elif args.action == "search":
        result = _state.evidence_search(
            root,
            source=args.source,
            query=args.pattern,
            path=args.path,
        )
    else:
        result = _state.evidence_read(root, args.locator)
    emit(result, args.json)
    return 0


def cmd_review(args) -> int:
    import _state

    result = (
        _state.review_prepare(workspace_root())
        if args.action == "prepare"
        else _state.review_complete(workspace_root())
    )
    if not result.get("ok"):
        return emit_issues(result["issues"], args.json)
    emit(result, args.json)
    return 0


def cmd_publication(args) -> int:
    import _publish

    root = workspace_root()
    if args.action == "publish":
        result = _publish.publish(root)
    elif args.action == "current":
        result = _publish.current(root) or {"publication": None}
    elif args.action == "rollback":
        result = _publish.rollback(root)
    elif args.action == "verify":
        result = _publish.verify(root, args.actor, args.page)
    elif args.action == "prune":
        result = _publish.prune(root, args.keep)
    else:
        result = _publish.export(root, root / args.to)
    emit(result, args.json)
    return 0


def cmd_validate(args) -> int:
    import _publish
    import _state
    import _validate

    root = workspace_root()
    if args.published:
        current = _publish.current(root)
        if current is None:
            raise _publish.PublishError("nothing has been published")
        issues = _validate.validate_publication(root, pathlib.Path(current["path"]))
    else:
        state = _state.read(root)
        if state is None:
            raise _state.StateError("no run")
        issues = _validate.validate_candidate(
            root, state, published=state["status"] in ("approved", "published")
        )
    return emit_issues([item.to_dict() for item in issues], args.json)


def cmd_db(args) -> int:
    import _db

    url = _db.resolve_url(workspace_root(), args.url_env)
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


def cmd_catalog(args) -> int:
    import _db
    import _state

    root = workspace_root()
    state = _state.read(root)
    if state is None:
        raise _state.StateError("no run")
    catalogs = state.get("catalogs") or []
    if args.action == "show":
        emit(_db.show_captured(root, catalogs, args.source), args.json)
        return 0
    result = _db.describe_captured(root, catalogs, args.table, args.source)
    emit(result, args.json)
    return 0


def cmd_propose(args) -> int:
    import _state

    root = workspace_root()
    if args.action == "start":
        result = _state.propose_start(root)
    else:
        result = _state.propose_complete(root)
        if not result.get("ok"):
            return emit_issues(result["issues"], args.json)
    emit(result, args.json)
    return 0


def leaf(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument(
        "--json", action="store_true", help="emit machine-readable JSON"
    )
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="okf",
        description=(
            "Deterministic kernel for the repo-wiki skill: owns workspace "
            "sources, run state, validation gates and publication. Run from "
            "the workspace root."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)

    workspace = commands.add_parser("workspace", help="create or inspect the workspace")
    workspace_actions = workspace.add_subparsers(dest="action", required=True)
    init = leaf(
        workspace_actions.add_parser(
            "init", help="create an empty workspace in the current directory"
        )
    )
    init.add_argument(
        "--lang", choices=("en", "zh"), default="en", help="wiki output language"
    )
    init.add_argument(
        "--freshness-days",
        type=int,
        default=90,
        help="days before published pages become stale",
    )
    leaf(workspace_actions.add_parser("show", help="show workspace configuration"))

    source = commands.add_parser("source", help="register or list run inputs")
    source_actions = source.add_subparsers(dest="action", required=True)
    add = source_actions.add_parser("add", help="register a source")
    source_kinds = add.add_subparsers(dest="kind", required=True)
    link = leaf(
        source_kinds.add_parser(
            "link",
            help="register a local Git worktree (external paths mount at <name>/)",
        )
    )
    link.add_argument("target", help="path to the Git worktree")
    link.add_argument("--name", required=True, help="unique source name")
    clone = leaf(
        source_kinds.add_parser("clone", help="clone a Git URL into <workspace>/<name>")
    )
    clone.add_argument("target", help="Git URL to clone")
    clone.add_argument("--name", required=True, help="unique source name")
    clone.add_argument("--ref", help="branch, tag or commit to check out")
    opengauss = leaf(
        source_kinds.add_parser(
            "opengauss", help="register selected OpenGauss tables as evidence"
        )
    )
    opengauss.add_argument("--name", required=True, help="unique source name")
    opengauss.add_argument(
        "--url-env",
        default="DATABASE_URL",
        help="environment variable holding the connection URL",
    )
    opengauss.add_argument("--schema", default="public", help="schema to select from")
    opengauss.add_argument(
        "--table", action="append", help="table to include (repeatable)"
    )
    files = leaf(
        source_kinds.add_parser(
            "files", help="register a local directory of contract or document files"
        )
    )
    files.add_argument("target", help="path to the directory")
    files.add_argument("--name", required=True, help="unique source name")
    leaf(source_actions.add_parser("list", help="list registered sources"))
    run = commands.add_parser("run", help="start, inspect or stop a generation run")
    run_actions = run.add_subparsers(dest="action", required=True)
    leaf(
        run_actions.add_parser(
            "start", help="freeze source revisions and create fixed work artifacts"
        )
    )
    leaf(
        run_actions.add_parser(
            "status", help="derive the current phase and exact next actions"
        )
    )
    block = leaf(run_actions.add_parser("block", help="record a real external blocker"))
    block.add_argument("--reason", required=True, help="short external blocker")
    leaf(run_actions.add_parser("resume", help="resume a blocked run"))
    leaf(run_actions.add_parser("abandon", help="abandon the current run"))

    evidence = commands.add_parser(
        "evidence", help="navigate frozen Source evidence with bounded output"
    )
    evidence_actions = evidence.add_subparsers(dest="action", required=True)
    outline = leaf(
        evidence_actions.add_parser(
            "outline", help="list one bounded directory in a frozen Source"
        )
    )
    outline.add_argument("path", nargs="?", default=".", help="relative directory")
    outline.add_argument("--source", required=True, help="source name")
    outline.add_argument("--after", help="continue after an item from the prior page")
    search = leaf(
        evidence_actions.add_parser(
            "search", help="search text in a frozen Source with bounded output"
        )
    )
    search.add_argument("pattern", help="literal text, at most 256 characters")
    search.add_argument("--source", required=True, help="source name")
    search.add_argument("--path", default=".", help="relative scope path")
    read = leaf(
        evidence_actions.add_parser(
            "read", help="read one bounded locator from a frozen Source"
        )
    )
    read.add_argument("locator", help="canonical source/path#Lx-Ly locator")

    review = commands.add_parser(
        "review", help="prepare or complete one independent Wiki bundle review"
    )
    review_actions = review.add_subparsers(dest="action", required=True)
    leaf(
        review_actions.add_parser("prepare", help="bind drafts into the review bundle")
    )
    leaf(review_actions.add_parser("complete", help="validate the fixed review report"))

    publication = commands.add_parser(
        "publication", help="publish, export, verify or roll back generations"
    )
    publication_actions = publication.add_subparsers(dest="action", required=True)
    leaf(
        publication_actions.add_parser(
            "publish", help="install the approved candidate as the current generation"
        )
    )
    leaf(
        publication_actions.add_parser(
            "current", help="show the current generation pointer"
        )
    )
    leaf(
        publication_actions.add_parser(
            "rollback", help="switch back to the previous generation"
        )
    )
    export = leaf(
        publication_actions.add_parser(
            "export", help="copy the current generation to a Git-managed directory"
        )
    )
    export.add_argument("--to", default="wiki", help="export directory (default: wiki)")
    verify = leaf(
        publication_actions.add_parser(
            "verify", help="record human verification of published pages"
        )
    )
    verify.add_argument(
        "--actor", required=True, help="human identity as human:<identity>"
    )
    verify.add_argument(
        "--page", action="append", required=True, help="page path (repeatable)"
    )
    prune = leaf(
        publication_actions.add_parser(
            "prune",
            help="delete old generations; keeps current, previous and --keep newest",
        )
    )
    prune.add_argument("--keep", type=int, default=5, help="generations to retain")

    validate = leaf(
        commands.add_parser(
            "validate",
            help="validate the candidate (or the publication with --published)",
        )
    )
    validate.add_argument(
        "--published",
        action="store_true",
        help="validate the current publication instead of the run candidate",
    )

    db = commands.add_parser(
        "db", help="explore OpenGauss before selecting catalog tables"
    )
    db_actions = db.add_subparsers(dest="action", required=True)
    tables = leaf(db_actions.add_parser("tables", help="list tables in a schema"))
    tables.add_argument(
        "--url-env", default="DATABASE_URL", help="env var with the connection URL"
    )
    tables.add_argument("--schema", default="public", help="schema to list")
    describe = leaf(db_actions.add_parser("describe", help="describe one table"))
    describe.add_argument("table", help="table name")
    describe.add_argument(
        "--url-env", default="DATABASE_URL", help="env var with the connection URL"
    )
    describe.add_argument("--schema", default="public", help="schema of the table")

    catalog = commands.add_parser(
        "catalog", help="read a captured catalog without connecting to the database"
    )
    catalog_actions = catalog.add_subparsers(dest="action", required=True)
    catalog_show = leaf(
        catalog_actions.add_parser(
            "show", help="list selected tables from the current run's captured catalog"
        )
    )
    catalog_show.add_argument("--source", help="restrict to one catalog source")
    catalog_describe = leaf(
        catalog_actions.add_parser(
            "describe", help="describe one captured table, including comments"
        )
    )
    catalog_describe.add_argument("table", help="table name or page slug")
    catalog_describe.add_argument(
        "--source", help="catalog source when the name is shared"
    )

    propose = commands.add_parser(
        "propose", help="optional post-publish AGENTS/CONTEXT/ADR proposals"
    )
    propose_actions = propose.add_subparsers(dest="action", required=True)
    leaf(propose_actions.add_parser("start", help="dispatch the propose worker packet"))
    leaf(
        propose_actions.add_parser(
            "complete", help="validate proposal files; zero files is allowed"
        )
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    handlers = {
        "workspace": cmd_workspace,
        "source": cmd_source,
        "run": cmd_run,
        "evidence": cmd_evidence,
        "review": cmd_review,
        "publication": cmd_publication,
        "validate": cmd_validate,
        "db": cmd_db,
        "catalog": cmd_catalog,
        "propose": cmd_propose,
    }
    try:
        return handlers[args.command](args)
    except Exception as exc:
        import _db
        import _publish
        import _state
        import _workspace

        if isinstance(
            exc,
            (
                _workspace.WorkspaceError,
                _state.StateError,
                _publish.PublishError,
                _db.DbError,
            ),
        ):
            print(f"error: {exc}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    raise SystemExit(main())
