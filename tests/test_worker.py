import asyncio
import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path
from typing import cast

import httpx
import pytest
from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import RetryPromptPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.providers.openai import OpenAIProvider

from okf_wiki.worker import (
    GatewaySettings,
    GitObjectSnapshotReader,
    WorkerAgent,
    WorkerBudgets,
    AnalysisTask,
    build_gateway_model,
)


def make_repository(path: Path) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    (path / "guide.md").write_text(
        "# Guide\n\nWorkers only read fixed snapshots.\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "guide.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, check=True, text=True, capture_output=True
    ).stdout.strip()


def proposal(revision: str, *, digest: str | None = None) -> dict:
    text = "Workers only read fixed snapshots."
    return {
        "task_id": "task-1",
        "obligation_ids": ["obligation-1"],
        "evidence": [
            {
                "id": "evidence-1",
                "source_id": "source-1",
                "path": "guide.md",
                "revision": revision,
                "start_line": 3,
                "end_line": 3,
                "digest": digest or f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
            }
        ],
        "claims": [
            {
                "id": "claim-1",
                "text": text,
                "evidence_ids": ["evidence-1"],
            }
        ],
        "concepts": [
            {
                "id": "concept-1",
                "name": "Worker Agent",
                "description": "A bounded reader.",
                "claim_ids": ["claim-1"],
            }
        ],
        "relations": [],
        "dispositions": [
            {
                "obligation_id": "obligation-1",
                "disposition": "covered",
                "reason": "The claim is grounded.",
                "evidence_ids": ["evidence-1"],
            }
        ],
    }


def task(repository: Path, revision: str) -> AnalysisTask:
    return AnalysisTask(
        task_id="task-1",
        obligation_ids=("obligation-1",),
        source_id="source-1",
        repository=repository,
        revision=revision,
        allowed_paths=("guide.md",),
        prompt="Investigate the obligation.",
        budgets=WorkerBudgets(),
    )


def chat_response(index: int, tool_calls: list[dict]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": f"chatcmpl-{index}",
            "object": "chat.completion",
            "created": 1_700_000_000 + index,
            "model": "stub-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": None, "tool_calls": tool_calls},
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
        },
    )


