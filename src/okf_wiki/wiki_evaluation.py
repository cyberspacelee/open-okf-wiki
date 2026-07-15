"""Repeatable end-to-end evaluation for the single-Agent Wiki producer."""

import json
import os
import posixpath
import re
import subprocess
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from time import perf_counter
from typing import Literal, NotRequired, TypedDict, cast
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel

from .security import redact_secrets
from .wiki_run import (
    PUBLICATION_METADATA_NAME,
    Complete,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)


class _QualityReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    grounding_proxy: float = Field(ge=0, le=1)
    topic_coverage: float = Field(ge=0, le=1)
    navigation: float = Field(ge=0, le=1)
    duplication: float = Field(ge=0, le=1)
    organization: float = Field(ge=0, le=1)
    reader_usefulness: float | None = Field(default=None, ge=0, le=1)
    page_paths: list[str]
    covered_topics: list[str]
    cited_source_paths: list[str]
    unsupported_statement_count: int | None = Field(default=None, ge=0)
    manual_review: list[str]


class _EvaluationRun(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    repeat: int = Field(ge=1)
    status: Literal["complete", "needs_input", "failed"]
    source_revision: str
    skill_digest: str
    configured_model: str
    model_identity: str | None = None
    content_digest: str | None = None
    latency_seconds: float = Field(ge=0)
    usage: dict[str, int] | None = None
    cost_usd: float | None = Field(default=None, ge=0)
    cost_note: str
    quality: _QualityReport | None = None
    failure: str | None = None


class _EvaluationCaseReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    size: Literal["small", "medium", "large"]
    structure: str
    source_revision: str
    source_file_count: int = Field(gt=0)
    source_bytes: int = Field(gt=0)
    expected_topics: list[str]
    runs: list[_EvaluationRun] = Field(min_length=2)
    material_stability: float = Field(ge=0, le=1)
    materially_stable: bool
    identical_output: bool
    representative_pages: list[dict[str, str]]
    failures: list[str]


class WikiEvaluationReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["wiki-evaluation-v1"] = "wiki-evaluation-v1"
    generated_at: datetime
    mode: Literal["fixture", "live"]
    repeats: int = Field(ge=2)
    skill_digest: str
    limits: WikiRunLimits
    thresholds: dict[str, float]
    cases: list[_EvaluationCaseReport] = Field(min_length=3)
    decision: Literal["retain_single_agent", "open_capability_ticket"]
    provisional: bool
    measured_failures: list[str]
    success_metrics: list[str]
    rationale: list[str]
    trade_offs: list[str]


class _Case(TypedDict):
    id: str
    size: Literal["small", "medium", "large"]
    structure: str
    expected_topics: list[str]
    files: dict[str, str]
    pages: dict[str, str]
    generated_feature_count: NotRequired[int]


class _Page(TypedDict):
    path: str
    sha256: str


class _Metadata(TypedDict):
    source_revision: str
    skill_digest: str
    model: str
    content_digest: str
    pages: list[_Page]


_CORPUS = cast(
    list[_Case],
    json.loads(Path(__file__).with_name("wiki_evaluation_corpus.json").read_text(encoding="utf-8")),
)
_THRESHOLDS = {
    "grounding_proxy_min": 1.0,
    "topic_coverage_min": 0.75,
    "navigation_min": 0.8,
    "duplication_max": 0.2,
    "organization_min": 0.8,
    "material_stability_min": 0.8,
}
_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_CITATION_RE = re.compile(r"repo:([^#]+)#L[1-9]\d*-L[1-9]\d*")
_FRONTMATTER_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.DOTALL)
_SECRET_ENV_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH", "COOKIE")


