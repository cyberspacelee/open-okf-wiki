import asyncio
import json
import os
from typing import cast

import pytest
from pydantic import BaseModel
from pydantic_ai import (
    Agent,
    ModelHTTPError,
    ModelResponse,
    ModelRetry,
    ModelSettings,
    Tool,
    UnexpectedModelBehavior,
    UsageLimitExceeded,
    UsageLimits,
)
from pydantic_ai.messages import RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.providers.openai import OpenAIProvider

from okf_wiki.worker import GatewaySettings, build_gateway_model


class GatewayProbeResult(BaseModel):
    value: str


def live_settings() -> GatewaySettings:
    base_url = os.getenv("OKF_GATEWAY_BASE_URL")
    api_key = os.getenv("OKF_GATEWAY_API_KEY")
    model = os.getenv("OKF_GATEWAY_MODEL")
    if not all((base_url, api_key, model)):
        pytest.skip(
            "enterprise gateway live test not run; set OKF_GATEWAY_BASE_URL, "
            "OKF_GATEWAY_API_KEY, and OKF_GATEWAY_MODEL"
        )
    assert base_url and api_key and model
    headers = json.loads(os.getenv("OKF_GATEWAY_HEADERS", "{}"))
    return GatewaySettings(
        base_url=base_url,
        api_key=api_key,
        model=model,
        default_headers=headers or None,
        max_retries=0,
    )


@pytest.mark.gateway_live
def test_live_gateway_tool_call_structured_output_retry_and_usage() -> None:
    attempts = 0

    async def probe(value: str) -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ModelRetry("retry the probe with the same value")
        return f"ok:{value}"

    model = build_gateway_model(live_settings())
    agent = Agent(
        model,
        output_type=GatewayProbeResult,
        instructions="You must call probe before returning a typed result containing its reply.",
        tools=[Tool(probe, max_retries=1, timeout=10)],
        retries={"tools": 1, "output": 2},
    )

    async def run_probe():
        try:
            return await agent.run("Call probe with value contract-test, then return its reply.")
        finally:
            await cast(OpenAIProvider, model.provider).client.close()

    result = asyncio.run(run_probe())
    parts = [part for message in result.new_messages() for part in message.parts]

    assert isinstance(result.output, GatewayProbeResult)
    assert result.output.value == "ok:contract-test"
    assert any(isinstance(part, ToolCallPart) for part in parts)
    assert any(isinstance(part, ToolReturnPart) for part in parts)
    assert any(isinstance(part, RetryPromptPart) for part in parts)
    assert result.usage.requests >= 2
    assert result.usage.input_tokens > 0
    assert result.usage.output_tokens > 0
    assert result.response.model_name
    assert result.response.provider_url
    assert result.response.finish_reason is not None
    assert result.response.provider_response_id


@pytest.mark.gateway_live
def test_live_gateway_parallel_tool_calls() -> None:
    active = 0
    maximum = 0

    async def slow_probe(value: str) -> str:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.1)
        active -= 1
        return value

    model = build_gateway_model(live_settings())
    agent = Agent(
        model,
        output_type=GatewayProbeResult,
        instructions=(
            "Call slow_probe exactly twice in one response, once with alpha and once with beta, "
            "then return a typed result."
        ),
        tools=[Tool(slow_probe, timeout=2)],
        model_settings=ModelSettings(parallel_tool_calls=True),
        retries={"tools": 1, "output": 2},
    )

    async def run_probe():
        try:
            return await agent.run("Perform the two parallel probe calls now.")
        finally:
            await cast(OpenAIProvider, model.provider).client.close()

    result = asyncio.run(run_probe())
    tool_calls_per_response = [
        sum(isinstance(part, ToolCallPart) for part in message.parts)
        for message in result.new_messages()
        if isinstance(message, ModelResponse)
    ]

    assert max(tool_calls_per_response) == 2
    assert maximum == 2


@pytest.mark.gateway_live
def test_live_gateway_configured_concurrent_runs() -> None:
    active = 0
    maximum = 0

    async def slow_probe(value: str) -> str:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.1)
        active -= 1
        return value

    model = build_gateway_model(live_settings())
    agent = Agent(
        model,
        output_type=GatewayProbeResult,
        instructions="Call slow_probe once before returning its value as a typed result.",
        tools=[Tool(slow_probe, timeout=2)],
        max_concurrency=2,
        retries={"tools": 1, "output": 2},
    )

    async def run_all():
        try:
            return await asyncio.gather(
                *(agent.run(f"Call slow_probe with run-{index}.") for index in range(3))
            )
        finally:
            await cast(OpenAIProvider, model.provider).client.close()

    results = asyncio.run(run_all())

    assert all(isinstance(result.output, GatewayProbeResult) for result in results)
    assert maximum == 2


@pytest.mark.gateway_live
def test_live_gateway_request_limit_and_tool_timeout() -> None:
    async def slow_probe(value: str) -> str:
        await asyncio.sleep(0.1)
        return value

    model = build_gateway_model(live_settings())
    limited = Agent(
        model,
        output_type=GatewayProbeResult,
        instructions="Call slow_probe once before returning a typed result.",
        tools=[Tool(slow_probe, timeout=2)],
        retries={"tools": 1, "output": 1},
    )
    timed = Agent(
        model,
        output_type=GatewayProbeResult,
        instructions="Call slow_probe once before returning a typed result.",
        tools=[Tool(slow_probe, max_retries=0, timeout=0.01)],
        retries={"tools": 0, "output": 1},
    )

    async def run_checks() -> None:
        try:
            with pytest.raises(UsageLimitExceeded):
                await limited.run(
                    "Call slow_probe with limited.", usage_limits=UsageLimits(request_limit=1)
                )
            with pytest.raises(UnexpectedModelBehavior):
                await timed.run("Call slow_probe with timeout.")
        finally:
            await cast(OpenAIProvider, model.provider).client.close()

    asyncio.run(run_checks())


@pytest.mark.gateway_live
def test_live_gateway_http_error_mapping_when_invalid_key_is_configured() -> None:
    settings = live_settings()
    invalid_key = os.getenv("OKF_GATEWAY_INVALID_API_KEY")
    if not invalid_key:
        pytest.skip("set OKF_GATEWAY_INVALID_API_KEY to run the live HTTP error contract")
    model = build_gateway_model(
        GatewaySettings(
            base_url=settings.base_url,
            api_key=invalid_key,
            model=settings.model,
            default_headers=settings.default_headers,
            max_retries=0,
        )
    )
    agent = Agent(model, output_type=GatewayProbeResult)

    async def run_probe() -> None:
        try:
            with pytest.raises(ModelHTTPError):
                await agent.run("Return a typed probe result.")
        finally:
            await cast(OpenAIProvider, model.provider).client.close()

    asyncio.run(run_probe())
