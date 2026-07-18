"""Bounded provider transport retries (separate from tool/output/child budgets)."""

from __future__ import annotations

import random
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

import httpx
from httpx import AsyncBaseTransport, HTTPStatusError, Response
from pydantic_ai.models import Model
from pydantic_ai.retries import AsyncTenacityTransport, RetryConfig, wait_retry_after
from tenacity import (
    RetryCallState,
    retry_if_exception,
    stop_after_attempt,
)

RETRYABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})
MAX_TRANSPORT_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 60.0
MAX_BACKOFF_SECONDS = 30.0
MIN_BACKOFF_SECONDS = 1.0


@dataclass(slots=True)
class ProviderRetryState:
    """Host-owned counters for one Wiki Run's transport retries."""

    attempts: int = 0
    retries: int = 0
    possible_duplicates: int = 0
    last_wait_seconds: float = 0.0
    events: list[dict[str, object]] = field(default_factory=list)

    def as_counters(self) -> dict[str, int]:
        return {
            "provider": self.retries,
            "provider_attempts": self.attempts,
            "provider_possible_duplicates": self.possible_duplicates,
        }


def is_retryable_status(status_code: int) -> bool:
    return status_code in RETRYABLE_STATUS_CODES


def is_retryable_exception(error: BaseException) -> bool:
    if isinstance(error, HTTPStatusError):
        return is_retryable_status(error.response.status_code)
    if isinstance(error, (httpx.ConnectError, httpx.ReadError, httpx.WriteError)):
        return True
    if isinstance(
        error, (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)
    ):
        return True
    if isinstance(error, httpx.TimeoutException):
        return True
    # Transport-layer network failures without an HTTP response.
    if isinstance(error, httpx.TransportError) and not isinstance(error, httpx.ProxyError):
        return True
    return False


def is_ambiguous_network_failure(error: BaseException) -> bool:
    """True when the request may have reached the provider before failing."""
    return isinstance(
        error,
        (
            httpx.ReadError,
            httpx.WriteError,
            httpx.ReadTimeout,
            httpx.WriteTimeout,
            httpx.RemoteProtocolError,
        ),
    )


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        seconds = float(text)
        if seconds < 0 or seconds != seconds:  # NaN
            return None
        return min(seconds, MAX_RETRY_AFTER_SECONDS)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(text)
        if when.tzinfo is None:
            from datetime import UTC

            when = when.replace(tzinfo=UTC)
        delay = when.timestamp() - (time.time() if now is None else now)
        if delay < 0:
            return 0.0
        return min(delay, MAX_RETRY_AFTER_SECONDS)
    except TypeError, ValueError, OverflowError, OSError:
        return None


class _UniformRng(Protocol):
    def uniform(self, a: float, b: float) -> float: ...


def exponential_backoff_seconds(attempt: int, *, rng: _UniformRng | None = None) -> float:
    """attempt is 1-based completed attempt count before the next retry."""
    base = min(MAX_BACKOFF_SECONDS, MIN_BACKOFF_SECONDS * (2 ** max(0, attempt - 1)))
    generator: _UniformRng = rng or random.Random()
    jitter = generator.uniform(0.0, max(0.05, base * 0.1))
    return min(MAX_BACKOFF_SECONDS, base + jitter)


def _validate_response(response: Response) -> None:
    if is_retryable_status(response.status_code):
        raise HTTPStatusError(
            f"Retryable provider status {response.status_code}",
            request=response.request,
            response=response,
        )


