"""Credential, sandbox, and secret-free record tests."""

from __future__ import annotations

import asyncio
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai import Agent, ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.instrumented import InstrumentationSettings

from okf_wiki.host import (
    Complete,
    ModelProviderConfig,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
    resolve_effective_source_ignores,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    TEST_WIKI_LIMITS,
    analysis_workspace_paths,
    make_producer_skill,
    make_repository,
    run_records,
    run_test_wiki,
    write_pages_code,
    writing_model,
)


def test_complete_wiki_run_writes_a_bounded_secret_free_terminal_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    secret = "private-run-record-header"
    monkeypatch.setenv("OKF_RECORD_TOKEN", secret)
    events: list[WikiRunEvent] = []

    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(
                    RepositorySnapshot(
                        id="repo",
                        path=source,
                        revision=revision,
                        ignore=("generated/**",),
                    ),
                ),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    ),
                    settings={
                        "temperature": 0.25,
                        "stop_sequences": [secret],
                        "extra_headers": {"Authorization": f"Bearer {secret}"},
                    },
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
                auto_approve_publication=True,
            )
        )
    )

    [record] = run_records(publication)
    encoded = json.dumps(record, sort_keys=True).encode()
    assert isinstance(result, Complete)
    assert record["schema_version"] == 1
    assert record["run_id"] == events[0].run_id
    assert record["status"] == "complete"
    assert record["operation"] == "generate"
    assert record["repositories"] == [
        {
            "id": "repo",
            "path": str(source.resolve()),
            "revision": revision,
            "apply_default_source_ignores": True,
            "ignore": ["generated/**"],
            "effective_ignore": list(
                resolve_effective_source_ignores(
                    apply_default_source_ignores=True,
                    user_ignore=("generated/**",),
                )
            ),
        }
    ]
    assert record["skill"] == {"path": str(skill.path), "digest": skill.digest}
    assert record["model"] == {
        "identity": "function:model:",
        "replayable": False,
        "settings": {
            "temperature": 0.25,
            "stop_sequences": ["[REDACTED CREDENTIAL]"],
            "extra_headers": "[redacted]",
        },
    }
    assert record["limits"] == TEST_WIKI_LIMITS.model_dump(mode="json")
    assert record["explicit_answers"] == {}
    # Producer turns plus Host Wiki Reviewer child usage (isolated, still recorded).
    assert record["usage"]["requests"] >= 2
    assert record["retry_counters"] == {
        "provider": 0,
        "provider_attempts": 0,
        "provider_possible_duplicates": 0,
        "tool": 0,
        "output": 0,
    }
    assert record["publication"]["status"] == "published"
    assert record["publication"]["changed"] is True
    assert record["publication"]["reviewer"]["status"] == "complete"
    assert record["failure_category"] is None
    assert datetime.fromisoformat(record["started_at"]).tzinfo == UTC
    assert datetime.fromisoformat(record["completed_at"]).tzinfo == UTC
    assert record["duration_seconds"] >= 0
    assert len(encoded) <= 128 * 1024
    assert secret.encode() not in encoded


def test_failed_wiki_run_emits_a_terminal_event_and_secret_free_record(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    secret = "record-failure-secret"
    events: list[WikiRunEvent] = []

    def observe(event: WikiRunEvent) -> None:
        events.append(event)
        raise RuntimeError("observer failure")

    def fail(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"provider failed with {secret}")

    application = WikiRunApplication(observer=observe)
    with pytest.raises(RuntimeError, match="diagnostics withheld"):
        asyncio.run(
            application.run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=FunctionModel(fail),
                        settings={"extra_headers": {"Authorization": secret}},
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=publication,
                    auto_approve_publication=True,
                )
            )
        )

    [record] = run_records(publication)
    assert record["status"] == "failed"
    assert record["failure_category"] == "RuntimeError"
    assert secret.encode() not in json.dumps(record).encode()
    assert analysis_workspace_paths(events[0].run_id) == set()
    # Observer failures are swallowed; count is tracked without changing the run result.
    assert events
    assert application.last_observer_errors == len(events)
    assert application.last_observer_errors > 0


