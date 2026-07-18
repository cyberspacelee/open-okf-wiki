"""Project pydantic-ai stream events into operator-safe UI fragments.

Uses framework ``AgentStreamEvent`` types (ADR 0018) rather than a bespoke
protocol. Never surfaces chain-of-thought / thinking deltas or raw provider
bodies; tool labels are names only (no argument dumps).
"""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterable, Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from pydantic_ai.messages import (
    AgentStreamEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPartDelta,
)

from ..host.security import environment_secrets, redact_secrets

StreamKind = Literal["text", "tool", "tool_result", "part", "other"]


@dataclass(slots=True, frozen=True)
class StreamFragment:
    """One operator-facing stream update for the Session TUI."""

    kind: StreamKind
    text: str
    """For kind=text: content delta (or cumulative chunk). Otherwise a label."""


StreamSink = Callable[[StreamFragment], object]


def project_stream_event(event: AgentStreamEvent) -> StreamFragment | None:
    """Map one framework stream event to a redacted UI fragment, or skip it."""
    secrets = environment_secrets()

    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, ThinkingPartDelta):
            # No CoT / thinking dump in the Operator Session UI.
            return None
        if isinstance(delta, TextPartDelta):
            content = delta.content_delta or ""
            if not content:
                return None
            return StreamFragment(kind="text", text=redact_secrets(content, secrets))
        if isinstance(delta, ToolCallPartDelta):
            # Partial tool JSON args are not operator-safe labels; wait for call event.
            return None
        return None

    if isinstance(event, PartStartEvent):
        part = event.part
        part_kind = getattr(part, "part_kind", None) or type(part).__name__
        if part_kind in {"thinking", "ThinkingPart"}:
            return None
        if part_kind in {"text", "TextPart"}:
            return None  # text arrives via deltas
        return StreamFragment(kind="part", text=f"model part: {part_kind}")

    if isinstance(event, FunctionToolCallEvent):
        name = getattr(event.part, "tool_name", None) or "tool"
        return StreamFragment(kind="tool", text=f"tool call: {name}")

    if isinstance(event, FunctionToolResultEvent):
        name = getattr(event.part, "tool_name", None) or "tool"
        return StreamFragment(kind="tool_result", text=f"tool result: {name}")

    return None


async def consume_agent_stream(
    event_stream: AsyncIterable[AgentStreamEvent],
    *,
    on_fragment: StreamSink | None,
) -> None:
    """Drain a pydantic-ai event stream, forwarding projected fragments."""
    if on_fragment is None:
        async for _ in event_stream:
            pass
        return

    async for event in event_stream:
        fragment = project_stream_event(event)
        if fragment is None:
            continue
        result = on_fragment(fragment)
        if inspect.isawaitable(result):
            await result


def make_event_stream_handler(
    on_fragment: StreamSink | None,
) -> Callable[..., Awaitable[None]] | None:
    """Build a pydantic-ai ``event_stream_handler`` bound to ``on_fragment``.

    Returns ``None`` when there is no sink so callers can omit the kwarg.
    """
    if on_fragment is None:
        return None

    async def handler(_ctx: object, event_stream: AsyncIterable[AgentStreamEvent]) -> None:
        await consume_agent_stream(event_stream, on_fragment=on_fragment)

    return handler


__all__ = [
    "StreamFragment",
    "StreamKind",
    "StreamSink",
    "consume_agent_stream",
    "make_event_stream_handler",
    "project_stream_event",
]
