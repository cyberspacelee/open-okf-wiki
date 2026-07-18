"""End-to-end evaluation for the single-Agent Wiki producer."""

import json
import posixpath
import unicodedata
from collections import Counter
from datetime import UTC, datetime
from difflib import SequenceMatcher
from operator import gt, lt
from pathlib import Path
from typing import Literal, cast
from urllib.parse import unquote, urlsplit

import genai_prices
from markdown_it import MarkdownIt
from mdit_py_plugins.front_matter import front_matter_plugin
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_ai import ModelResponse, ModelSettings, ToolCallPart
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import KnownModelName, Model, ModelRequestParameters
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_evals import Case, Dataset
from pydantic_evals.reporting import ReportCase

from ..errors import operator_error
from ..security import git_read_bytes, safe_error_message
from ..wiki_run import (
    PUBLICATION_METADATA_NAME,
    Complete,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)
from .wiki_evaluation_fixture import fixture_cases, fixture_model


class _SemanticReview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    factual_grounding: float = Field(ge=0, le=1)
    citation_quality: float = Field(ge=0, le=1)
    unsupported_statement_count: int = Field(ge=0)
    useful_coverage: float = Field(ge=0, le=1)
    page_organization: float = Field(ge=0, le=1)
    reader_usefulness: float = Field(ge=0, le=1)


class _Review(_SemanticReview):
    case: str
    repeat: int = Field(ge=1)


class _ReviewFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["wiki-evaluation-review-v1"]
    reviews: list[_Review] = Field(min_length=1)


class _QualityReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    grounding_proxy: float = Field(ge=0, le=1)
    topic_coverage: float = Field(ge=0, le=1)
    navigation: float = Field(ge=0, le=1)
    duplication: float = Field(ge=0, le=1)
    organization: float = Field(ge=0, le=1)
    page_paths: list[str]
    covered_topics: list[str]
    cited_source_paths: list[str]
    semantic_review: _SemanticReview | None = None


