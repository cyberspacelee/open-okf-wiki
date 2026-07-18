import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from .security import (
    PROVIDER_DIAGNOSTICS_WITHHELD,
    environment_secrets,
    redact_secrets,
    safe_error_message,
    safe_exception_traceback,
    write_error_diagnostics,
)

_ERROR_DUMP_AUTO = "__auto__"


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, sort_keys=True))


def _safe_cli_error(error: Exception) -> str:
    if type(error).__name__ == "WikiRunResourceLimitError":
        return redact_secrets(str(error), environment_secrets())
    message = safe_error_message(error)
    return (
        f"{type(error).__name__}: {message}"
        if message == PROVIDER_DIAGNOSTICS_WITHHELD
        else message
    )


def _cli_error_payload(error: Exception) -> dict[str, object]:
    """Build a secret-safe CLI error object with a redacted stack for debugging.

    Message text may still be withheld for opaque/provider failures; the traceback is
    kept whenever it can be credential-scrubbed so operators are not left without a stack.
    """
    payload: dict[str, object] = {
        "message": _safe_cli_error(error),
        "type": type(error).__name__,
    }
    traceback_text = safe_exception_traceback(error)
    if traceback_text is not None:
        payload["traceback"] = traceback_text
    return payload


def _error_dump_request(arguments: argparse.Namespace) -> str | None:
    """Return dump mode: explicit path, auto token, or None."""
    explicit = getattr(arguments, "error_dump", None)
    if explicit is not None:
        return str(explicit)
    env = os.environ.get("OKF_WIKI_ERROR_DUMP")
    if env is None or env.strip() == "":
        return None
    if env.strip() in {"1", "true", "TRUE", "yes", "YES", "auto", "AUTO"}:
        return _ERROR_DUMP_AUTO
    return env.strip()


def _resolve_error_dump_path(
    mode: str,
    *,
    publication: Path | None,
    run_id: str | None,
) -> Path:
    if mode != _ERROR_DUMP_AUTO:
        return Path(mode)
    if publication is not None:
        runs = publication.parent / f".{publication.name}.runs"
        name = f"{run_id}.diag.txt" if run_id else "last-error.diag.txt"
        return runs / name
    name = f"okf-wiki-{run_id}.diag.txt" if run_id else "okf-wiki-error.diag.txt"
    return Path.cwd() / name


def _maybe_write_error_dump(
    arguments: argparse.Namespace,
    error: Exception,
    *,
    publication: Path | None = None,
    run_id: str | None = None,
) -> Path | None:
    mode = _error_dump_request(arguments)
    if mode is None:
        return None
    target = _resolve_error_dump_path(mode, publication=publication, run_id=run_id)
    return write_error_diagnostics(
        target,
        error=error,
        run_id=run_id,
        command=getattr(arguments, "command", None),
    )