async def evaluate_wiki_producer(
    workspace: Path,
    *,
    model: Model | str | None = None,
    repeats: int = 2,
    limits: WikiRunLimits | None = None,
    skill: ProducerSkillVersion | None = None,
) -> WikiEvaluationReport:
    """Run the bundled corpus through WikiRunApplication and write JSON/Markdown reports."""
    if repeats < 2:
        raise ValueError("Wiki evaluation requires at least two repeats")
    root = workspace.absolute()
    try:
        root.mkdir(parents=True, exist_ok=False)
    except FileExistsError as error:
        raise ValueError("Wiki evaluation workspace must not already exist") from error
    mode: Literal["fixture", "live"] = "fixture" if model is None else "live"
    selected_skill = skill or ProducerSkillVersion.default()
    selected_limits = limits or (
        WikiRunLimits(
            request_limit=3,
            tool_calls_limit=2,
            retries=0,
            request_timeout_seconds=5,
            tool_timeout_seconds=5,
            wall_clock_timeout_seconds=30,
        )
        if mode == "fixture"
        else WikiRunLimits()
    )
    cases = []
    for case in _CORPUS:
        case_root = root / "cases" / case["id"]
        files = _source_files(case)
        revision = _create_repository(case_root / "source", case["id"], files)
        runs = []
        representative_pages: list[dict[str, str]] = []
        for repeat in range(1, repeats + 1):
            run_model, observed = _fixture_model(case) if model is None else (model, None)
            run_root = case_root / f"run-{repeat:02}"
            publication = run_root / "wiki"
            started = perf_counter()
            try:
                result = await WikiRunApplication().run(
                    WikiRunRequest(
                        repository=RepositorySnapshot(path=case_root / "source", revision=revision),
                        skill=selected_skill,
                        model=ModelProviderConfig(model=run_model),
                        limits=selected_limits,
                        staging=run_root / "staging",
                        publication=publication,
                    )
                )
                latency = perf_counter() - started
                if not isinstance(result, Complete):
                    runs.append(
                        _run(
                            repeat,
                            "needs_input",
                            revision,
                            selected_skill.digest,
                            run_model,
                            latency,
                            observed,
                            mode,
                            failure="Needs Input: " + "; ".join(result.questions),
                        )
                    )
                    continue
                metadata = _metadata(publication)
                if (
                    metadata["source_revision"] != revision
                    or metadata["skill_digest"] != selected_skill.digest
                ):
                    raise ValueError("Published Wiki provenance does not match evaluation inputs")
                quality = _quality(publication, metadata, case, mode)
                runs.append(
                    _run(
                        repeat,
                        "complete",
                        revision,
                        selected_skill.digest,
                        run_model,
                        latency,
                        observed,
                        mode,
                        model_identity=metadata["model"],
                        content_digest=metadata["content_digest"],
                        quality=quality,
                    )
                )
                if not representative_pages:
                    representative_pages = _representative_pages(publication, metadata)
            except Exception as error:
                runs.append(
                    _run(
                        repeat,
                        "failed",
                        revision,
                        selected_skill.digest,
                        run_model,
                        perf_counter() - started,
                        observed,
                        mode,
                        failure=_safe_failure(error),
                    )
                )
        stability, identical = _stability(runs)
        cases.append(
            _EvaluationCaseReport(
                id=case["id"],
                size=case["size"],
                structure=case["structure"],
                source_revision=revision,
                source_file_count=len(files),
                source_bytes=sum(len(content.encode()) for content in files.values()),
                expected_topics=case["expected_topics"],
                runs=runs,
                material_stability=stability,
                materially_stable=stability >= _THRESHOLDS["material_stability_min"]
                and all(run.status == "complete" for run in runs),
                identical_output=identical,
                representative_pages=representative_pages,
                failures=[run.failure for run in runs if run.failure],
            )
        )
    measured_failures = _measured_failures(cases)
    report = WikiEvaluationReport(
        generated_at=datetime.now(UTC),
        mode=mode,
        repeats=repeats,
        skill_digest=selected_skill.digest,
        limits=selected_limits,
        thresholds=_THRESHOLDS,
        cases=cases,
        decision="open_capability_ticket" if measured_failures else "retain_single_agent",
        provisional=mode == "fixture"
        or any(
            quality.manual_review
            for case in cases
            for run in case.runs
            if (quality := run.quality) is not None
        ),
        measured_failures=measured_failures,
        success_metrics=(
            [f"{name}={value}" for name, value in _THRESHOLDS.items()] if measured_failures else []
        ),
        rationale=(
            [
                "Repeatable failures exist; a capability ticket must improve these metrics on the same corpus.",
                "The report does not preselect SubAgents or DynamicWorkflow.",
            ]
            if measured_failures
            else [
                "No metric failed repeatedly, so there is no evidence for added orchestration.",
                "Retain one Agent and rerun after model, Skill, or limit changes.",
            ]
        ),
        trade_offs=_trade_offs(mode),
    )
    (root / "wiki-evaluation.json").write_text(
        report.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    (root / "wiki-evaluation.md").write_text(_markdown(report), encoding="utf-8")
    return report


def _source_files(case: _Case) -> dict[str, str]:
    files = dict(case["files"])
    for number in range(1, case.get("generated_feature_count", 0) + 1):
        files[f"packages/features/feature_{number:02}.py"] = (
            f'FEATURE_NAME = "feature-{number:02}"\n'
            "def register(registry):\n    registry.register(FEATURE_NAME, object())\n"
        )
    return files


def _create_repository(root: Path, case_id: str, files: dict[str, str]) -> str:
    root.mkdir(parents=True)
    for relative, content in files.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Unsafe evaluation fixture path: {relative}")
        destination = root.joinpath(*path.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
    home = root.parent / ".git-home"
    home.mkdir()
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Wiki Evaluation",
        "GIT_AUTHOR_EMAIL": "wiki-evaluation@example.invalid",
        "GIT_COMMITTER_NAME": "Wiki Evaluation",
        "GIT_COMMITTER_EMAIL": "wiki-evaluation@example.invalid",
        "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+00:00",
        "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+00:00",
    }
    for arguments in (
        ("init", "-q", "--object-format=sha1"),
        ("add", "--all"),
        ("-c", f"core.hooksPath={os.devnull}", "commit", "-qm", case_id),
    ):
        subprocess.run(
            ["git", *arguments], cwd=root, env=environment, check=True, capture_output=True
        )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _fixture_model(case: _Case) -> tuple[FunctionModel, Counter[str]]:
    observed: Counter[str] = Counter()
    code = ["from pathlib import Path"]
    for path, content in case["pages"].items():
        code.extend(
            (
                f"page = Path({'/wiki/' + path!r})",
                "page.parent.mkdir(parents=True, exist_ok=True)",
                f"page.write_text({content!r})",
            )
        )
    name = f"fixture:{case['id']}:v1"

    def respond(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            part = ToolCallPart(
                complete.name,
                {"status": "complete", "manifest": {"pages": list(case["pages"])}},
            )
        else:
            part = ToolCallPart("run_code", {"code": "\n".join(code)})
        usage = RequestUsage(input_tokens=12, output_tokens=8)
        observed["requests"] += 1
        observed["tool_calls"] += 1
        observed["input_tokens"] += usage.input_tokens
        observed["output_tokens"] += usage.output_tokens
        return ModelResponse(parts=[part], usage=usage, model_name=name)

    return FunctionModel(respond, model_name=name), observed


def _run(
    repeat: int,
    status: Literal["complete", "needs_input", "failed"],
    revision: str,
    skill_digest: str,
    model: Model | str,
    latency: float,
    observed: Counter[str] | None,
    mode: Literal["fixture", "live"],
    **values,
) -> _EvaluationRun:
    usage = (
        {
            **observed,
            "total_tokens": observed["input_tokens"] + observed["output_tokens"],
        }
        if observed is not None
        else None
    )
    return _EvaluationRun(
        repeat=repeat,
        status=status,
        source_revision=revision,
        skill_digest=skill_digest,
        configured_model=model if isinstance(model, str) else model.model_name,
        latency_seconds=latency,
        usage=usage,
        cost_usd=0 if observed is not None else None,
        cost_note=(
            "Deterministic local fixture; no provider billing."
            if mode == "fixture"
            else "Provider billing and aggregate usage are unavailable; no value inferred."
        ),
        **values,
    )


def _metadata(publication: Path) -> _Metadata:
    return cast(
        _Metadata,
        json.loads((publication / PUBLICATION_METADATA_NAME).read_text(encoding="utf-8")),
    )


def _quality(
    publication: Path, metadata: _Metadata, case: _Case, mode: Literal["fixture", "live"]
) -> _QualityReport:
    pages = {
        page["path"]: (publication / page["path"]).read_text(encoding="utf-8")
        for page in metadata["pages"]
    }
    combined = "\n".join(pages.values()).casefold()
    covered = [topic for topic in case["expected_topics"] if topic.casefold() in combined]
    citations = {path: _CITATION_RE.findall(text) for path, text in pages.items()}
    grounding = sum(bool(items) for items in citations.values()) / len(pages)
    navigation = _navigation(pages)
    duplication = _duplication(pages.values())
    organization = sum(
        bool(re.search(r"(?m)^#\s+\S", _body(text))) for text in pages.values()
    ) / len(pages)
    coverage = len(covered) / len(case["expected_topics"])
    fixture = mode == "fixture"
    return _QualityReport(
        grounding_proxy=round(grounding, 6),
        topic_coverage=round(coverage, 6),
        navigation=round(navigation, 6),
        duplication=round(duplication, 6),
        organization=round(organization, 6),
        reader_usefulness=round((coverage + navigation + 1 - duplication + organization) / 4, 6)
        if fixture
        else None,
        page_paths=sorted(pages),
        covered_topics=covered,
        cited_source_paths=sorted({path for items in citations.values() for path in items}),
        unsupported_statement_count=0 if fixture else None,
        manual_review=(
            []
            if fixture
            else [
                "Check whether cited lines entail nearby claims and count unsupported statements.",
                "Review topic selection, explanations, and navigation for reader usefulness.",
            ]
        ),
    )


def _body(text: str) -> str:
    return _FRONTMATTER_RE.sub("", text, count=1)


def _navigation(pages: dict[str, str]) -> float:
    reachable, pending = {"index.md"}, ["index.md"]
    while pending:
        source = pending.pop()
        for target in _LINK_RE.findall(pages.get(source, "")):
            parsed = urlsplit(target)
            if parsed.scheme or not parsed.path:
                continue
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(source), unquote(parsed.path))
            )
            if resolved in pages and resolved not in reachable:
                reachable.add(resolved)
                pending.append(resolved)
    return len(reachable & pages.keys()) / len(pages)


