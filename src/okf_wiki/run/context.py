"""Shared harness context stack for agents that issue model requests.

Builds LimitWarner + TieredCompaction (clamp → clear tool results → summarize)
+ OverflowingToolOutput from pydantic-ai-harness only. A thin observable wrapper
emits compaction_warning / compaction_completed when deps support the run event
seam (``emit`` + ``compaction_warning_emitted``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from pydantic_ai import ModelRequestContext
from pydantic_ai.tools import RunContext
from pydantic_ai_harness.compaction import (
    ClampOversizedMessages,
    ClearToolResults,
    LimitWarner,
    SummarizingCompaction,
    TieredCompaction,
    estimate_token_count,
)
from pydantic_ai_harness.overflowing_tool_output import (
    Band,
    OverflowingToolOutput,
    Spill,
    Truncate,
)

from .analysis.workspace import AnalysisWorkspace


@runtime_checkable
class CompactionEventDeps(Protocol):
    """Minimal run deps surface for compaction observation events."""

    compaction_warning_emitted: bool
    depth: int
    role: str
    node_id: str | None

    def emit(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> None: ...


@dataclass
class ObservableTieredCompaction(TieredCompaction[Any]):
    """TieredCompaction with optional run compaction_warning / completed events.

    Triggers slightly below ``target_tokens`` so cleanup can run before the hard
    target; warning fires once per deps instance when tokens approach the budget.
    """

    trigger_tokens: int = 1
    warning_tokens: int = 1

    async def before_model_request(
        self,
        ctx: RunContext[Any],
        request_context: ModelRequestContext,
    ) -> ModelRequestContext:
        messages = list(request_context.messages)
        estimated = estimate_token_count(messages, self.tokenizer)
        deps = ctx.deps
        if (
            estimated >= self.warning_tokens
            and isinstance(deps, CompactionEventDeps)
            and not deps.compaction_warning_emitted
        ):
            deps.compaction_warning_emitted = True
            deps.emit(
                "compaction_warning",
                {
                    "depth": deps.depth,
                    "node_kind": deps.role,
                    "context_tokens": estimated,
                    "warning_tokens": self.warning_tokens,
                },
                node_id=deps.node_id,
            )
        if estimated <= self.trigger_tokens:
            request_context.messages = messages
            return request_context
        compacted = await self.compact(messages, ctx)
        request_context.messages = compacted
        if compacted != messages and isinstance(deps, CompactionEventDeps):
            deps.emit(
                "compaction_completed",
                {
                    "depth": deps.depth,
                    "node_kind": deps.role,
                    "before_tokens": estimated,
                    "target_tokens": self.target_tokens,
                },
                node_id=deps.node_id,
            )
        return request_context


@dataclass(frozen=True, slots=True)
class WorkspaceOverflowStore:
    """Spill store backed by the Analysis Workspace overflow partition."""

    workspace: AnalysisWorkspace

    async def write(self, key: str, data: bytes) -> str:
        return self.workspace.publish_overflow(key, data)

    async def read(self, handle: str) -> bytes:
        return self.workspace.read_overflow(handle)


def build_limit_warner(target_tokens: int) -> LimitWarner:
    """Harness LimitWarner at 70% of the configured context target."""
    return LimitWarner(
        max_context_tokens=target_tokens,
        warn_on=["context_window"],
        warning_threshold=0.7,
    )


def build_tiered_compaction(model: object, target_tokens: int) -> ObservableTieredCompaction:
    """Clamp → clear tool results → harness SummarizingCompaction, with observation."""
    from typing import Any, cast

    target = max(1, target_tokens // 2)
    trigger = max(1, math.floor(target_tokens * 0.6))
    warning = max(1, math.floor(target_tokens * 0.7))
    return ObservableTieredCompaction(
        tiers=[
            ClampOversizedMessages(max_part_chars=32_000),
            ClearToolResults(max_tokens=target, keep_pairs=3, clear_tool_inputs=True),
            SummarizingCompaction(
                model=cast(Any, model),
                max_tokens=target,
                keep_messages=20,
            ),
        ],
        target_tokens=target,
        trigger_tokens=trigger,
        warning_tokens=warning,
    )


def build_overflowing_tool_output(workspace: AnalysisWorkspace) -> OverflowingToolOutput[Any]:
    """Spill large tool returns into the Analysis Workspace, then truncate."""
    return OverflowingToolOutput(
        bands=[Band(over=8_000, action=Spill(then=Truncate(max_chars=4_000)))],
        store=WorkspaceOverflowStore(workspace),
    )


def build_context_capabilities(
    *,
    model: object,
    target_tokens: int,
    workspace: AnalysisWorkspace,
) -> list[Any]:
    """Attach the full harness context stack used by root/domain/leaf/reviewer agents.

    Order: LimitWarner (soft warn) → ObservableTieredCompaction → OverflowingToolOutput.
    """
    if target_tokens < 1:
        raise ValueError("context target_tokens must be positive")
    return [
        build_limit_warner(target_tokens),
        build_tiered_compaction(model, target_tokens),
        build_overflowing_tool_output(workspace),
    ]


__all__ = [
    "CompactionEventDeps",
    "ObservableTieredCompaction",
    "WorkspaceOverflowStore",
    "build_context_capabilities",
    "build_limit_warner",
    "build_overflowing_tool_output",
    "build_tiered_compaction",
]