def test_codemode_exposes_only_the_three_mounts_and_no_host_capabilities(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    plugin_marker = tmp_path / "plugin-ran"
    (source / "plugin.py").write_text(
        f"from pathlib import Path\nPath({str(plugin_marker)!r}).write_text('ran')\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "plugin.py"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "adversarial plugin"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    skill = make_producer_skill(tmp_path / "skill")
    host_marker = tmp_path / "host-write"
    # Probe mount escapes only (Monty type-checks run_code; forbidden stdlib/import
    # probes that fail static analysis are covered by CodeMode sandbox policy itself).
    code = f"""from pathlib import Path
blocked = []
for path in [
    Path('/source/README.md'),
    Path('/skill/SKILL.md'),
    Path({str(host_marker)!r}),
    Path('/wiki/../../host-write'),
    Path('//tmp/host-write'),
]:
    try:
        path.write_text('escaped')
    except Exception:
        blocked.append(str(path))
assert len(blocked) == 5
symlink_blocked = False
try:
    Path('/wiki/link').symlink_to('/source/README.md')
except Exception:
    symlink_blocked = True
assert symlink_blocked
Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})
"""

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        # CodeMode exposes run_code; OverflowingToolOutput may add read_tool_result.
        tool_names = {tool.name for tool in info.function_tools}
        assert "run_code" in tool_names
        assert tool_names <= {"run_code", "read_tool_result"}
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    result = run_test_wiki(
        source,
        revision,
        skill,
        tmp_path / "staging",
        tmp_path / "published",
        FunctionModel(model),
    )

    assert isinstance(result, Complete)
    assert not host_marker.exists()
    assert not plugin_marker.exists()


def test_repository_instructions_are_only_readable_source_data(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    sentinel = "UNTRUSTED_SOURCE_POLICY_OVERRIDE"
    files = {
        "AGENTS.md": sentinel,
        "CLAUDE.md": sentinel,
        "SKILL.md": sentinel,
        ".codex-plugin/plugin.json": '{"instructions": "' + sentinel + '"}',
        "prompt.txt": sentinel,
    }
    for relative, content in files.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "untrusted instructions"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    skill = make_producer_skill(tmp_path / "skill")
    code = (
        "from pathlib import Path\n"
        f"paths = {list(files)!r}\n"
        f"assert all({sentinel!r} in Path('/source', path).read_text() for path in paths)\n"
        f"Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})\n"
    )

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        code_ran = any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        )
        if code_ran:
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        supplied = repr(messages) + repr(info.function_tools) + repr(info.instructions)
        assert sentinel not in supplied
        # CodeMode exposes run_code; OverflowingToolOutput may add read_tool_result.
        tool_names = {tool.name for tool in info.function_tools}
        assert "run_code" in tool_names
        assert tool_names <= {"run_code", "read_tool_result"}
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    result = run_test_wiki(
        source,
        revision,
        skill,
        tmp_path / "staging",
        tmp_path / "published",
        FunctionModel(model),
    )

    assert isinstance(result, Complete)
    assert sentinel not in (tmp_path / "published/index.md").read_text(encoding="utf-8")


def test_credentials_never_enter_the_agent_sandbox_artifacts_or_traces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    secrets = ("credential-sentinel-value", "header-sentinel-value")
    monkeypatch.setenv("OPENAI_API_KEY", secrets[0])
    monkeypatch.setenv("HTTP_AUTHORIZATION", secrets[1])
    initial_request = ""
    code = f"""from pathlib import Path
import os
environment = []
for name in ['OPENAI_API_KEY', 'HTTP_AUTHORIZATION']:
    try:
        environment.append(os.getenv(name))
    except Exception:
        environment.append(None)
assert environment == [None, None]
Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})
"""

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal initial_request
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        initial_request = (
            repr(messages)
            + repr(info.function_tools)
            + repr(info.output_tools)
            + repr(info.instructions)
        )
        assert not any(secret in initial_request for secret in secrets)
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    Agent.instrument_all(InstrumentationSettings(tracer_provider=provider, include_content=True))
    try:
        result = run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            tmp_path / "published",
            FunctionModel(model),
        )
    finally:
        Agent.instrument_all(False)
        provider.force_flush()

    observable = (initial_request + repr(result)).encode()
    for root in (source, skill.path, tmp_path / "staging", tmp_path / "published"):
        observable += b"".join(
            path.read_bytes()
            for path in root.rglob("*")
            if path.is_file() and not path.is_symlink()
        )
    assert not any(secret.encode() in observable for secret in secrets)
    assert exporter.get_finished_spans() == ()


def test_model_setting_secrets_are_withheld_from_application_errors(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    secret = "private-extra-header-value"

    def fail(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"provider rejected header {secret}")

    with pytest.raises(RuntimeError, match="diagnostics withheld") as caught:
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=FunctionModel(fail),
                        settings={"extra_headers": {"X-Tenant": secret}},
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                    auto_approve_publication=True,
                )
            )
        )

    assert secret not in str(caught.value)