def _duplication(texts) -> float:
    paragraphs = [
        normalized
        for text in texts
        for paragraph in re.split(r"\n\s*\n", _body(text))
        if len(normalized := " ".join(paragraph.split()).casefold()) >= 40
        and not normalized.startswith("#")
    ]
    counts = Counter(paragraphs)
    return sum(count - 1 for count in counts.values()) / len(paragraphs) if paragraphs else 0


def _stability(runs: list[_EvaluationRun]) -> tuple[float, bool]:
    complete = [run for run in runs if run.quality is not None]
    if len(complete) < 2:
        return 0, False
    qualities = [run.quality for run in complete if run.quality is not None]
    signatures = [
        set(quality.page_paths + quality.covered_topics + quality.cited_source_paths)
        for quality in qualities
    ]
    scores = [
        len(left & right) / len(left | right) if left | right else 1
        for index, left in enumerate(signatures)
        for right in signatures[index + 1 :]
    ]
    return round(min(scores), 6), len({run.content_digest for run in complete}) == 1


def _representative_pages(publication: Path, metadata: _Metadata) -> list[dict[str, str]]:
    return [
        {
            "path": page["path"],
            "sha256": page["sha256"],
            "excerpt": _body((publication / page["path"]).read_text(encoding="utf-8")).strip()[
                :600
            ],
        }
        for page in metadata["pages"][:2]
    ]


