import asyncio
import json
from argparse import Namespace
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.cli import main
from okf_wiki.wiki_evaluation import WikiEvaluationReport, evaluate_wiki_producer
from okf_wiki.wiki_run import WikiRunApplication, WikiRunRequest


def test_fixture_evaluation_uses_the_public_wiki_run_and_writes_reviewable_reports(
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

    assert report.schema_version == "wiki-evaluation-v1"
    assert report.mode == "fixture"
    assert report.repeats == 2
    assert [case.size for case in report.cases] == ["small", "medium", "large"]
    assert len({case.structure for case in report.cases}) == 3
    assert len(calls) == 6
    assert all(isinstance(request, WikiRunRequest) for request in calls)
    assert all(request.skill.digest == report.skill_digest for request in calls)
    for case in report.cases:
        assert len(case.source_revision) in {40, 64}
        assert case.source_file_count > 0
        assert case.source_bytes > 0
        assert len(case.runs) == 2
        for run in case.runs:
            assert run.status == "complete"
            assert run.source_revision == case.source_revision
            assert run.skill_digest == report.skill_digest
            assert run.model_identity is not None and run.model_identity.startswith("fixture:")
            assert len(run.content_digest or "") == 64
            assert run.latency_seconds >= 0
            assert run.usage == {
                "requests": 2,
                "tool_calls": 2,
                "input_tokens": 24,
                "output_tokens": 16,
                "total_tokens": 40,
            }
            assert run.cost_usd == 0
            assert run.quality is not None
            assert (
                run.quality.grounding_proxy,
                run.quality.topic_coverage,
                run.quality.navigation,
                run.quality.duplication,
                run.quality.organization,
                run.quality.unsupported_statement_count,
            ) == (1, 1, 1, 0, 1, 0)
        assert case.material_stability == 1
        assert case.materially_stable
        assert case.representative_pages
        assert not case.failures
    assert report.decision == "retain_single_agent"
    assert report.provisional
    assert not report.measured_failures
    assert report.trade_offs

    json_path = workspace / "wiki-evaluation.json"
    markdown_path = workspace / "wiki-evaluation.md"
    persisted = WikiEvaluationReport.model_validate_json(json_path.read_bytes())
    assert persisted == report
    markdown = markdown_path.read_text(encoding="utf-8")
    assert "# Wiki Producer Evaluation" in markdown
    assert "## Decision" in markdown
    assert "## Trade-offs" in markdown
    assert "Representative page" in markdown


def test_live_evaluation_is_opt_in_and_does_not_invent_usage_or_billing(
    tmp_path: Path,
) -> None:
    code = """from pathlib import Path
Path('/wiki/index.md').write_text('''---
title: Evaluation
---
# Evaluation

[Source](repo:README.md#L1-L1)
''')
"""

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
                {"status": "complete", "manifest": {"pages": ["index.md"]}},
            )
        else:
            part = ToolCallPart("run_code", {"code": code})
        return ModelResponse(parts=[part], model_name="live-test-model")

    report = asyncio.run(
        evaluate_wiki_producer(
            tmp_path / "live-evaluation",
            model=FunctionModel(respond, model_name="configured-live-test-model"),
        )
    )

    assert report.mode == "live"
    assert report.decision == "open_capability_ticket"
    assert report.provisional
    assert any("topic_coverage" in item for item in report.measured_failures)
    for case in report.cases:
        for run in case.runs:
            assert run.status == "complete"
            assert run.model_identity == "configured-live-test-model"
            assert run.usage is None
            assert run.cost_usd is None
            assert run.quality is not None
            assert run.quality.unsupported_statement_count is None
            assert run.quality.reader_usefulness is None
            assert run.quality.manual_review


def test_wiki_evaluation_cli_defaults_to_fixture_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    called: list[Namespace] = []

    async def evaluate(workspace: Path, **options):
        called.append(Namespace(workspace=workspace, **options))
        return Namespace(decision="retain_single_agent", provisional=True)

    monkeypatch.setattr("okf_wiki.wiki_evaluation.evaluate_wiki_producer", evaluate)
    output = tmp_path / "evaluation"
    monkeypatch.setattr("sys.argv", ["okf-wiki", "wiki-eval", str(output)])

    assert main() == 0
    assert called == [
        Namespace(
            workspace=output,
            model=None,
            repeats=2,
            skill=called[0].skill,
        )
    ]
    assert json.loads(capsys.readouterr().out) == {
        "decision": "retain_single_agent",
        "ok": True,
        "provisional": True,
        "reports": {
            "json": str(output / "wiki-evaluation.json"),
            "markdown": str(output / "wiki-evaluation.md"),
        },
    }