class _EvaluationRun(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    repeat: int = Field(ge=1)
    status: Literal["complete", "needs_input", "failed"]
    source_revision: str
    skill_digest: str
    configured_model: str
    model_identity: str | None = None
    content_digest: str | None = None
    latency_seconds: float = Field(default=0, ge=0)
    usage: dict[str, int]
    pricing_status: Literal["priced", "unavailable", "not_applicable"]
    cost_usd: float | None = Field(default=None, ge=0)
    cost_note: str
    quality: _QualityReport | None = None
    failure: str | None = None


class _EvaluationCaseReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    size: Literal["small", "medium", "large"]
    structure: str
    repository: str
    source_revision: str
    source_file_count: int = Field(gt=0)
    source_bytes: int = Field(gt=0)
    expected_topics: list[str]
    runs: list[_EvaluationRun] = Field(min_length=2)
    material_stability: float = Field(ge=0, le=1)
    identical_output: bool
    representative_pages: list[dict[str, str]]


class WikiEvaluationReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["wiki-evaluation-v2"] = "wiki-evaluation-v2"
    generated_at: datetime
    mode: Literal["fixture", "live"]
    manifest: str | None
    review: str | None
    repeats: int = Field(ge=2)
    skill_digest: str
    limits: WikiRunLimits
    thresholds: dict[str, float]
    cases: list[_EvaluationCaseReport] = Field(min_length=1)
    decision: Literal["pending_review", "retain_single_agent", "open_capability_ticket"]
    pending_review_items: list[str]
    actual_failures: list[str]
    measured_failures: list[str]
    trade_offs: list[str]


class _Case(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    size: Literal["small", "medium", "large"]
    structure: str
    repository: Path
    revision: str = Field(pattern=r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
    expected_topics: list[str] = Field(min_length=1)
    fixture_pages: dict[str, str] | None = Field(default=None, exclude=True)


class _Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["wiki-evaluation-repositories-v1"]
    cases: list[_Case] = Field(min_length=1)


class _ObservedModel(WrapperModel):
    def __init__(self, wrapped: Model | str):
        super().__init__(cast(KnownModelName, wrapped) if isinstance(wrapped, str) else wrapped)
        self.responses: list[ModelResponse] = []

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        response = await super().request(messages, model_settings, model_request_parameters)
        self.responses.append(response)
        return response


_THRESHOLDS = {
    "grounding_proxy_min": 1.0,
    "topic_coverage_min": 0.75,
    "navigation_min": 0.8,
    "duplication_max": 0.2,
    "organization_min": 0.8,
    "material_stability_min": 0.8,
    "factual_grounding_min": 0.9,
    "citation_quality_min": 0.9,
    "unsupported_statement_count_max": 0.0,
    "useful_coverage_min": 0.75,
    "page_organization_min": 0.8,
    "reader_usefulness_min": 0.8,
}
_MARKDOWN = MarkdownIt("commonmark").use(front_matter_plugin)
_FIXTURE_LIMITS = WikiRunLimits(
    request_limit=3,
    tool_calls_limit=2,
    retries=0,
    request_timeout_seconds=5,
    tool_timeout_seconds=5,
    wall_clock_timeout_seconds=30,
)
type _Artifacts = tuple[dict[str, str], dict[str, str]]


async def evaluate_wiki_producer(
    workspace: Path,
    *,
    model: Model | str | None = None,
    repeats: int = 2,
    limits: WikiRunLimits | None = None,
    skill: ProducerSkillVersion | None = None,
    manifest: Path | None = None,
    review: Path | None = None,
) -> WikiEvaluationReport:
    """Evaluate fixtures or explicitly selected live repositories through WikiRun."""
    if repeats < 2:
        raise ValueError("Wiki evaluation requires at least two repeats")
    if model is None and (manifest is not None or review is not None):
        raise ValueError("Fixture evaluation does not accept a repository manifest or review")
    if model is not None and manifest is None:
        raise ValueError("Live Wiki evaluation requires an explicit repository manifest")
    mode: Literal["fixture", "live"] = "fixture" if model is None else "live"
    root = workspace.absolute()
    try:
        root.mkdir(parents=True, exist_ok=False)
    except FileExistsError as error:
        raise ValueError("Wiki evaluation workspace must not already exist") from error

    selected_skill = skill or ProducerSkillVersion.default()
    selected_limits = limits or (_FIXTURE_LIMITS if mode == "fixture" else WikiRunLimits())
    cases, manifest_path = _cases(root, manifest)
    reviews, review_path = _reviews(review, cases, repeats)
    run_counts: Counter[str] = Counter()
    artifacts: dict[tuple[str, int], _Artifacts] = {}

    async def run_case(case: _Case) -> _EvaluationRun:
        run_counts[case.id] += 1
        repeat = run_counts[case.id]
        run_root = root / "cases" / case.id / f"run-{repeat:02}"
        observed = _ObservedModel(
            fixture_model(case.id, cast(dict[str, str], case.fixture_pages))
            if mode == "fixture"
            else cast(Model | str, model)
        )
        try:
            result = await WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(
                        RepositorySnapshot(path=case.repository, revision=case.revision),
                    ),
                    skill=selected_skill,
                    model=ModelProviderConfig(model=observed),
                    limits=selected_limits,
                    staging=run_root / "staging",
                    publication=run_root / "wiki",
                )
            )
            if not isinstance(result, Complete):
                return _run(
                    observed,
                    mode,
                    repeat,
                    "needs_input",
                    case.revision,
                    selected_skill.digest,
                    failure="Needs Input: " + "; ".join(result.questions),
                )
            publication = run_root / "wiki"
            metadata = json.loads((publication / PUBLICATION_METADATA_NAME).read_bytes())
            from ..wiki_run import resolve_effective_source_ignores

            expected_repositories = [
                {
                    "id": "source",
                    "ignore": [],
                    "revision": case.revision,
                    "apply_default_source_ignores": True,
                    "effective_ignore": list(
                        resolve_effective_source_ignores(
                            apply_default_source_ignores=True,
                            user_ignore=(),
                        )
                    ),
                }
            ]
            if (
                metadata["repositories"] != expected_repositories
                or metadata["skill_digest"] != selected_skill.digest
            ):
                raise ValueError("Published Wiki provenance does not match evaluation inputs")
            pages = {
                page["path"]: (publication / page["path"]).read_text(encoding="utf-8")
                for page in metadata["pages"]
            }
            artifacts[(case.id, repeat)] = (
                pages,
                {page["path"]: page["sha256"] for page in metadata["pages"]},
            )
            return _run(
                observed,
                mode,
                repeat,
                "complete",
                case.revision,
                selected_skill.digest,
                model_identity=metadata["model"],
                content_digest=metadata["content_digest"],
                quality=_quality(pages, case.expected_topics, reviews.get((case.id, repeat))),
            )
        except Exception as error:
            return _run(
                observed,
                mode,
                repeat,
                "failed",
                case.revision,
                selected_skill.digest,
                failure=f"{type(error).__name__}: {safe_error_message(error)}",
            )

    evaluated = await Dataset[_Case, _EvaluationRun, None](
        name="repository-wiki-producer",
        cases=[Case(name=case.id, inputs=case) for case in cases],
    ).evaluate(run_case, repeat=repeats, max_concurrency=1, progress=False)
    case_reports = _case_reports(cases, evaluated.cases, artifacts, repeats)
    pending = _pending(mode, case_reports)
    measured = _measured_failures(case_reports)
    decision: Literal["pending_review", "retain_single_agent", "open_capability_ticket"] = (
        "pending_review"
        if pending
        else "open_capability_ticket"
        if measured
        else "retain_single_agent"
    )
    report = WikiEvaluationReport(
        generated_at=datetime.now(UTC),
        mode=mode,
        manifest=str(manifest_path) if manifest_path else None,
        review=str(review_path) if review_path else None,
        repeats=repeats,
        skill_digest=selected_skill.digest,
        limits=selected_limits,
        thresholds=_THRESHOLDS,
        cases=case_reports,
        decision=decision,
        pending_review_items=pending,
        actual_failures=[
            f"{case.id} run {run.repeat}: {run.failure}"
            for case in case_reports
            for run in case.runs
            if run.failure
        ],
        measured_failures=measured,
        trade_offs=[
            (
                "Fixture mode checks the public seam only; it cannot support a capability decision."
                if mode == "fixture"
                else "Human review remains necessary for semantic grounding and reader usefulness."
            ),
            "Automated topic coverage is lexical and does not prove exhaustive knowledge coverage.",
            "Material stability permits prose variation but penalizes normalized content drift.",
        ],
    )
    (root / "wiki-evaluation.json").write_text(
        report.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    (root / "wiki-evaluation.md").write_text(_markdown(report), encoding="utf-8")
    return report


def _cases(root: Path, manifest: Path | None) -> tuple[list[_Case], Path | None]:
    if manifest is not None:
        path = manifest.resolve(strict=True)
        try:
            selected = _Manifest.model_validate_json(path.read_bytes())
        except (OSError, UnicodeError, ValidationError, ValueError) as error:
            raise operator_error(f"Wiki evaluation manifest is invalid: {path}", error) from error
        ids = [case.id for case in selected.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("Wiki evaluation repository case IDs must be unique")
        return [
            case.model_copy(
                update={"repository": (path.parent / case.repository).resolve(strict=True)}
            )
            for case in selected.cases
        ], path

    return [
        _Case(
            id=case.id,
            size=case.size,
            structure=case.structure,
            repository=case.repository,
            revision=case.revision,
            expected_topics=case.expected_topics,
            fixture_pages=case.pages,
        )
        for case in fixture_cases(root)
    ], None


def _reviews(
    path: Path | None, cases: list[_Case], repeats: int
) -> tuple[dict[tuple[str, int], _SemanticReview], Path | None]:
    if path is None:
        return {}, None
    resolved = path.resolve(strict=True)
    try:
        entries = _ReviewFile.model_validate_json(resolved.read_bytes()).reviews
    except (OSError, UnicodeError, ValidationError, ValueError) as error:
        raise operator_error(
            f"Wiki evaluation reviews file is invalid: {resolved}", error
        ) from error
    keys = [(entry.case, entry.repeat) for entry in entries]
    allowed = {(case.id, repeat) for case in cases for repeat in range(1, repeats + 1)}
    if len(keys) != len(set(keys)) or not set(keys) <= allowed:
        raise ValueError(
            "Wiki evaluation reviews must be unique and match selected case/repeat entries"
        )
    try:
        return {
            key: _SemanticReview.model_validate(entry.model_dump(exclude={"case", "repeat"}))
            for key, entry in zip(keys, entries)
        }, resolved
    except ValidationError as error:
        raise operator_error(
            f"Wiki evaluation review entries are invalid: {resolved}", error
        ) from error


def _run(
    observed: _ObservedModel,
    mode: Literal["fixture", "live"],
    repeat: int,
    status: Literal["complete", "needs_input", "failed"],
    revision: str,
    skill_digest: str,
    *,
    model_identity: str | None = None,
    content_digest: str | None = None,
    quality: _QualityReport | None = None,
    failure: str | None = None,
) -> _EvaluationRun:
    usage, pricing_status, cost, cost_note = _usage_and_cost(observed.responses, mode)
    return _EvaluationRun(
        repeat=repeat,
        status=status,
        source_revision=revision,
        skill_digest=skill_digest,
        configured_model=observed.model_name,
        model_identity=model_identity
        if model_identity is not None
        else observed.responses[-1].model_name
        if observed.responses
        else None,
        content_digest=content_digest,
        usage=usage,
        pricing_status=pricing_status,
        cost_usd=cost,
        cost_note=cost_note,
        quality=quality,
        failure=failure,
    )


def _usage_and_cost(
    responses: list[ModelResponse], mode: Literal["fixture", "live"]
) -> tuple[dict[str, int], Literal["priced", "unavailable", "not_applicable"], float | None, str]:
    fields = (
        "input_tokens",
        "cache_write_tokens",
        "cache_read_tokens",
        "output_tokens",
        "input_audio_tokens",
        "cache_audio_read_tokens",
        "output_audio_tokens",
    )
    usage = {
        "requests": len(responses),
        "tool_calls": sum(
            isinstance(part, ToolCallPart) for response in responses for part in response.parts
        ),
        **{name: sum(getattr(response.usage, name) for response in responses) for name in fields},
    }
    usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
    if mode == "fixture":
        return usage, "not_applicable", 0, "Deterministic local fixture; no provider billing."
    if not responses:
        return usage, "unavailable", None, "Unavailable: no model response was observed."
    prices = []
    for index, response in enumerate(responses, 1):
        if not response.model_name:
            return (
                usage,
                "unavailable",
                None,
                f"Unavailable: response {index} omitted model identity.",
            )
        try:
            if response.provider_name:
                price = genai_prices.calc_price(
                    response.usage,
                    response.model_name,
                    provider_id=response.provider_name,
                    genai_request_timestamp=response.timestamp,
                )
            elif response.provider_url:
                price = genai_prices.calc_price(
                    response.usage,
                    response.model_name,
                    provider_api_url=response.provider_url,
                    genai_request_timestamp=response.timestamp,
                )
            else:
                price = genai_prices.calc_price(
                    response.usage,
                    response.model_name,
                    genai_request_timestamp=response.timestamp,
                )
            prices.append(price.total_price)
        except Exception as error:
            return (
                usage,
                "unavailable",
                None,
                "Unavailable: genai-prices has no exact model/provider match for "
                f"response {index} ({type(error).__name__}).",
            )
    return usage, "priced", float(sum(prices)), f"Priced {len(prices)} responses with genai-prices."


def _quality(
    pages: dict[str, str], expected_topics: list[str], review: _SemanticReview | None
) -> _QualityReport:
    facts = {path: _markdown_facts(text) for path, text in pages.items()}
    links = {path: values[0] for path, values in facts.items()}
    combined = "\n".join(pages.values()).casefold()
    covered = [topic for topic in expected_topics if topic.casefold() in combined]
    paragraphs = [item for _, items, _ in facts.values() for item in items]
    counts = Counter(paragraphs)
    return _QualityReport(
        grounding_proxy=round(
            sum(any(link.startswith("repo:") for link in values) for values in links.values())
            / len(pages),
            6,
        ),
        topic_coverage=round(len(covered) / len(expected_topics), 6),
        navigation=round(_navigation(pages, links), 6),
        duplication=round(
            sum(count - 1 for count in counts.values()) / len(paragraphs) if paragraphs else 0,
            6,
        ),
        organization=round(sum(values[2] for values in facts.values()) / len(pages), 6),
        page_paths=sorted(pages),
        covered_topics=covered,
        cited_source_paths=sorted(
            {
                link.removeprefix("repo:").partition("#")[0]
                for values in links.values()
                for link in values
                if link.startswith("repo:")
            }
        ),
        semantic_review=review,
    )


def _markdown_facts(text: str) -> tuple[list[str], list[str], bool]:
    tokens = _MARKDOWN.parse(text)
    links = [
        target
        for token in tokens
        for child in token.children or []
        if child.type == "link_open"
        if isinstance((target := child.attrGet("href")), str)
    ]
    paragraphs = [
        normalized
        for index, token in enumerate(tokens)
        if token.type == "inline"
        and index > 0
        and tokens[index - 1].type == "paragraph_open"
        and len(normalized := " ".join(token.content.split()).casefold()) >= 40
    ]
    return links, paragraphs, any(token.type == "heading_open" for token in tokens)


def _navigation(pages: dict[str, str], links: dict[str, list[str]]) -> float:
    reachable, pending = {"index.md"}, ["index.md"]
    while pending:
        source = pending.pop()
        for target in links.get(source, []):
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


def _case_reports(
    cases: list[_Case],
    evaluated: list[ReportCase[_Case, _EvaluationRun, None]],
    artifacts: dict[tuple[str, int], _Artifacts],
    repeats: int,
) -> list[_EvaluationCaseReport]:
    reports = []
    for case in cases:
        items = sorted(
            (item for item in evaluated if (item.source_case_name or item.name) == case.id),
            key=lambda item: item.output.repeat,
        )
        runs = [
            item.output.model_copy(update={"latency_seconds": item.task_duration}) for item in items
        ]
        if len(runs) != repeats:
            raise RuntimeError(f"pydantic-evals did not return every repeat for {case.id}")
        stability, identical = _stability(runs, artifacts, case.id)
        count, size = _source_stats(case.repository, case.revision)
        first = next(
            (artifacts[(case.id, run.repeat)] for run in runs if run.status == "complete"), None
        )
        reports.append(
            _EvaluationCaseReport(
                id=case.id,
                size=case.size,
                structure=case.structure,
                repository=str(case.repository),
                source_revision=case.revision,
                source_file_count=count,
                source_bytes=size,
                expected_topics=case.expected_topics,
                runs=runs,
                material_stability=stability,
                identical_output=identical,
                representative_pages=_representative_pages(first),
            )
        )
    return reports


def _source_stats(repository: Path, revision: str) -> tuple[int, int]:
    records = git_read_bytes(repository, "ls-tree", "-r", "-l", "--full-tree", "-z", revision)
    sizes = [int(item.split(b"\t", 1)[0].split()[3]) for item in records.split(b"\0") if item]
    if not sizes:
        raise ValueError("Wiki evaluation repository snapshot must contain files")
    return len(sizes), sum(sizes)


def _stability(
    runs: list[_EvaluationRun], artifacts: dict[tuple[str, int], _Artifacts], case_id: str
) -> tuple[float, bool]:
    complete = [run for run in runs if run.quality is not None]
    if len(complete) < 2:
        return 0, False
    scores = []
    for index, left in enumerate(complete):
        assert left.quality is not None
        left_set = set(
            left.quality.page_paths + left.quality.covered_topics + left.quality.cited_source_paths
        )
        left_content = _normalized_markdown(artifacts[(case_id, left.repeat)][0])
        for right in complete[index + 1 :]:
            assert right.quality is not None
            right_set = set(
                right.quality.page_paths
                + right.quality.covered_topics
                + right.quality.cited_source_paths
            )
            structural = (
                len(left_set & right_set) / len(left_set | right_set) if left_set | right_set else 1
            )
            content = SequenceMatcher(
                None,
                left_content,
                _normalized_markdown(artifacts[(case_id, right.repeat)][0]),
                autojunk=False,
            ).ratio()
            scores.append(min(structural, content))
    return round(min(scores), 6), len({run.content_digest for run in complete}) == 1


def _normalized_markdown(pages: dict[str, str]) -> str:
    return "\n".join(
        f"{path}\n{' '.join(unicodedata.normalize('NFKC', pages[path]).casefold().split())}"
        for path in sorted(pages)
    )


def _representative_pages(artifacts: _Artifacts | None) -> list[dict[str, str]]:
    if artifacts is None:
        return []
    pages, hashes = artifacts
    return [
        {"path": path, "sha256": hashes[path], "excerpt": content.strip()[:600]}
        for path, content in list(sorted(pages.items()))[:2]
    ]


def _pending(mode: Literal["fixture", "live"], cases: list[_EvaluationCaseReport]) -> list[str]:
    if mode == "fixture":
        return [
            "Run the real-repository manifest with a live model and review every completed Wiki."
        ]
    return [
        f"{case.id} run {run.repeat}: "
        + (
            f"rerun is required before semantic review ({run.status})"
            if run.status != "complete"
            else "semantic/human review is required"
        )
        for case in cases
        for run in case.runs
        if run.status != "complete" or run.quality is None or run.quality.semantic_review is None
    ]


def _measured_failures(cases: list[_EvaluationCaseReport]) -> list[str]:
    failures = []
    rules = (
        ("grounding_proxy", "grounding_proxy_min", False, lt),
        ("topic_coverage", "topic_coverage_min", False, lt),
        ("navigation", "navigation_min", False, lt),
        ("duplication", "duplication_max", False, gt),
        ("organization", "organization_min", False, lt),
        ("factual_grounding", "factual_grounding_min", True, lt),
        ("citation_quality", "citation_quality_min", True, lt),
        ("unsupported_statement_count", "unsupported_statement_count_max", True, gt),
        ("useful_coverage", "useful_coverage_min", True, lt),
        ("page_organization", "page_organization_min", True, lt),
        ("reader_usefulness", "reader_usefulness_min", True, lt),
    )
    for case in cases:
        if sum(run.status != "complete" for run in case.runs) >= 2:
            failures.append(f"{case.id}: Wiki Run did not complete twice")
        for name, threshold_name, reviewed, failed in rules:
            values = [
                run.quality.semantic_review if reviewed else run.quality
                for run in case.runs
                if run.quality is not None
                and (not reviewed or run.quality.semantic_review is not None)
            ]
            if (
                sum(failed(getattr(value, name), _THRESHOLDS[threshold_name]) for value in values)
                >= 2
            ):
                failures.append(f"{case.id}: {name} repeatedly missed its threshold")
        if case.material_stability < _THRESHOLDS["material_stability_min"]:
            failures.append(f"{case.id}: material_stability missed its threshold")
    return failures


def _markdown(report: WikiEvaluationReport) -> str:
    lines = [
        "# Wiki Producer Evaluation",
        "",
        f"Generated: {report.generated_at.isoformat()}",
        f"Mode: `{report.mode}`; repeats: {report.repeats}; Skill: `{report.skill_digest}`",
        "",
        "## Decision",
        "",
        f"**{report.decision}**",
    ]
    for title, items in (
        ("Pending review", report.pending_review_items),
        ("Actual failures", report.actual_failures),
        ("Measured failures", report.measured_failures),
    ):
        if items:
            lines += ["", f"## {title}", "", *[f"- {item}" for item in items]]
    lines += ["", "## Limits", "", "```json", report.limits.model_dump_json(indent=2), "```"]
    for case in report.cases:
        lines += [
            "",
            f"## {case.id}",
            "",
            f"{case.size}; {case.structure}; `{case.source_revision}`; "
            f"{case.source_file_count} files / {case.source_bytes} bytes.",
            f"Material stability: {case.material_stability:.3f}; identical output: {case.identical_output}.",
            "",
            "| Run | Status | Model | Digest | Latency | Usage | Pricing | Cost |",
            "| --- | --- | --- | --- | ---: | --- | --- | ---: |",
        ]
        for run in case.runs:
            lines.append(
                f"| {run.repeat} | {run.status} | {run.model_identity or run.configured_model} | "
                f"{run.content_digest or '-'} | {run.latency_seconds:.3f}s | {run.usage} | "
                f"{run.pricing_status} | {run.cost_usd if run.cost_usd is not None else 'unavailable'} |"
            )
            if run.quality:
                lines.append(
                    f"Run {run.repeat}: grounding={run.quality.grounding_proxy:.3f}, "
                    f"coverage={run.quality.topic_coverage:.3f}, navigation={run.quality.navigation:.3f}, "
                    f"duplication={run.quality.duplication:.3f}, organization={run.quality.organization:.3f}, "
                    f"semantic review={run.quality.semantic_review}."
                )
            if run.failure:
                lines.append(f"Run {run.repeat} failure: {run.failure}")
        for page in case.representative_pages:
            lines += [
                "",
                f"### Representative page: {page['path']}",
                "",
                f"SHA-256: `{page['sha256']}`",
                "",
                "````markdown",
                page["excerpt"],
                "````",
            ]
    return (
        "\n".join(lines + ["", "## Trade-offs", "", *[f"- {x}" for x in report.trade_offs]]) + "\n"
    )
