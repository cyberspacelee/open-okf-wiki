import argparse
import asyncio
import json
from pathlib import Path

from dotenv import load_dotenv

from .security import (
    PROVIDER_DIAGNOSTICS_WITHHELD,
    environment_secrets,
    redact_secrets,
    safe_error_message,
)


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


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="okf-wiki")
    subcommands = command.add_subparsers(dest="command", required=True)

    init = subcommands.add_parser(
        "init",
        help="Write a starter wiki-run.yaml for editing and later wiki-run --config",
    )
    init.add_argument(
        "--config",
        type=Path,
        default=Path("wiki-run.yaml"),
        help="Path for the Wiki Run YAML (default: ./wiki-run.yaml)",
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
        default="openai:gpt-5-mini",
        help="Model string written into the YAML (default: openai:gpt-5-mini)",
    )
    init.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing configuration file",
    )

    wiki_run = subcommands.add_parser("wiki-run")
    wiki_run.add_argument("source", nargs="?", type=Path)
    wiki_run.add_argument("--config", type=Path)
    wiki_run.add_argument("--refresh", action="store_true")
    wiki_run.add_argument("--source-revision")
    wiki_run.add_argument("--skill", type=Path)
    wiki_run.add_argument("--skill-digest")
    wiki_run.add_argument("--staging", type=Path)
    wiki_run.add_argument("--publication", type=Path)
    wiki_run.add_argument("--model")
    wiki_run.add_argument("--request-limit", type=int)
    wiki_run.add_argument("--tool-calls-limit", type=int)
    wiki_run.add_argument("--input-tokens-limit", type=int)
    wiki_run.add_argument("--output-tokens-limit", type=int)
    wiki_run.add_argument("--total-tokens-limit", type=int)
    wiki_run.add_argument("--retries", type=int)
    wiki_run.add_argument("--request-timeout-seconds", type=float)
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
    wiki_run.add_argument("--context-target-tokens", type=int)
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

    wiki_retry = subcommands.add_parser("wiki-retry")
    wiki_retry.add_argument("record", type=Path)
    wiki_retry.add_argument("--staging", type=Path, required=True)
    wiki_retry.add_argument("--publication", type=Path, required=True)
    wiki_retry.add_argument("--model")

    tui = subcommands.add_parser("tui")
    tui.add_argument("--config", type=Path, required=True)
    tui.add_argument("--retry-record", type=Path)

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


def _wiki_run_request(arguments: argparse.Namespace):
    from .wiki_run import (
        ModelProviderConfig,
        RepositorySnapshot,
        WikiRunLimits,
        WikiRunRequest,
    )

    if arguments.config is not None:
        direct_values = (
            arguments.source,
            arguments.source_revision,
            arguments.skill,
            arguments.skill_digest,
            arguments.staging,
            arguments.publication,
            arguments.model,
            *(getattr(arguments, name) for name in WikiRunLimits.model_fields),
        )
        if arguments.refresh or any(value is not None for value in direct_values):
            raise ValueError("--config cannot be combined with direct Wiki Run arguments")
        return WikiRunRequest.from_yaml(arguments.config)

    required = {
        "source": arguments.source,
        "--source-revision": arguments.source_revision,
        "--staging": arguments.staging,
        "--publication": arguments.publication,
        "--model": arguments.model,
    }
    missing = [name for name, value in required.items() if value is None]
    if missing:
        raise ValueError("direct Wiki Run requires " + ", ".join(missing))
    limit_values = {
        name: getattr(arguments, name)
        for name in WikiRunLimits.model_fields
        if getattr(arguments, name) is not None
    }
    return WikiRunRequest(
        operation="refresh" if arguments.refresh else "generate",
        repositories=(
            RepositorySnapshot(
                path=arguments.source,
                revision=arguments.source_revision,
            ),
        ),
        skill=_producer_skill_version(arguments),
        model=ModelProviderConfig(model=arguments.model),
        limits=WikiRunLimits(**limit_values),
        staging=arguments.staging,
        publication=arguments.publication,
        write_visualization=bool(arguments.write_visualization),
    )


def main() -> int:
    arguments = parser().parse_args()
    try:
        dotenv = Path.cwd() / ".env"
        if arguments.command == "wiki-run" and arguments.config is not None:
            config_dotenv = arguments.config.absolute().parent / ".env"
            if config_dotenv.is_file():
                dotenv = config_dotenv
        load_dotenv(dotenv, override=False)

        if arguments.command == "init":
            from .init_config import write_wiki_run_config

            written = write_wiki_run_config(
                arguments.config,
                source=arguments.source,
                source_id=arguments.source_id,
                branch=arguments.branch,
                revision=arguments.revision,
                model=arguments.model,
                force=arguments.force,
            )
            emit(
                {
                    "ok": True,
                    "init": {
                        "config": str(written),
                        "next": [
                            "Edit repository paths, refs, staging, publication, and model in the YAML.",
                            "Copy .env.example to .env (or beside the YAML) and set provider credentials.",
                            f"Run: okf-wiki wiki-run --config {written}",
                            "Optional: okf-wiki tui --config <yaml> or okf-wiki viz <publication>",
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
            result = asyncio.run(application.run(request))
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
            result = asyncio.run(WikiRunApplication().run(request))
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

            configured = WikiRunRequest.from_yaml(arguments.config)
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
            result = asyncio.run(run_tui(request))
            emit({"ok": True, "result": result.model_dump(mode="json")})
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
        emit(
            {
                "error": {"message": _safe_cli_error(error), "type": type(error).__name__},
                "ok": False,
            }
        )
        return 1