def _add_error_dump_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--error-dump",
        nargs="?",
        const=_ERROR_DUMP_AUTO,
        default=None,
        metavar="PATH",
        help=(
            "On failure, write secret-scrubbed diagnostics to PATH. "
            "Omit PATH (or set OKF_WIKI_ERROR_DUMP=1) to auto-place under "
            ".<publication>.runs/<run_id>.diag.txt when publication is known."
        ),
    )


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="okf-wiki")
    subcommands = command.add_subparsers(dest="command", required=False)

    init = subcommands.add_parser(
        "init",
        help="Initialize a Wiki Run project directory (writes wiki-run.yaml)",
    )
    init.add_argument(
        "directory",
        nargs="?",
        type=Path,
        default=None,
        help=(
            "Directory to initialize (default: current directory). Created if missing. "
            "wiki-run.yaml and .okf-wiki paths are relative to this directory."
        ),
    )
    init.add_argument(
        "--config",
        type=Path,
        default=Path("wiki-run.yaml"),
        help=(
            "Wiki Run YAML path (optional; default: wiki-run.yaml under the init directory, "
            "or ./wiki-run.yaml when directory is omitted)"
        ),
    )
    init.add_argument(
        "--source",
        type=Path,
        help="Optional local repository to prefill as the first Snapshot entry",
    )
    init.add_argument(
        "--source-id",
        default="application",
        help="Repository ID for --source (default: application)",
    )
    init.add_argument("--branch", help="Branch name for --source (default: current branch or main)")
    init.add_argument("--revision", help="Exact commit for --source instead of a branch")
    init.add_argument(
        "--model",
        default=None,
        help=(
            "Model identity written into the YAML (default: OKF_WIKI_MODEL or openai:gpt-5-mini)"
        ),
    )
    init.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing configuration file",
    )

    wiki_run = subcommands.add_parser("wiki-run")
    wiki_run.add_argument("source", nargs="?", type=Path)
    wiki_run.add_argument(
        "--config",
        type=Path,
        default=None,
        help=(
            "Wiki Run YAML path. When omitted and no direct source args are given, "
            "defaults to ./wiki-run.yaml if that file exists."
        ),
    )
    wiki_run.add_argument("--refresh", action="store_true")
    wiki_run.add_argument("--source-revision")
    wiki_run.add_argument("--skill", type=Path)
    wiki_run.add_argument("--skill-digest")
    wiki_run.add_argument("--staging", type=Path)
    wiki_run.add_argument("--publication", type=Path)
    wiki_run.add_argument(
        "--model",
        help="Model identity (provider:name). Default: OKF_WIKI_MODEL or openai:gpt-5-mini",
    )
    wiki_run.add_argument(
        "--reviewer-model",
        default=None,
        help=(
            "Optional Wiki Reviewer model identity (provider:name). "
            "Falls back to the producer --model when omitted."
        ),
    )
    wiki_run.add_argument(
        "--max-tokens",
        type=int,
        help="Per-completion max output tokens (ModelSettings.max_tokens); env OKF_WIKI_MAX_TOKENS",
    )
    wiki_run.add_argument(
        "--temperature",
        type=float,
        help="Sampling temperature; env OKF_WIKI_TEMPERATURE",
    )
    wiki_run.add_argument("--request-limit", type=int)
    wiki_run.add_argument("--tool-calls-limit", type=int)
    wiki_run.add_argument(
        "--input-tokens-limit",
        type=int,
        help="Run-level cumulative input token budget; env OKF_WIKI_INPUT_TOKENS_LIMIT",
    )
    wiki_run.add_argument(
        "--output-tokens-limit",
        type=int,
        help="Run-level cumulative output token budget; env OKF_WIKI_OUTPUT_TOKENS_LIMIT",
    )
    wiki_run.add_argument(
        "--total-tokens-limit",
        type=int,
        help="Run-level cumulative total token budget; env OKF_WIKI_TOTAL_TOKENS_LIMIT",
    )
    wiki_run.add_argument("--retries", type=int)
    wiki_run.add_argument(
        "--request-timeout-seconds",
        type=float,
        help="Provider request timeout; env OKF_WIKI_REQUEST_TIMEOUT_SECONDS",
    )
    wiki_run.add_argument("--tool-timeout-seconds", type=float)
    wiki_run.add_argument("--wall-clock-timeout-seconds", type=float)
    wiki_run.add_argument("--source-files-limit", type=int)
    wiki_run.add_argument("--source-file-bytes-limit", type=int)
    wiki_run.add_argument("--source-total-bytes-limit", type=int)
    wiki_run.add_argument("--wiki-entries-limit", type=int)
    wiki_run.add_argument("--wiki-file-bytes-limit", type=int)
    wiki_run.add_argument("--wiki-total-bytes-limit", type=int)
    wiki_run.add_argument("--wiki-write-bytes-limit", type=int)
    wiki_run.add_argument("--analysis-receipt-bytes-limit", type=int)
    wiki_run.add_argument("--analysis-artifact-bytes-limit", type=int)
    wiki_run.add_argument("--analysis-workspace-bytes-limit", type=int)
    wiki_run.add_argument("--analysis-workspace-entries-limit", type=int)
    wiki_run.add_argument(
        "--context-target-tokens",
        type=int,
        help="Compaction/context target tokens; env OKF_WIKI_CONTEXT_TARGET_TOKENS",
    )
    wiki_run.add_argument("--adaptive-source-files-threshold", type=int)
    wiki_run.add_argument("--adaptive-source-bytes-threshold", type=int)
    wiki_run.add_argument("--adaptive-max-depth", type=int)
    wiki_run.add_argument("--adaptive-root-fanout", type=int)
    wiki_run.add_argument("--adaptive-domain-fanout", type=int)
    wiki_run.add_argument("--adaptive-child-concurrency", type=int)
    wiki_run.add_argument("--adaptive-child-timeout-seconds", type=float)
    wiki_run.add_argument("--adaptive-domain-request-limit", type=int)
    wiki_run.add_argument("--adaptive-leaf-request-limit", type=int)
    wiki_run.add_argument("--adaptive-domain-total-tokens-limit", type=int)
    wiki_run.add_argument("--adaptive-leaf-total-tokens-limit", type=int)
    wiki_run.add_argument(
        "--adaptive-enable-reviewer",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    wiki_run.add_argument("--adaptive-reviewer-request-limit", type=int)
    wiki_run.add_argument("--adaptive-reviewer-total-tokens-limit", type=int)
    wiki_run.add_argument("--adaptive-leaf-timeout-seconds", type=float)
    wiki_run.add_argument("--adaptive-dynamic-workflow", action="store_true", default=None)
    wiki_run.add_argument(
        "--write-visualization",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="After successful publication, write a static Wiki Visualization under viz/",
    )
    wiki_run.add_argument(
        "--yes",
        "--yolo",
        action="store_true",
        dest="auto_approve_publication",
        default=False,
        help=(
            "Auto-approve publication after Host validation (YOLO / non-interactive yes). "
            "Does not skip validation, mounts, or publication locks. Off by default."
        ),
    )
    _add_error_dump_flag(wiki_run)

    wiki_retry = subcommands.add_parser("wiki-retry")
    wiki_retry.add_argument("record", type=Path)
    wiki_retry.add_argument("--staging", type=Path, required=True)
    wiki_retry.add_argument("--publication", type=Path, required=True)
    wiki_retry.add_argument("--model")
    wiki_retry.add_argument(
        "--yes",
        "--yolo",
        action="store_true",
        dest="auto_approve_publication",
        default=False,
        help=(
            "Auto-approve publication after Host validation (YOLO / non-interactive yes). "
            "Does not skip validation, mounts, or publication locks. Off by default."
        ),
    )
    _add_error_dump_flag(wiki_retry)

    tui = subcommands.add_parser(
        "tui",
        help=(
            "Interactive Operator Session (conversation shell): stream analysis cards, "
            "HITL publish approve/deny, Needs Input → new Wiki Run, slash controls"
        ),
    )
    tui.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Wiki Run YAML path (default: ./wiki-run.yaml when present)",
    )
    tui.add_argument("--retry-record", type=Path)
    tui.add_argument(
        "--yes",
        "--yolo",
        action="store_true",
        dest="auto_approve_publication",
        default=False,
        help=(
            "Start the Operator Session with YOLO (auto-approve publication). "
            "Toggle later with /yolo. Does not skip validation or locks."
        ),
    )
    _add_error_dump_flag(tui)

    wiki_eval = subcommands.add_parser("wiki-eval")
    wiki_eval.add_argument("output", type=Path)
    wiki_eval.add_argument("--model")
    wiki_eval.add_argument("--repeats", type=int, default=2)
    wiki_eval.add_argument("--skill", type=Path)
    wiki_eval.add_argument("--skill-digest")
    wiki_eval.add_argument("--manifest", type=Path)
    wiki_eval.add_argument("--review", type=Path)

    skill_fork = subcommands.add_parser("skill-fork")
    skill_fork.add_argument("destination", type=Path)
    skill_fork.add_argument("--skill", type=Path)
    skill_fork.add_argument("--skill-digest")

    skill_inspect = subcommands.add_parser("skill-inspect")
    skill_inspect.add_argument("path", type=Path)

    viz = subcommands.add_parser(
        "viz",
        help="Generate a deterministic Wiki Visualization from a Published Wiki",
    )
    viz.add_argument("publication", type=Path, help="Path to an existing Published Wiki")
    viz.add_argument(
        "--output",
        type=Path,
        help="Directory for visualization artifacts (default: <publication>/viz)",
    )

    doctor = subcommands.add_parser(
        "doctor",
        help="Report credential-related environment presence (set/unset, redacted)",
    )
    doctor.add_argument(
        "--config",
        type=Path,
        default=None,
        help=(
            "Optional Wiki Run YAML path; when set, load .env beside that config "
            "(same rule as wiki-run --config)"
        ),
    )
    doctor.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Optional .env path to load (default: .env beside --config or ./ .env)",
    )
    return command