def _measured_failures(cases: list[_EvaluationCaseReport]) -> list[str]:
    failures = []
    rules = (
        ("grounding_proxy", lambda value: value < _THRESHOLDS["grounding_proxy_min"]),
        ("topic_coverage", lambda value: value < _THRESHOLDS["topic_coverage_min"]),
        ("navigation", lambda value: value < _THRESHOLDS["navigation_min"]),
        ("duplication", lambda value: value > _THRESHOLDS["duplication_max"]),
        ("organization", lambda value: value < _THRESHOLDS["organization_min"]),
    )
    for case in cases:
        if sum(run.status != "complete" for run in case.runs) >= 2:
            failures.append(f"{case.id}: Wiki Run did not complete twice")
        for name, failed in rules:
            if (
                sum(
                    run.quality is not None and failed(getattr(run.quality, name))
                    for run in case.runs
                )
                >= 2
            ):
                failures.append(f"{case.id}: {name} repeatedly missed its threshold")
        if case.material_stability < _THRESHOLDS["material_stability_min"]:
            failures.append(f"{case.id}: material_stability missed its threshold")
    return failures


def _safe_failure(error: Exception) -> str:
    secrets = tuple(
        value
        for name, value in os.environ.items()
        if value and any(marker in name.upper() for marker in _SECRET_ENV_MARKERS)
    )
    message = redact_secrets(str(error), secrets)
    if message != str(error) or not isinstance(error, (OSError, ValueError)):
        message = "provider diagnostics withheld"
    return f"{type(error).__name__}: {message}"


