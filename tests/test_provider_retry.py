import asyncio
import json
from pathlib import Path

import httpx
import pytest
from httpx import HTTPStatusError, Request, Response
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart

from okf_wiki.host.provider.retry import (
    MAX_TRANSPORT_ATTEMPTS,
    ProviderRetryState,
    build_provider_transport,
    exponential_backoff_seconds,
    is_retryable_exception,
    is_retryable_status,
    parse_retry_after,
)
from okf_wiki.host import (
    Complete,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
    WikiRunRecord,
    load_run_record,
)


def test_retryable_status_codes_match_the_product_policy() -> None:
    assert is_retryable_status(429)
    assert is_retryable_status(503)
    assert not is_retryable_status(400)
    assert not is_retryable_status(401)
    assert not is_retryable_status(404)


def test_retryable_exceptions_cover_transient_network_failures() -> None:
    request = Request("GET", "https://example.test")
    assert is_retryable_exception(httpx.ConnectError("down", request=request))
    assert is_retryable_exception(httpx.ReadTimeout("slow", request=request))
    response = Response(429, request=request)
    assert is_retryable_exception(HTTPStatusError("rate", request=request, response=response))
    bad = Response(400, request=request)
    assert not is_retryable_exception(HTTPStatusError("bad", request=request, response=bad))


def test_retry_after_seconds_and_http_date_are_capped() -> None:
    assert parse_retry_after("12") == 12.0
    assert parse_retry_after("120") == 60.0
    assert parse_retry_after("not-a-header") is None
    # HTTP-date far in the future still caps at 60s.
    assert parse_retry_after("Wed, 21 Oct 2099 07:28:00 GMT") == 60.0


def test_exponential_backoff_is_bounded_and_jittered() -> None:
    class Fixed:
        def uniform(self, a: float, b: float) -> float:
            return b

        def random(self) -> float:
            return 1.0

    delays = [exponential_backoff_seconds(n, rng=Fixed()) for n in range(1, 8)]
    assert delays[0] >= 1.0
    assert all(delay <= 30.0 for delay in delays)
    assert delays[-1] == 30.0


async def _noop_sleep(_: float) -> None:
    return None


def test_transport_retries_retryable_status_then_succeeds() -> None:
    attempts = {"n": 0}
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(503, request=request, headers={"Retry-After": "0"})
        return httpx.Response(200, request=request, text="ok")

    state = ProviderRetryState()
    events: list[dict[str, object]] = []

    def emit(event_type: str, payload: dict[str, object] | None = None, **_: object) -> None:
        events.append({"type": event_type, **(payload or {})})

    async def record_sleep(seconds: float) -> None:
        sleeps.append(float(seconds))

    transport = build_provider_transport(
        state=state,
        emit=emit,
        sleep=record_sleep,
        wrapped=httpx.MockTransport(handler),
    )

    async def run() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.get("https://example.test/v1")

    response = asyncio.run(run())
    assert response.status_code == 200
    assert attempts["n"] == 3
    assert state.retries == 2
    assert state.attempts >= 2
    assert any(event["type"] == "provider_retry_scheduled" for event in events)


def test_transport_fails_closed_on_stable_4xx_without_retry() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(401, request=request, text="no")

    state = ProviderRetryState()
    transport = build_provider_transport(
        state=state,
        sleep=_noop_sleep,
        wrapped=httpx.MockTransport(handler),
    )

    async def call() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.get("https://example.test/v1")

    result = asyncio.run(call())
    assert result.status_code == 401
    assert attempts["n"] == 1
    assert state.retries == 0


def test_transport_exhausts_after_three_attempts() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(500, request=request)

    state = ProviderRetryState()
    transport = build_provider_transport(
        state=state,
        sleep=_noop_sleep,
        wrapped=httpx.MockTransport(handler),
    )

    async def call() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            await client.get("https://example.test/v1")

    with pytest.raises(HTTPStatusError):
        asyncio.run(call())
    assert attempts["n"] == MAX_TRANSPORT_ATTEMPTS
    assert state.retries == MAX_TRANSPORT_ATTEMPTS - 1


def _repository(tmp_path: Path) -> tuple[Path, str]:
    import subprocess

    source = tmp_path / "repo"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("source\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()
    return source, revision


def test_manual_retry_reuses_frozen_inputs_with_a_new_identity(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)
    publication = tmp_path / "published"
    events: list[object] = []

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        del messages, info
        raise RuntimeError("provider boom")

    with pytest.raises(Exception):
        asyncio.run(
            WikiRunApplication(observer=events.append).run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=ProducerSkillVersion.default(),
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=2,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / "staging-1",
                    publication=publication,
                    explicit_answers={"q1": "keep frozen"},
                    auto_approve_publication=True,
                )
            )
        )
    records = list((tmp_path / ".published.runs").glob("*.json"))
    assert len(records) == 1
    first = load_run_record(records[0])
    assert first.status == "failed"
    assert first.explicit_answers["q1"] == "keep frozen"
    assert first.model["replayable"] is False

    pages_written = {"n": 0}

    def success_model(
        messages: list[ModelRequest | ModelResponse], info: AgentInfo
    ) -> ModelResponse:
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if not run_code_returns:
            pages_written["n"] += 1
            code = (
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    retry_request = WikiRunRequest.from_run_record(
        first,
        staging=tmp_path / "staging-2",
        publication=publication,
        model=FunctionModel(success_model),
    ).model_copy(update={"auto_approve_publication": True})
    assert retry_request.prior_run_id == first.run_id
    assert retry_request.explicit_answers["q1"] == "keep frozen"
    assert retry_request.repositories[0].revision == revision
    assert retry_request.skill.digest == first.skill["digest"]
    result = asyncio.run(WikiRunApplication().run(retry_request))
    assert isinstance(result, Complete)
    assert (publication / "index.md").is_file()
    records = list((tmp_path / ".published.runs").glob("*.json"))
    run_ids = {json.loads(path.read_text(encoding="utf-8"))["run_id"] for path in records}
    assert first.run_id in run_ids
    assert len(run_ids) == 2


def test_manual_retry_fails_closed_when_skill_digest_changes(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)
    record = WikiRunRecord(
        run_id="a" * 32,
        status="failed",
        operation="generate",
        repositories=[
            {
                "id": "repo",
                "path": str(source),
                "revision": revision,
                "ignore": [],
                "apply_default_source_ignores": True,
                "effective_ignore": [],
            }
        ],
        skill={"path": str(ProducerSkillVersion.default().path), "digest": "0" * 64},
        model={"identity": "test", "replayable": True, "settings": {}},
        limits=WikiRunLimits(request_limit=2, tool_calls_limit=2).model_dump(mode="json"),
        started_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        completed_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        duration_seconds=1.0,
        failure_category="RuntimeError",
    )
    with pytest.raises(ValueError, match="Skill digest"):
        WikiRunRequest.from_run_record(
            record,
            staging=tmp_path / "staging",
            publication=tmp_path / "published",
            model="test",
        )