def build_provider_transport(
    *,
    state: ProviderRetryState,
    emit: Callable[..., None] | None = None,
    wall_clock_deadline: float | None = None,
    sleep: Callable[[int | float], None | Awaitable[None]] | None = None,
    rng: random.Random | None = None,
    wrapped: AsyncBaseTransport | None = None,
) -> AsyncTenacityTransport:
    """Build an AsyncTenacityTransport with product retry policy."""

    generator = rng or random.Random()

    def before_sleep(retry_state: RetryCallState) -> None:
        error = retry_state.outcome.exception() if retry_state.outcome else None
        attempt = retry_state.attempt_number
        wait = float(retry_state.next_action.sleep) if retry_state.next_action else 0.0
        if wall_clock_deadline is not None:
            remaining = wall_clock_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Wiki Run wall-clock deadline exhausted during provider retry")
            wait = min(wait, max(0.0, remaining))
            if retry_state.next_action is not None:
                retry_state.next_action.sleep = wait
        state.retries += 1
        state.last_wait_seconds = wait
        possible_duplicate = bool(error is not None and is_ambiguous_network_failure(error))
        if possible_duplicate:
            state.possible_duplicates += 1
        category = "network"
        if isinstance(error, HTTPStatusError):
            category = f"http_{error.response.status_code}"
        elif error is not None:
            category = type(error).__name__
        payload = {
            "attempt": attempt,
            "wait_seconds": wait,
            "kind": category,
            "status": "scheduled",
            "count": state.retries,
        }
        if possible_duplicate:
            payload["reason_code"] = "possible_duplicate"
        state.events.append(dict(payload))
        if emit is not None:
            emit("provider_retry_scheduled", payload)

    def after_attempt(retry_state: RetryCallState) -> None:
        state.attempts = max(state.attempts, retry_state.attempt_number)

    def retry_predicate(error: BaseException) -> bool:
        if wall_clock_deadline is not None and time.monotonic() >= wall_clock_deadline:
            return False
        return is_retryable_exception(error)

    def wait_strategy(retry_state: RetryCallState) -> float:
        error = retry_state.outcome.exception() if retry_state.outcome else None
        if isinstance(error, HTTPStatusError):
            header = error.response.headers.get("Retry-After")
            parsed = parse_retry_after(header)
            if parsed is not None:
                return min(parsed, MAX_RETRY_AFTER_SECONDS)
        return exponential_backoff_seconds(retry_state.attempt_number, rng=generator)

    config: RetryConfig = {
        "retry": retry_if_exception(retry_predicate),
        "wait": wait_retry_after(
            fallback_strategy=wait_strategy,
            max_wait=MAX_RETRY_AFTER_SECONDS,
        ),
        "stop": stop_after_attempt(MAX_TRANSPORT_ATTEMPTS),
        "reraise": True,
        "before_sleep": before_sleep,
        "after": after_attempt,
    }
    if sleep is not None:
        config["sleep"] = sleep
    return AsyncTenacityTransport(
        config,
        wrapped=wrapped,
        validate_response=_validate_response,
    )


def _openai_provider(http_client: httpx.AsyncClient):
    """Build an OpenAIProvider that honors OpenAI-compatible env credentials."""
    from pydantic_ai.providers.openai import OpenAIProvider

    from .env import openai_api_key, openai_base_url

    # Pass base_url/api_key explicitly so OpenAI-compatible gateways (vLLM, LiteLLM,
    # OpenRouter-compatible proxies, local servers) resolve the same way as stock OpenAI.
    # When base_url is set and api_key is missing, OpenAIProvider inserts a placeholder
    # key so local servers that ignore auth still work.
    return OpenAIProvider(
        base_url=openai_base_url(),
        api_key=openai_api_key(),
        http_client=http_client,
    )


def prepare_model_with_provider_retry(
    model: Model | str,
    *,
    state: ProviderRetryState,
    emit: Callable[..., None] | None = None,
    wall_clock_deadline: float | None = None,
) -> Model | str:
    """Attach transport retries for string model identities when a provider supports it.

    In-process custom Model objects (FunctionModel fixtures, caller-owned clients) are
    returned unchanged and remain non-replayable for Manual Retry Runs.

    ``openai:`` / ``openai-chat:`` / ``openai-responses:`` models use ``OPENAI_API_KEY``
    and optional ``OPENAI_BASE_URL`` (OpenAI-compatible Chat Completions base, ending in
    ``/v1`` when required by the gateway).
    """
    if not isinstance(model, str):
        return model
    identity = model.strip()
    if ":" not in identity:
        return model
    provider_name, model_name = identity.split(":", 1)
    if not provider_name or not model_name:
        return model
    transport = build_provider_transport(
        state=state, emit=emit, wall_clock_deadline=wall_clock_deadline
    )
    http_client = httpx.AsyncClient(transport=transport)
    try:
        if provider_name in {"openai", "openai-chat"}:
            from pydantic_ai.models.openai import OpenAIChatModel

            return OpenAIChatModel(model_name, provider=_openai_provider(http_client))
        if provider_name in {"openai-responses"}:
            from pydantic_ai.models.openai import OpenAIResponsesModel

            return OpenAIResponsesModel(model_name, provider=_openai_provider(http_client))
    except Exception:
        # Fall back to the original identity; credentials/env may still resolve later.
        return model
    return model


def merge_retry_counters(base: Mapping[str, int], state: ProviderRetryState) -> dict[str, int]:
    merged = dict(base)
    for key, value in state.as_counters().items():
        merged[key] = int(merged.get(key, 0)) + int(value)
    return merged
