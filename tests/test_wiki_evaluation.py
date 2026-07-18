import asyncio
import json
import subprocess
from argparse import Namespace
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.cli import main
from okf_wiki.wiki_evaluation import WikiEvaluationReport, evaluate_wiki_producer
from okf_wiki.wiki_run import WikiRunApplication, WikiRunRequest


ROOT = Path(__file__).parents[1]
REAL_MANIFEST = ROOT / "src/okf_wiki/evaluation/wiki_evaluation_repositories.json"


def make_repository(path: Path) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text("# Example\n\nAn example repository.\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def write_manifest(path: Path, repository: Path, revision: str) -> Path:
    path.write_text(
        json.dumps(
            {
                "schema_version": "wiki-evaluation-repositories-v1",
                "cases": [
                    {
                        "id": "example",
                        "size": "small",
                        "structure": "single-file example",
                        "repository": str(repository.relative_to(path.parent)),
                        "revision": revision,
                        "expected_topics": ["example repository"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def write_review(path: Path, *, failing: bool = False) -> Path:
    score = 0.2 if failing else 1.0
    path.write_text(
        json.dumps(
            {
                "schema_version": "wiki-evaluation-review-v1",
                "reviews": [
                    {
                        "case": "example",
                        "repeat": repeat,
                        "factual_grounding": score,
                        "citation_quality": score,
                        "unsupported_statement_count": 2 if failing else 0,
                        "useful_coverage": score,
                        "page_organization": score,
                        "reader_usefulness": score,
                    }
                    for repeat in (1, 2)
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def writing_model(*, drift: bool = False, model_name: str = "gpt-4o-mini") -> FunctionModel:
    producer_requests = 0

    def respond(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal producer_requests
        instructions = info.instructions or ""
        if "You are a Wiki Reviewer." in instructions:
            import re

            from pydantic_ai.messages import TextPart

            run_code_returns = [
                part
                for message in messages
                if isinstance(message, ModelRequest)
                for part in message.parts
                if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            ]
            if run_code_returns:
                content = run_code_returns[-1].content
                if isinstance(content, dict):
                    content = content.get("output", content)
                return ModelResponse(
                    parts=[TextPart(str(content).strip())],
                    usage=RequestUsage(input_tokens=12, output_tokens=8),
                )
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+), "
                r"attempt=(\d+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id, attempt = assignment.groups()
            code = (
                "handoff = publish_receipt("
                f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                f"attempt={attempt}, status='complete', scope='review:{task_id}', "
                "summary='evaluation review ok', findings=[])\nprint(handoff)"
            )
            return ModelResponse(
                parts=[ToolCallPart("run_code", {"code": code})],
                usage=RequestUsage(input_tokens=12, output_tokens=8),
            )

        producer_requests += 1
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            part = ToolCallPart(
                complete.name,
                {"status": "complete", "manifest": {"pages": ["index.md"]}},
            )
        else:
            run = (producer_requests + 1) // 2
            claim = (
                "The repository deletes all records permanently."
                if drift and run == 2
                else "This is an example repository."
            )
            page = (
                f"---\ntitle: Example\n---\n# Example\n\n{claim} [Source](repo:README.md#L1-L3)\n"
            )
            part = ToolCallPart(
                "run_code",
                {
                    "code": "from pathlib import Path\n"
                    f"Path('/wiki/index.md').write_text({page!r})",
                },
            )
        return ModelResponse(
            parts=[part],
            usage=RequestUsage(input_tokens=12, output_tokens=8),
        )

    return FunctionModel(respond, model_name=model_name)


def test_fixture_evaluation_is_credential_free_pending_and_repeatable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    calls: list[WikiRunRequest] = []
    original_run = WikiRunApplication.run

    async def observed(self: WikiRunApplication, request: WikiRunRequest):
        calls.append(request)
        return await original_run(self, request)

    monkeypatch.setattr(WikiRunApplication, "run", observed)
    workspace = tmp_path / "evaluation"

    report = asyncio.run(evaluate_wiki_producer(workspace))

    assert report.schema_version == "wiki-evaluation-v2"
    assert report.mode == "fixture"
    assert report.decision == "pending_review"
    assert report.pending_review_items == [
        "Run the real-repository manifest with a live model and review every completed Wiki."
    ]
    assert [case.size for case in report.cases] == ["small", "medium", "large"]
    assert len(calls) == 6
    for case in report.cases:
        assert len(case.runs) == 2
        assert case.material_stability == 1
        for run in case.runs:
            assert run.status == "complete"
            # Producer (2) + Host Wiki Reviewer (2 run_code/handoff turns + usage).
            assert run.usage["requests"] >= 2
            assert run.usage["tool_calls"] >= 2
            assert run.usage["total_tokens"] >= 40
            assert run.usage["cache_write_tokens"] == 0
            assert run.usage["cache_read_tokens"] == 0
            assert run.pricing_status == "not_applicable"
            assert run.cost_usd == 0
            assert run.quality is not None
            assert run.quality.semantic_review is None

    persisted = WikiEvaluationReport.model_validate_json(
        (workspace / "wiki-evaluation.json").read_bytes()
    )
    assert persisted == report
    markdown = (workspace / "wiki-evaluation.md").read_text(encoding="utf-8")
    assert "## Pending review" in markdown
    assert "Representative page" in markdown


def test_real_manifest_resolves_relative_repository_and_uses_public_wiki_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = tmp_path / "repositories" / "example"
    repository.parent.mkdir()
    revision = make_repository(repository)
    manifest = write_manifest(tmp_path / "repositories" / "manifest.json", repository, revision)
    calls: list[WikiRunRequest] = []
    original_run = WikiRunApplication.run

    async def observed(self: WikiRunApplication, request: WikiRunRequest):
        calls.append(request)
        return await original_run(self, request)

    monkeypatch.setattr(WikiRunApplication, "run", observed)
    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live",
            model=writing_model(),
            manifest=manifest,
        )
    )

    assert report.mode == "live"
    assert report.manifest == str(manifest.resolve())
    assert len(calls) == 2
    assert all(request.repositories[0].path == repository.resolve() for request in calls)
    assert all(request.repositories[0].revision == revision for request in calls)
    assert report.cases[0].repository == str(repository.resolve())


def test_live_usage_and_official_pricing_are_recorded_but_decision_waits_for_review(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    revision = make_repository(repository)
    manifest = write_manifest(tmp_path / "manifest.json", repository, revision)

    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live",
            model=writing_model(),
            manifest=manifest,
        )
    )

    assert report.decision == "pending_review"
    assert report.pending_review_items == [
        "example run 1: semantic/human review is required",
        "example run 2: semantic/human review is required",
    ]
    for run in report.cases[0].runs:
        # Producer + Host Wiki Reviewer model turns.
        assert run.usage["requests"] >= 2
        assert run.usage["total_tokens"] >= 40
        assert run.pricing_status == "priced"
        assert run.cost_usd is not None and run.cost_usd > 0
        assert "genai-prices" in run.cost_note


@pytest.mark.parametrize(
    ("failing", "decision"),
    [(False, "retain_single_agent"), (True, "open_capability_ticket")],
)
def test_only_complete_live_review_can_make_a_capability_decision(
    tmp_path: Path, failing: bool, decision: str
) -> None:
    repository = tmp_path / "repository"
    revision = make_repository(repository)
    manifest = write_manifest(tmp_path / "manifest.json", repository, revision)
    review = write_review(tmp_path / "review.json", failing=failing)

    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live",
            model=writing_model(),
            manifest=manifest,
            review=review,
        )
    )

    assert report.decision == decision
    assert not report.pending_review_items
    assert bool(report.measured_failures) is failing
    assert all(run.quality and run.quality.semantic_review for run in report.cases[0].runs)


def test_material_stability_detects_contradictory_markdown_with_same_structure(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    revision = make_repository(repository)
    manifest = write_manifest(tmp_path / "manifest.json", repository, revision)

    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live",
            model=writing_model(drift=True),
            manifest=manifest,
        )
    )

    case = report.cases[0]
    assert case.runs[0].quality is not None and case.runs[1].quality is not None
    assert case.runs[0].quality.page_paths == case.runs[1].quality.page_paths
    assert case.runs[0].quality.cited_source_paths == case.runs[1].quality.cited_source_paths
    assert case.material_stability < 1
    assert not case.identical_output


def test_markdown_lists_pending_review_and_actual_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = tmp_path / "repository"
    revision = make_repository(repository)
    manifest = write_manifest(tmp_path / "manifest.json", repository, revision)

    async def fail(_: WikiRunApplication, __: WikiRunRequest):
        raise ValueError("invalid generated Wiki")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live",
            model=writing_model(),
            manifest=manifest,
        )
    )

    assert report.decision == "pending_review"
    assert report.actual_failures == [
        "example run 1: ValueError: invalid generated Wiki",
        "example run 2: ValueError: invalid generated Wiki",
    ]
    markdown = (tmp_path / "live/wiki-evaluation.md").read_text(encoding="utf-8")
    assert "## Pending review" in markdown
    assert "rerun is required before semantic review" in markdown
    assert "## Actual failures" in markdown
    assert "invalid generated Wiki" in markdown


def test_bundled_real_manifest_pins_three_clean_structurally_different_refs() -> None:
    manifest = json.loads(REAL_MANIFEST.read_text(encoding="utf-8"))

    assert [case["size"] for case in manifest["cases"]] == ["small", "medium", "large"]
    assert len({case["structure"] for case in manifest["cases"]}) == 3
    assert [case["revision"] for case in manifest["cases"]] == [
        "ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d",
        "34b50679bd723579fa0b1dd80dfa0537237fce37",
        "96563d1ea9b51b5854c5651a7091d8f96512f4cd",
    ]
    for case in manifest["cases"]:
        repository = (REAL_MANIFEST.parent / case["repository"]).resolve()
        assert (
            subprocess.run(
                ["git", "status", "--porcelain=v1", "--untracked-files=all"],
                cwd=repository,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            == ""
        )
        assert (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=repository,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            == case["revision"]
        )


def test_wiki_evaluation_cli_selects_fixture_by_default_and_passes_live_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    called: list[Namespace] = []

    async def evaluate(workspace: Path, **options):
        called.append(Namespace(workspace=workspace, **options))
        return Namespace(decision="pending_review")

    monkeypatch.setattr("okf_wiki.wiki_evaluation.evaluate_wiki_producer", evaluate)
    output = tmp_path / "evaluation"
    manifest = tmp_path / "manifest.json"
    review = tmp_path / "review.json"
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-eval",
            str(output),
            "--model",
            "test:model",
            "--manifest",
            str(manifest),
            "--review",
            str(review),
        ],
    )

    assert main() == 0
    assert called == [
        Namespace(
            workspace=output,
            model="test:model",
            repeats=2,
            skill=called[0].skill,
            manifest=manifest,
            review=review,
        )
    ]
    assert json.loads(capsys.readouterr().out) == {
        "decision": "pending_review",
        "ok": True,
        "reports": {
            "json": str(output / "wiki-evaluation.json"),
            "markdown": str(output / "wiki-evaluation.md"),
        },
    }