def _producer_skill_version(arguments: argparse.Namespace):
    from .wiki_run import ProducerSkillVersion

    if arguments.skill is None:
        if arguments.skill_digest is not None:
            raise ValueError("--skill-digest requires --skill")
        return ProducerSkillVersion.default()
    if arguments.skill_digest is None:
        raise ValueError("--skill requires --skill-digest")
    return ProducerSkillVersion(path=arguments.skill, digest=arguments.skill_digest)


def _default_wiki_run_config_path() -> Path:
    """Prefer ./wiki-run.yaml when operators omit --config."""
    return Path("wiki-run.yaml")


def _resolve_config_path(
    configured: Path | None,
    *,
    allow_default: bool,
    command: str,
) -> Path | None:
    if configured is not None:
        return configured
    if not allow_default:
        return None
    default = _default_wiki_run_config_path()
    if default.is_file():
        return default
    raise ValueError(
        f"{command} requires --config PATH, or a {default.as_posix()} file in the current "
        "directory (create one with: okf-wiki init)"
    )


def _wiki_run_request(arguments: argparse.Namespace):
    from .provider_env import resolve_model_identity, resolve_model_settings
    from .wiki_run import (
        ModelProviderConfig,
        RepositorySnapshot,
        WikiRunLimits,
        WikiRunRequest,
    )

    # Direct mode: positional source or explicit staging/publication/revision flags.
    direct_mode_markers = (
        arguments.source,
        arguments.source_revision,
        arguments.staging,
        arguments.publication,
    )
    using_direct = any(value is not None for value in direct_mode_markers)

    config_path = arguments.config
    if config_path is None and not using_direct:
        config_path = _resolve_config_path(None, allow_default=True, command="wiki-run")

    auto_approve = bool(getattr(arguments, "auto_approve_publication", False))
    reviewer_model_arg = getattr(arguments, "reviewer_model", None)

    if config_path is not None:
        direct_values = (
            arguments.source,
            arguments.source_revision,
            arguments.skill,
            arguments.skill_digest,
            arguments.staging,
            arguments.publication,
            arguments.model,
            getattr(arguments, "max_tokens", None),
            getattr(arguments, "temperature", None),
            *(getattr(arguments, name) for name in WikiRunLimits.model_fields),
        )
        if arguments.refresh or any(value is not None for value in direct_values):
            raise ValueError("--config cannot be combined with direct Wiki Run arguments")
        # --yes / --yolo / --reviewer-model may combine with --config.
        request = WikiRunRequest.from_yaml(config_path)
        updates: dict[str, object] = {}
        if auto_approve and not request.auto_approve_publication:
            updates["auto_approve_publication"] = True
        if reviewer_model_arg is not None:
            updates["reviewer_model"] = ModelProviderConfig(
                model=resolve_model_identity(reviewer_model_arg),
                settings=resolve_model_settings(),
            )
        if updates:
            return request.model_copy(update=updates)
        return request

    required = {
        "source": arguments.source,
        "--source-revision": arguments.source_revision,
        "--staging": arguments.staging,
        "--publication": arguments.publication,
    }
    missing = [name for name, value in required.items() if value is None]
    if missing:
        raise ValueError(
            "direct Wiki Run requires "
            + ", ".join(missing)
            + " (or omit them and use --config / ./wiki-run.yaml)"
        )
    limit_values = {
        name: getattr(arguments, name)
        for name in WikiRunLimits.model_fields
        if getattr(arguments, name) is not None
    }
    reviewer_config = None
    if reviewer_model_arg is not None:
        reviewer_config = ModelProviderConfig(
            model=resolve_model_identity(reviewer_model_arg),
            settings=resolve_model_settings(
                max_tokens=getattr(arguments, "max_tokens", None),
                temperature=getattr(arguments, "temperature", None),
            ),
        )
    return WikiRunRequest(
        operation="refresh" if arguments.refresh else "generate",
        repositories=(
            RepositorySnapshot(
                path=arguments.source,
                revision=arguments.source_revision,
            ),
        ),
        skill=_producer_skill_version(arguments),
        model=ModelProviderConfig(
            model=resolve_model_identity(arguments.model),
            settings=resolve_model_settings(
                max_tokens=getattr(arguments, "max_tokens", None),
                temperature=getattr(arguments, "temperature", None),
            ),
        ),
        limits=WikiRunLimits.build(limit_values),
        staging=arguments.staging,
        publication=arguments.publication,
        write_visualization=bool(arguments.write_visualization),
        auto_approve_publication=auto_approve,
        reviewer_model=reviewer_config,
    )