def _trade_offs(mode: Literal["fixture", "live"]) -> list[str]:
    return [
        *(
            ["Fixture mode validates the public seam, not live-model writing quality or billing."]
            if mode == "fixture"
            else ["Provider billing/usage are unavailable and semantic manual review is pending."]
        ),
        "Citation coverage is a grounding proxy, not semantic entailment.",
        "The three bundled structures compress real-world code volume for CI safety.",
    ]


def _markdown(report: WikiEvaluationReport) -> str:
    lines = [
        "# Wiki Producer Evaluation",
        "",
        f"Generated: {report.generated_at.isoformat()}",
        f"Mode: `{report.mode}`; repeats: {report.repeats}; Skill: `{report.skill_digest}`",
        "",
        "## Decision",
        "",
        f"**{report.decision}**" + (" (provisional)" if report.provisional else ""),
        "",
        *[f"- {item}" for item in report.rationale],
        "",
        "## Limits",
        "",
        "```json",
        report.limits.model_dump_json(indent=2),
        "```",
    ]
    if report.measured_failures:
        lines.extend(
            ("", "Measured failures:", *[f"- {item}" for item in report.measured_failures])
        )
    for case in report.cases:
        lines.extend(
            (
                "",
                f"## {case.id}",
                "",
                f"{case.size}; {case.structure}; `{case.source_revision}`; "
                f"{case.source_file_count} files / {case.source_bytes} bytes.",
                f"Material stability: {case.material_stability:.3f}; identical output: {case.identical_output}.",
                "",
                "| Run | Status | Model | Digest | Latency | Usage | Cost |",
                "| --- | --- | --- | --- | ---: | --- | --- |",
            )
        )
        for run in case.runs:
            lines.append(
                f"| {run.repeat} | {run.status} | {run.model_identity or run.configured_model} | "
                f"{run.content_digest or '-'} | {run.latency_seconds:.3f}s | "
                f"{run.usage or 'unavailable'} | {run.cost_usd if run.cost_usd is not None else 'unavailable'} |"
            )
            if run.quality:
                lines.append(
                    f"Run {run.repeat}: grounding={run.quality.grounding_proxy:.3f}, "
                    f"coverage={run.quality.topic_coverage:.3f}, navigation={run.quality.navigation:.3f}, "
                    f"duplication={run.quality.duplication:.3f}, organization={run.quality.organization:.3f}, "
                    f"unsupported={run.quality.unsupported_statement_count}."
                )
        for page in case.representative_pages:
            lines.extend(
                (
                    "",
                    f"### Representative page: {page['path']}",
                    "",
                    f"SHA-256: `{page['sha256']}`",
                    "",
                    "````markdown",
                    page["excerpt"],
                    "````",
                )
            )
    lines.extend(("", "## Trade-offs", "", *[f"- {item}" for item in report.trade_offs]))
    return "\n".join(lines) + "\n"
