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
POLICY_FIELDS = (
    "max_active_children",
    "max_children_per_run",
    "search_max_results",
    "search_max_output_bytes",
    "read_default_lines",
    "read_max_lines",
    "read_max_output_bytes",
)


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


def emit_issues(
    issues: list[dict],
    as_json: bool,
    *,
    skipped_checks: list[str] | None = None,
    current_phase: str | None = None,
) -> int:
    if current_phase is not None:
        issues = [
            {
                **item,
                "phase": item.get("phase") or current_phase,
                "applicability": (
                    "blocking"
                    if (item.get("phase") or current_phase) == current_phase
                    else "pending"
                ),
            }
            for item in issues
        ]
    errors = [item for item in issues if item.get("severity") == "error"]
    blocking_errors = (
        errors
        if current_phase is None
        else [item for item in errors if item.get("applicability") == "blocking"]
    )
    skipped_checks = skipped_checks or []
    if as_json:
        print(
            json.dumps(
                {
                    "complete": not skipped_checks,
                    "errors": len(errors),
                    "blocking_errors": len(blocking_errors),
                    "pending_errors": len(errors) - len(blocking_errors),
                    "current_phase": current_phase,
                    "warnings": len(issues) - len(errors),
                    "total": len(issues),
                    "skipped_checks": skipped_checks,
                    "issues": issues,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in issues[:MAX_ISSUES]:
            line = f":{item['line']}" if item.get("line") else ""
            applicability = (
                f" {item['applicability']}" if item.get("applicability") else ""
            )
            print(
                f"{item['severity']}[{item['code']}]{applicability} "
                f"{item['path']}{line}: {item['message']}"
            )
        if len(issues) > MAX_ISSUES:
            print(f"... and {len(issues) - MAX_ISSUES} more; use --json")
        print(f"{len(errors)} error(s), {len(issues) - len(errors)} warning(s)")
    return 1 if errors or skipped_checks else 0


def cmd_workspace(args) -> int:
    import _workspace

    if args.action == "init":
        flat_policy = {field: getattr(args, field) for field in POLICY_FIELDS}
        workspace = _workspace.init(
            workspace_root(),
            args.lang,
            args.freshness_days,
            _workspace.policy_from_flat(flat_policy),
        )
    elif args.action == "configure":
        policy_updates = {
            field: getattr(args, field)
            for field in POLICY_FIELDS
            if getattr(args, field) is not None
        }
        if args.lang is None and args.freshness_days is None and not policy_updates:
            raise _workspace.WorkspaceError(
                "workspace configure requires at least one setting"
            )
        workspace = _workspace.configure(
            workspace_root(),
            language=args.lang,
            freshness_days=args.freshness_days,
            policy_updates=policy_updates,
        )
    else:
        workspace = _workspace.load(workspace_root())
    emit(
        {
            "version": _workspace.VERSION,
            "workspace": str(workspace.root),
            "language": workspace.language,
            "freshness_days": workspace.freshness_days,
            "policy": workspace.policy.model_dump(mode="json"),
            "sources": {
                name: source.to_dict() for name, source in workspace.sources.items()
            },
        },
        args.json,
    )
    return 0


def add_policy_arguments(parser: argparse.ArgumentParser, *, defaults: bool) -> None:
    from _models import RunPolicy

    policy = RunPolicy.defaults()
    values = _workspace_flat_policy(policy) if defaults else {}
    parser.add_argument(
        "--max-active-children",
        dest="max_active_children",
        type=int,
        default=values.get("max_active_children"),
        help="maximum concurrently active repo-wiki subagents",
    )
    parser.add_argument(
        "--max-children-per-run",
        type=int,
        default=values.get("max_children_per_run"),
        help="maximum unique subagents spawned by one run",
    )
    parser.add_argument(
        "--search-max-results",
        dest="search_max_results",
        type=int,
        default=values.get("search_max_results"),
        help="maximum matches returned by one evidence search",
    )
    parser.add_argument(
        "--search-max-output-bytes",
        dest="search_max_output_bytes",
        type=int,
        default=values.get("search_max_output_bytes"),
        help="maximum UTF-8 bytes returned by one evidence search",
    )
    parser.add_argument(
        "--read-default-lines",
        dest="read_default_lines",
        type=int,
        default=values.get("read_default_lines"),
        help="default evidence read window when no end line is supplied",
    )
    parser.add_argument(
        "--read-max-lines",
        dest="read_max_lines",
        type=int,
        default=values.get("read_max_lines"),
        help="maximum lines returned by one evidence read",
    )
    parser.add_argument(
        "--read-max-output-bytes",
        dest="read_max_output_bytes",
        type=int,
        default=values.get("read_max_output_bytes"),
        help="maximum UTF-8 bytes returned by one evidence read",
    )


def _workspace_flat_policy(policy) -> dict[str, int]:
    return {
        "max_active_children": policy.agents.max_active_children,
        "max_children_per_run": policy.agents.max_children_per_run,
        "search_max_results": policy.evidence.search.max_results,
        "search_max_output_bytes": policy.evidence.search.max_output_bytes,
        "read_default_lines": policy.evidence.read.default_lines,
        "read_max_lines": policy.evidence.read.max_lines,
        "read_max_output_bytes": policy.evidence.read.max_output_bytes,
    }


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
    from _files import compact_json

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
            after=args.after,
        )
    else:
        result = _state.evidence_read(root, args.locator)
    sys.stdout.write(compact_json(result))
    return 0


def cmd_review(args) -> int:
    import _state

    if args.action == "plan":
        result = _state.plan_review_prepare(workspace_root())
    elif args.action == "composition":
        result = _state.composition_review_prepare(workspace_root())
    elif args.action == "prepare":
        result = _state.review_prepare(workspace_root())
    else:
        result = _state.review_complete(workspace_root())
    if not result.get("ok"):
        return emit_issues(result["issues"], args.json)
    emit(result, args.json)
    return 0


def cmd_plan(args) -> int:
    import _state

    result = (
        _state.plan_compile(workspace_root())
        if args.action == "compile"
        else _state.plan_inspect(workspace_root())
    )
    emit(result, args.json)
    return 0 if result.get("ok") else 1


def cmd_composition(args) -> int:
    import _state

    result = _state.composition_prepare(workspace_root())
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
        result = _validate.validate_publication(root, pathlib.Path(current["path"]))
    else:
        state = _state.read(root)
        if state is None:
            raise _state.StateError("no run")
        result = _validate.validate_candidate(
            root, state, published=state["status"] in ("approved", "published")
        )
    current_phase = "publish" if args.published else _state.status(root)["phase"]
    return emit_issues(
        [item.to_dict() for item in result.issues],
        args.json,
        skipped_checks=result.skipped_checks,
        current_phase=current_phase,
    )


def cmd_db(args) -> int:
    import _db

    url = _db.resolve_url(workspace_root(), args.url_env)
    if args.action == "tables":
        emit_tables(_db.tables(url, args.schema), args.json)
        return 0
    emit(_db.describe(url, args.table, args.schema), args.json)
    return 0


def cmd_catalog(args) -> int:
    import _db
    import _state

    root = workspace_root()
    state = _state.read(root)
    if state is None:
        raise _state.StateError("no run")
    catalogs = state.get("catalogs") or []
    if args.action == "tables":
        emit_tables(
            _db.tables_captured(root, catalogs, args.source, summary=args.summary),
            args.json,
        )
        return 0
    result = _db.describe_captured(
        root, catalogs, args.table, args.source, full=args.full
    )
    emit(result, args.json)
    return 0


def cmd_page(args) -> int:
    import _state

    result = _state.page_prepare(workspace_root(), args.page_id)
    if not result.get("ok"):
        return emit_issues(result["issues"], args.json)
    emit(result, args.json)
    return 0


def emit_tables(result: dict | list[dict], as_json: bool) -> None:
    if as_json:
        emit(result, True)
        return
    groups = result if isinstance(result, list) else [result]
    for group in groups:
        for table in group["tables"]:
            print(table)


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
    add_policy_arguments(init, defaults=True)
    configure = leaf(
        workspace_actions.add_parser(
            "configure", help="update settings used by the next Run"
        )
    )
    configure.add_argument("--lang", choices=("en", "zh"))
    configure.add_argument("--freshness-days", type=int)
    add_policy_arguments(configure, defaults=False)
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
    search.add_argument("--after", help="continue after a locator from the prior page")
    read = leaf(
        evidence_actions.add_parser(
            "read", help="read one bounded locator from a frozen Source"
        )
    )
    read.add_argument("locator", help="canonical source/path#Lx-Ly locator")

    plan = commands.add_parser("plan", help="inspect or compile semantic Plan intent")
    plan_actions = plan.add_subparsers(dest="action", required=True)
    leaf(
        plan_actions.add_parser(
            "inspect", help="report all actionable Plan diagnostics"
        )
    )
    leaf(
        plan_actions.add_parser(
            "compile", help="generate the deterministic Plan ledger"
        )
    )

    composition = commands.add_parser(
        "composition", help="prepare the complete Composition contract"
    )
    composition_actions = composition.add_subparsers(dest="action", required=True)
    leaf(
        composition_actions.add_parser(
            "prepare", help="generate required slots and effective unit mappings"
        )
    )

    review = commands.add_parser(
        "review", help="prepare or complete one independent Wiki bundle review"
    )
    review_actions = review.add_subparsers(dest="action", required=True)
    leaf(
        review_actions.add_parser(
            "plan", help="prepare one independent Knowledge Plan review"
        )
    )
    leaf(
        review_actions.add_parser(
            "composition", help="prepare one independent Composition review"
        )
    )
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
    catalog_tables = leaf(
        catalog_actions.add_parser(
            "tables",
            help="list selected tables from the current run's captured catalog",
        )
    )
    catalog_tables.add_argument("--source", help="restrict to one catalog source")
    catalog_tables.add_argument(
        "--summary",
        action="store_true",
        help="include comments and column, foreign-key and index counts",
    )
    catalog_describe = leaf(
        catalog_actions.add_parser(
            "describe", help="describe one captured table, including comments"
        )
    )
    catalog_describe.add_argument("table", help="table name or page slug")
    catalog_describe.add_argument(
        "--source", help="catalog source when the name is shared"
    )
    catalog_describe.add_argument(
        "--full", action="store_true", help="include indexes and full constraints"
    )

    page = commands.add_parser(
        "page", help="prepare the bounded context packet for one authored page"
    )
    page_actions = page.add_subparsers(dest="action", required=True)
    page_prepare = leaf(
        page_actions.add_parser(
            "prepare", help="derive one page packet from approved artifacts"
        )
    )
    page_prepare.add_argument("page_id", help="authored Composition page id")

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
        "plan": cmd_plan,
        "composition": cmd_composition,
        "review": cmd_review,
        "publication": cmd_publication,
        "validate": cmd_validate,
        "db": cmd_db,
        "catalog": cmd_catalog,
        "page": cmd_page,
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