def tool_call(name: str, arguments: dict, call_id: str) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def test_worker_exposes_only_three_read_tools_and_returns_typed_candidate(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    model = TestModel(call_tools=[], custom_output_args=proposal(revision))
    worker = WorkerAgent(
        model,
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "accepted"
    assert result.proposal is not None
    assert result.proposal.claims[0].text == "Workers only read fixed snapshots."
    assert model.last_model_request_parameters is not None
    assert {tool.name for tool in model.last_model_request_parameters.function_tools} == {
        "list_paths",
        "search_text",
        "read_text",
    }
    assert GitObjectSnapshotReader(repository, "source-1", revision).list_paths_sync() == [
        "guide.md"
    ]
    with sqlite3.connect(tmp_path / "audit.db") as connection:
        assert connection.execute("SELECT status FROM worker_candidates").fetchone() == (
            "accepted",
        )


def test_invalid_evidence_is_rejected_without_authoritative_mutation(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    audit = tmp_path / "audit.db"
    with sqlite3.connect(audit) as connection:
        connection.execute(
            "CREATE TABLE coverage_obligations (id TEXT PRIMARY KEY, disposition TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO coverage_obligations VALUES ('obligation-1', 'open')")
    model = TestModel(
        call_tools=[],
        custom_output_args=proposal(revision, digest=f"sha256:{'0' * 64}"),
    )
    worker = WorkerAgent(
        model,
        audit_path=audit,
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "rejected"
    assert result.proposal is not None
    assert result.errors == ["Evidence evidence-1 digest does not match the resolved span"]
    with sqlite3.connect(audit) as connection:
        assert connection.execute("SELECT disposition FROM coverage_obligations").fetchone() == (
            "open",
        )
        assert (
            connection.execute("SELECT status, proposal_json FROM worker_candidates").fetchone()[0]
            == "rejected"
        )
        assert (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accepted_knowledge'"
            ).fetchone()
            is None
        )


@pytest.mark.parametrize(
    ("case", "error"),
    [
        ("missing", "Claim claim-1 references missing ID missing-evidence"),
        ("out-of-scope", "Evidence evidence-1 path is outside the assigned scope"),
    ],
)
def test_missing_or_out_of_scope_evidence_is_rejected(
    tmp_path: Path, case: str, error: str
) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    output = proposal(revision)
    if case == "missing":
        output["claims"][0]["evidence_ids"] = ["missing-evidence"]
    else:
        output["evidence"][0]["path"] = "other.md"
    worker = WorkerAgent(
        TestModel(call_tools=[], custom_output_args=output),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "rejected"
    assert error in result.errors


def test_duplicate_disposition_for_one_obligation_is_rejected(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    output = proposal(revision)
    output["dispositions"].append(dict(output["dispositions"][0]))
    worker = WorkerAgent(
        TestModel(call_tools=[], custom_output_args=output),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="test",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "rejected"
    assert result.errors == ["Each assigned obligation must have only one Disposition proposal"]


def test_snapshot_reader_uses_git_objects_and_enforces_scope(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    make_repository(repository)
    (repository / "文档.md").write_text("固定快照\n", encoding="utf-8")
    subprocess.run(["git", "add", "文档.md"], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "encoded path"], cwd=repository, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    (repository / "guide.md").write_text("uncommitted secret\n", encoding="utf-8")
    reader = GitObjectSnapshotReader(repository, "source-1", revision)

    assert reader.read_text_sync("guide.md", 3, 3, allowed=("guide.md",)) == (
        "Workers only read fixed snapshots."
    )
    assert (
        reader.read_text_sync("%E6%96%87%E6%A1%A3.md", 1, 1, allowed=("%E6%96%87%E6%A1%A3.md",))
        == "固定快照"
    )
    with pytest.raises(ValueError, match="outside the assigned"):
        reader.read_text_sync("guide.md", 1, 1, allowed=("other.md",))
    with pytest.raises(ValueError, match="repository-relative"):
        reader.read_text_sync("../guide.md", 1, 1, allowed=("../guide.md",))


def test_function_model_records_tool_retry_usage_and_trajectory(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)

    def function(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        retries = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, RetryPromptPart)
        ]
        returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if not retries and not returns:
            part = ToolCallPart("search_text", {"query": ""}, "search-1")
        elif retries and not returns:
            part = ToolCallPart(
                "search_text", {"query": "Workers", "paths": ["guide.md"]}, "search-2"
            )
        else:
            part = ToolCallPart(info.output_tools[0].name, proposal(revision), "output-1")
        return ModelResponse(
            [part],
            usage=RequestUsage(input_tokens=10, output_tokens=5),
            model_name="function",
        )

    audit = tmp_path / "audit.db"
    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=audit,
        gateway_id="test",
        model_name="function",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "accepted"
    with sqlite3.connect(audit) as connection:
        row = connection.execute(
            """SELECT retry_count, usage_json, trajectory_json, latency_ms, gateway_id,
                      model, prompt_version, tool_version, schema_version,
                      response_model, provider_url
               FROM worker_candidates"""
        ).fetchone()
    assert row[0] == 1
    assert json.loads(row[1]) == {
        "requests": 3,
        "tool_calls": 1,
        "input_tokens": 30,
        "output_tokens": 15,
        "total_tokens": 45,
    }
    trajectory = json.loads(row[2])
    assert [event["event"] for event in trajectory].count("retry") == 1
    assert {event.get("tool") for event in trajectory} >= {"search_text"}
    assert row[3] >= 0
    assert row[4:] == (
        "test",
        "function",
        "worker-v1",
        "git-snapshot-v1",
        "worker-proposal-v1",
        "function:function:",
        None,
    )


@pytest.mark.parametrize(
    ("budgets", "expected_type"),
    [
        (WorkerBudgets(request_limit=1), "UsageLimitExceeded"),
        (WorkerBudgets(tool_calls_limit=1), "UsageLimitExceeded"),
    ],
)
def test_worker_enforces_request_and_tool_call_limits(
    tmp_path: Path, budgets: WorkerBudgets, expected_type: str
) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)

    def function(messages: list[ModelRequest | ModelResponse], _info: AgentInfo) -> ModelResponse:
        call_number = sum(isinstance(message, ModelResponse) for message in messages)
        if budgets.request_limit == 1:
            parts = [ToolCallPart("list_paths", {}, f"list-{call_number}")]
        else:
            parts = [
                ToolCallPart(
                    "read_text", {"path": "guide.md", "start_line": 1, "end_line": 1}, "a"
                ),
                ToolCallPart(
                    "read_text", {"path": "guide.md", "start_line": 3, "end_line": 3}, "b"
                ),
            ]
        return ModelResponse(parts)

    assigned = task(repository, revision).model_copy(update={"budgets": budgets})
    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(assigned))

    assert result.status == "rejected"
    assert result.error_type == expected_type


def test_worker_enforces_tool_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    original = GitObjectSnapshotReader.read_text

    async def slow_read(
        self: GitObjectSnapshotReader,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        await asyncio.sleep(0.05)
        return await original(self, path, start_line, end_line, allowed=allowed)

    monkeypatch.setattr(GitObjectSnapshotReader, "read_text", slow_read)

    def function(_messages: list[ModelRequest | ModelResponse], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(
            [
                ToolCallPart(
                    "read_text",
                    {"path": "guide.md", "start_line": 3, "end_line": 3},
                    "slow-read",
                )
            ]
        )

    assigned = task(repository, revision).model_copy(
        update={"budgets": WorkerBudgets(tool_timeout_seconds=0.01, wall_time_seconds=1)}
    )
    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(assigned))

    assert result.status == "rejected"
    assert result.error_type == "UnexpectedModelBehavior"


def test_worker_enforces_wall_time(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)

    async def function(
        _messages: list[ModelRequest | ModelResponse], info: AgentInfo
    ) -> ModelResponse:
        await asyncio.sleep(0.05)
        return ModelResponse(
            [ToolCallPart(info.output_tools[0].name, proposal(revision), "output")]
        )

    assigned = task(repository, revision).model_copy(
        update={"budgets": WorkerBudgets(wall_time_seconds=0.01)}
    )
    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(assigned))

    assert result.status == "rejected"
    assert result.error_type == "TimeoutError"


def test_parallel_read_tools_overlap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    active = 0
    maximum = 0
    original = GitObjectSnapshotReader.read_text

    async def observed_read(
        self: GitObjectSnapshotReader,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        try:
            return await original(self, path, start_line, end_line, allowed=allowed)
        finally:
            active -= 1

    monkeypatch.setattr(GitObjectSnapshotReader, "read_text", observed_read)

    def function(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart)
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            return ModelResponse(
                [ToolCallPart(info.output_tools[0].name, proposal(revision), "output")]
            )
        return ModelResponse(
            [
                ToolCallPart(
                    "read_text",
                    {"path": "guide.md", "start_line": 1, "end_line": 1},
                    "read-1",
                ),
                ToolCallPart(
                    "read_text",
                    {"path": "guide.md", "start_line": 3, "end_line": 3},
                    "read-2",
                ),
            ]
        )

    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))

    assert result.status == "accepted"
    assert maximum == 2


def test_configured_concurrent_runs_are_bounded(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    active = 0
    maximum = 0

    async def function(
        _messages: list[ModelRequest | ModelResponse], info: AgentInfo
    ) -> ModelResponse:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return ModelResponse(
            [ToolCallPart(info.output_tools[0].name, proposal(revision), "output")]
        )

    worker = WorkerAgent(
        FunctionModel(function),
        audit_path=tmp_path / "audit.db",
        gateway_id="test",
        model_name="function",
        max_concurrency=2,
    )
    assigned = task(repository, revision)

    async def run_all() -> list:
        return await asyncio.gather(*(worker.run(assigned) for _ in range(3)))

    results = asyncio.run(run_all())

    assert all(result.status == "accepted" for result in results)
    assert maximum == 2


def test_openai_compatible_path_proves_tools_structure_retry_usage_and_parallel_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    requests = []
    active_tools = 0
    maximum_tools = 0
    original = GitObjectSnapshotReader.read_text

    async def observed_read(
        self: GitObjectSnapshotReader,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        nonlocal active_tools, maximum_tools
        active_tools += 1
        maximum_tools = max(maximum_tools, active_tools)
        await asyncio.sleep(0.02)
        try:
            return await original(self, path, start_line, end_line, allowed=allowed)
        finally:
            active_tools -= 1

    monkeypatch.setattr(GitObjectSnapshotReader, "read_text", observed_read)

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads((await request.aread()).decode())
        requests.append(body)
        output_name = next(
            item["function"]["name"]
            for item in body["tools"]
            if item["function"]["name"] not in {"list_paths", "search_text", "read_text"}
        )
        index = len(requests)
        if index == 1:
            calls = [
                tool_call(
                    "read_text",
                    {"path": "guide.md", "start_line": 1, "end_line": 1},
                    "read-1",
                ),
                tool_call(
                    "read_text",
                    {"path": "guide.md", "start_line": 3, "end_line": 3},
                    "read-2",
                ),
            ]
        elif index == 2:
            calls = [tool_call("search_text", {"query": ""}, "search-1")]
        elif index == 3:
            calls = [
                tool_call("search_text", {"query": "Workers", "paths": ["guide.md"]}, "search-2")
            ]
        else:
            calls = [tool_call(output_name, proposal(revision), "output-1")]
        return chat_response(index, calls)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = build_gateway_model(
        GatewaySettings(
            base_url="https://gateway.example/v1",
            api_key="top-secret-key",
            model="enterprise-model",
            default_headers={"X-Tenant": "secret-tenant"},
            http_client=http_client,
            max_retries=0,
        )
    )
    audit = tmp_path / "audit.db"
    worker = WorkerAgent(
        model,
        audit_path=audit,
        gateway_id="enterprise-test",
        model_name="enterprise-model",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))
    asyncio.run(cast(OpenAIProvider, model.provider).client.close())

    assert result.status == "accepted"
    assert result.proposal is not None
    assert len(requests) == 4
    assert requests[0]["parallel_tool_calls"] is True
    assert {item["function"]["name"] for item in requests[0]["tools"]} >= {
        "list_paths",
        "search_text",
        "read_text",
    }
    assert maximum_tools == 2
    with sqlite3.connect(audit) as connection:
        retry_count, usage_json, response_model, provider_url = connection.execute(
            """SELECT retry_count, usage_json, response_model, provider_url
               FROM worker_candidates"""
        ).fetchone()
    assert retry_count == 1
    assert json.loads(usage_json) == {
        "requests": 4,
        "tool_calls": 3,
        "input_tokens": 44,
        "output_tokens": 28,
        "total_tokens": 72,
    }
    assert response_model == "stub-model"
    assert provider_url.startswith("https://gateway.example/v1")
    audit_bytes = audit.read_bytes()
    assert b"top-secret-key" not in audit_bytes
    assert b"secret-tenant" not in audit_bytes


def test_openai_compatible_http_error_is_mapped_and_audited(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid credential"}})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = build_gateway_model(
        GatewaySettings(
            base_url="https://gateway.example/v1",
            api_key="bad-key",
            model="enterprise-model",
            http_client=http_client,
            max_retries=0,
        )
    )
    worker = WorkerAgent(
        model,
        audit_path=tmp_path / "audit.db",
        gateway_id="enterprise-test",
        model_name="enterprise-model",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))
    asyncio.run(cast(OpenAIProvider, model.provider).client.close())

    assert result.status == "rejected"
    assert result.error_type == "ModelHTTPError"
    assert "status_code: 401" in result.errors[0]


def test_openai_compatible_connection_error_is_mapped_and_audited(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway unavailable", request=request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = build_gateway_model(
        GatewaySettings(
            base_url="https://gateway.example/v1",
            api_key="test-key",
            model="enterprise-model",
            http_client=http_client,
            max_retries=0,
        )
    )
    worker = WorkerAgent(
        model,
        audit_path=tmp_path / "audit.db",
        gateway_id="enterprise-test",
        model_name="enterprise-model",
        max_concurrency=1,
    )

    result = asyncio.run(worker.run(task(repository, revision)))
    asyncio.run(cast(OpenAIProvider, model.provider).client.close())

    assert result.status == "rejected"
    assert result.error_type == "ModelAPIError"
    assert result.errors == ["Connection error."]


def test_openai_compatible_configured_run_concurrency(tmp_path: Path) -> None:
    repository = tmp_path / "source"
    revision = make_repository(repository)
    active = 0
    maximum = 0
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum, request_count
        active += 1
        maximum = max(maximum, active)
        request_count += 1
        body = json.loads((await request.aread()).decode())
        output_name = next(
            item["function"]["name"]
            for item in body["tools"]
            if item["function"]["name"] not in {"list_paths", "search_text", "read_text"}
        )
        await asyncio.sleep(0.02)
        active -= 1
        return chat_response(
            request_count,
            [tool_call(output_name, proposal(revision), f"output-{request_count}")],
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = build_gateway_model(
        GatewaySettings(
            base_url="https://gateway.example/v1",
            api_key="test-key",
            model="enterprise-model",
            http_client=http_client,
            max_retries=0,
        )
    )
    worker = WorkerAgent(
        model,
        audit_path=tmp_path / "audit.db",
        gateway_id="enterprise-test",
        model_name="enterprise-model",
        max_concurrency=2,
    )
    assigned = task(repository, revision)

    async def run_all() -> list:
        results = await asyncio.gather(*(worker.run(assigned) for _ in range(3)))
        await cast(OpenAIProvider, model.provider).client.close()
        return results

    results = asyncio.run(run_all())

    assert all(result.status == "accepted" for result in results)
    assert maximum == 2