_CLI_COMMANDS = frozenset(
    {
        "init",
        "wiki-run",
        "wiki-retry",
        "tui",
        "wiki-eval",
        "skill-fork",
        "skill-inspect",
        "viz",
        "doctor",
    }
)


def _normalize_argv(argv: list[str]) -> list[str]:
    """Session-first: bare invocation becomes `tui` (Operator Session).

    When the first non-option token is missing or not a known subcommand, insert
    ``tui`` so flags like ``--config`` still attach to the Session entry.
    Non-TTY bare invocation is left as-is so argparse can fail or show help.
    """
    if any(arg in _CLI_COMMANDS for arg in argv):
        return argv
    # No subcommand token present.
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return argv
    return ["tui", *argv]


def main() -> int:
    arguments = parser().parse_args(_normalize_argv(sys.argv[1:]))
    if getattr(arguments, "command", None) is None:
        print(
            "okf-wiki: interactive Operator Session requires a TTY; "
            "pass a subcommand (wiki-run, doctor, …) for non-interactive use, "
            "or run on a TTY for the default Session.",
            file=sys.stderr,
        )
        return 2
    error_dump_path: Path | None = None
    try:
        if arguments.command == "doctor":
            from .diagnostics import collect_credential_report, format_credential_report
            from .diagnostics.doctor import CREDENTIAL_ENV_KEYS

            # Snapshot process presence before dotenv so source hints stay honest.
            process_keys = frozenset(
                name for name in CREDENTIAL_ENV_KEYS if os.environ.get(name, "").strip()
            )
            if arguments.env_file is not None:
                doctor_dotenv = arguments.env_file
            elif arguments.config is not None:
                doctor_dotenv = arguments.config.absolute().parent / ".env"
            else:
                doctor_dotenv = Path.cwd() / ".env"
            if doctor_dotenv.is_file():
                load_dotenv(doctor_dotenv, override=False)
            report = collect_credential_report(
                dotenv_path=doctor_dotenv if doctor_dotenv.is_file() else None,
                process_keys=process_keys,
            )
            # Human-readable summary on stderr; machine-readable JSON on stdout.
            print(format_credential_report(report), file=sys.stderr)
            emit(
                {
                    "ok": True,
                    "doctor": {
                        "credentials": [item.as_dict() for item in report],
                        "env_file": str(doctor_dotenv) if doctor_dotenv.is_file() else None,
                    },
                }
            )
            return 0

        dotenv = Path.cwd() / ".env"
        if arguments.command == "wiki-run" and arguments.config is not None:
            config_dotenv = arguments.config.absolute().parent / ".env"
            if config_dotenv.is_file():
                dotenv = config_dotenv
        load_dotenv(dotenv, override=False)

        if arguments.command == "init":
            from .init_config import write_wiki_run_config
            from .provider_env import resolve_model_identity

            written = write_wiki_run_config(
                arguments.config,
                directory=arguments.directory,
                source=arguments.source,
                source_id=arguments.source_id,
                branch=arguments.branch,
                revision=arguments.revision,
                model=resolve_model_identity(arguments.model),
                force=arguments.force,
            )
            project_root = written.parent
            run_hint = (
                f"cd {project_root} && okf-wiki wiki-run"
                if arguments.directory is not None
                else f"okf-wiki wiki-run --config {written}"
            )
            emit(
                {
                    "ok": True,
                    "init": {
                        "config": str(written),
                        "directory": str(project_root),
                        "next": [
                            "Edit repository paths, refs, staging, publication, and model in the YAML.",
                            "Copy .env.example to .env beside the YAML; set OPENAI_API_KEY and "
                            "optional OPENAI_BASE_URL for OpenAI-compatible gateways.",
                            f"Run: {run_hint}",
                            "Optional: okf-wiki tui (from the project directory) or okf-wiki viz <publication>",
                        ],
                    },
                }
            )
            return 0

        if arguments.command == "skill-inspect":
            from .wiki_run import ProducerSkillVersion

            version = ProducerSkillVersion.from_directory(arguments.path)
            emit(
                {
                    "ok": True,
                    "skill_version": {"digest": version.digest, "path": str(version.path)},
                }
            )
            return 0

        if arguments.command == "skill-fork":
            from .wiki_run import ProducerSkillFork

            fork = ProducerSkillFork.create(
                _producer_skill_version(arguments), arguments.destination
            )
            version = fork.version()
            emit(
                {
                    "ok": True,
                    "skill_fork": {"digest": version.digest, "path": str(fork.path)},
                }
            )
            return 0

        if arguments.command == "wiki-run":
            from .wiki_run import WikiRunApplication

            request = _wiki_run_request(arguments)
            application = WikiRunApplication()
            try:
                result = asyncio.run(application.run(request))
            except Exception as error:
                error_dump_path = _maybe_write_error_dump(
                    arguments,
                    error,
                    publication=request.publication,
                    run_id=application.last_run_id,
                )
                raise
            payload: dict[str, object] = {
                "ok": True,
                "result": result.model_dump(mode="json"),
            }
            visualization = getattr(application, "last_visualization", None)
            if visualization is not None:
                payload["visualization"] = visualization
            visualization_error = getattr(application, "last_visualization_error", None)
            if visualization_error is not None:
                payload["visualization_error"] = visualization_error
            run_status = getattr(application, "last_run_status", None)
            if run_status is not None:
                payload["run_status"] = run_status
            if run_status == "awaiting_publication":
                print(
                    "okf-wiki: run awaiting_publication — pass --yes/--yolo to auto-approve, "
                    "or use `okf-wiki tui` / bare `okf-wiki` on a TTY to approve interactively.",
                    file=sys.stderr,
                )
                payload["awaiting_publication"] = True
                emit(payload)
                return 3
            if run_status == "publication_declined":
                payload["publication_declined"] = True
            emit(payload)
            return 0

        if arguments.command == "wiki-retry":
            from .wiki_run import WikiRunApplication, WikiRunRequest

            request = WikiRunRequest.from_run_record(
                arguments.record,
                staging=arguments.staging,
                publication=arguments.publication,
                model=arguments.model,
            )
            if getattr(arguments, "auto_approve_publication", False):
                request = request.model_copy(update={"auto_approve_publication": True})
            application = WikiRunApplication()
            try:
                result = asyncio.run(application.run(request))
            except Exception as error:
                error_dump_path = _maybe_write_error_dump(
                    arguments,
                    error,
                    publication=request.publication,
                    run_id=application.last_run_id,
                )
                raise
            emit(
                {
                    "ok": True,
                    "manual_retry": True,
                    "prior_run_id": request.prior_run_id,
                    "result": result.model_dump(mode="json"),
                }
            )
            return 0

        if arguments.command == "tui":
            from .tui import run_tui
            from .wiki_run import WikiRunRequest

            config_path = _resolve_config_path(arguments.config, allow_default=True, command="tui")
            assert config_path is not None
            configured = WikiRunRequest.from_yaml(config_path)
            yolo = bool(getattr(arguments, "auto_approve_publication", False))
            if arguments.retry_record is not None:
                request = WikiRunRequest.from_run_record(
                    arguments.retry_record,
                    staging=configured.staging,
                    publication=configured.publication,
                    model=configured.model.model
                    if isinstance(configured.model.model, str)
                    else None,
                )
            else:
                request = configured
            if yolo and not request.auto_approve_publication:
                request = request.model_copy(update={"auto_approve_publication": True})
            try:
                result = asyncio.run(run_tui(request, yolo=yolo))
            except Exception as error:
                error_dump_path = _maybe_write_error_dump(
                    arguments,
                    error,
                    publication=request.publication,
                    run_id=None,
                )
                raise
            payload: dict[str, object] = {"ok": True, "session": True}
            if result is not None:
                payload["result"] = result.model_dump(mode="json")
            emit(payload)
            return 0

        if arguments.command == "viz":
            from .wiki_visualization import generate_wiki_visualization

            visualization = generate_wiki_visualization(
                arguments.publication,
                output=arguments.output,
            )
            emit(
                {
                    "ok": True,
                    "visualization": {
                        "edge_count": visualization.edge_count,
                        "generator_version": visualization.generator_version,
                        "graph": str(visualization.graph_path),
                        "index": str(visualization.index_path),
                        "output": str(visualization.output_dir),
                        "page_count": visualization.page_count,
                    },
                }
            )
            return 0

        from .wiki_evaluation import evaluate_wiki_producer

        report = asyncio.run(
            evaluate_wiki_producer(
                arguments.output,
                model=arguments.model,
                repeats=arguments.repeats,
                skill=_producer_skill_version(arguments),
                manifest=arguments.manifest,
                review=arguments.review,
            )
        )
        emit(
            {
                "decision": report.decision,
                "ok": True,
                "reports": {
                    "json": str(arguments.output / "wiki-evaluation.json"),
                    "markdown": str(arguments.output / "wiki-evaluation.md"),
                },
            }
        )
        return 0
    except Exception as error:
        error_payload = _cli_error_payload(error)
        traceback_text = error_payload.get("traceback")
        if isinstance(traceback_text, str) and traceback_text:
            # Keep machine-readable JSON on stdout; human operators see the stack on stderr.
            print(
                traceback_text, file=sys.stderr, end="" if traceback_text.endswith("\n") else "\n"
            )
        # Config/init failures never entered wiki-run; still honor --error-dump / env.
        dump = error_dump_path
        if dump is None:
            dump = _maybe_write_error_dump(arguments, error)
        if dump is not None:
            error_payload["error_dump"] = str(dump)
            print(f"okf-wiki: wrote error diagnostics to {dump}", file=sys.stderr)
        emit({"error": error_payload, "ok": False})
        return 1
