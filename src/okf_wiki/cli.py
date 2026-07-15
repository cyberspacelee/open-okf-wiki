import argparse
import asyncio
import json
from pathlib import Path

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

    wiki_run = subcommands.add_parser("wiki-run")
    wiki_run.add_argument("source", type=Path)
    wiki_run.add_argument("--refresh", action="store_true")
    wiki_run.add_argument("--source-revision", required=True)
    wiki_run.add_argument("--skill", type=Path)
    wiki_run.add_argument("--skill-digest")
    wiki_run.add_argument("--staging", type=Path, required=True)
    wiki_run.add_argument("--publication", type=Path, required=True)
    wiki_run.add_argument("--model", required=True)
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


def main() -> int:
    arguments = parser().parse_args()
    try:
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
            from .wiki_run import (
                ModelProviderConfig,
                RepositorySnapshot,
                WikiRunApplication,
                WikiRunLimits,
                WikiRunRequest,
            )

            limit_values = {
                name: getattr(arguments, name)
                for name in WikiRunLimits.model_fields
                if getattr(arguments, name) is not None
            }
            result = asyncio.run(
                WikiRunApplication().run(
                    WikiRunRequest(
                        operation="refresh" if arguments.refresh else "generate",
                        repository=RepositorySnapshot(
                            path=arguments.source,
                            revision=arguments.source_revision,
                        ),
                        skill=_producer_skill_version(arguments),
                        model=ModelProviderConfig(model=arguments.model),
                        limits=WikiRunLimits(**limit_values),
                        staging=arguments.staging,
                        publication=arguments.publication,
                    )
                )
            )
            emit({"ok": True, "result": result.model_dump(mode="json")})
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
