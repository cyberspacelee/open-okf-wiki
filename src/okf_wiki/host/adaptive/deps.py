"""Shared adaptive dependencies and host-side metrics."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from pydantic_ai import ModelRetry

from ..analysis.workspace import AnalysisWorkspace, HandoffRef
from .policy import HOST_PUBLISH_REVIEWER_NODE_ID, NodeState, Role


@dataclass(slots=True)
class _AdaptiveMetrics:
    active_children: int = 0
    max_active_children: int = 0
    child_runs: int = 0
    retries: int = 0
    direct_fallbacks: int = 0
    # Host-side queue time waiting on concurrency gates (not model latency).
    queue_seconds_total: float = 0.0
    max_queue_seconds: float = 0.0
    node_states: dict[str, NodeState] = field(default_factory=dict)
    node_parents: dict[str, str | None] = field(default_factory=dict)
    next_attempts: dict[str, int] = field(default_factory=dict)
    retry_requests_remaining: int = 0
    retry_tokens_remaining: int = 0
    usage: dict[str, int] = field(
        default_factory=lambda: {
            "requests": 0,
            "tool_calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        }
    )

    def record_queue_wait(self, seconds: float) -> None:
        wait = max(0.0, seconds)
        self.queue_seconds_total += wait
        if wait > self.max_queue_seconds:
            self.max_queue_seconds = wait

    def register_node(self, node_id: str, parent_id: str | None = None) -> None:
        self.node_states.setdefault(node_id, "pending")
        existing_parent = self.node_parents.setdefault(node_id, parent_id)
        if existing_parent != parent_id:
            raise ValueError("adaptive node parent cannot change")
        self.next_attempts.setdefault(node_id, 1)

    def begin_attempt(self, node_id: str, *, retry_request_cost: int, retry_token_cost: int) -> int:
        if node_id not in self.node_states:
            self.register_node(node_id)
        attempt = self.next_attempts[node_id]
        if attempt > 1:
            if (
                self.retry_requests_remaining < retry_request_cost
                or self.retry_tokens_remaining < retry_token_cost
            ):
                raise ModelRetry("The whole-tree retry reserve is exhausted for this branch")
            self.retry_requests_remaining -= retry_request_cost
            self.retry_tokens_remaining -= retry_token_cost
            self.retries += 1
        self.node_states[node_id] = "running"
        return attempt

    def finish_attempt(self, node_id: str, state: NodeState, *, receipt_published: bool) -> None:
        self.node_states[node_id] = state
        if receipt_published:
            self.next_attempts[node_id] = self.next_attempts.get(node_id, 1) + 1

    def unresolved_failures(self) -> int:
        # Host pre-publish Reviewer soft-fails independently of research-tree health.
        return sum(
            state in {"partial", "failed", "cancelled"}
            for node_id, state in self.node_states.items()
            if node_id != HOST_PUBLISH_REVIEWER_NODE_ID
        )

    def mark_direct_fallback(self, node_id: str) -> None:
        if self.node_states.get(node_id) not in {"partial", "failed", "cancelled"}:
            raise ModelRetry("Direct fallback is only available for an incomplete child branch")
        if self.next_attempts.get(node_id, 1) <= 2:
            raise ModelRetry("Retry the child once before using direct fallback")
        self.node_states[node_id] = "complete"
        self.next_attempts[node_id] = self.next_attempts.get(node_id, 1) + 1
        self.direct_fallbacks += 1


@dataclass(slots=True)
class AdaptiveDeps:
    """Dependencies shared by Host receipt tools and bounded child wrappers."""

    run_id: str
    workspace: AnalysisWorkspace
    task_id: str
    node_id: str
    parent_id: str | None
    depth: int
    role: Role
    attempt: int
    semaphore: asyncio.Semaphore
    emit: Callable[..., None]
    metrics: _AdaptiveMetrics
    published: HandoffRef | None = None
    compaction_warning_emitted: bool = False

    def for_node(
        self,
        *,
        task_id: str,
        node_id: str,
        parent_id: str,
        depth: int,
        role: Role,
        attempt: int,
    ) -> "AdaptiveDeps":
        return replace(
            self,
            task_id=task_id,
            node_id=node_id,
            parent_id=parent_id,
            depth=depth,
            role=role,
            attempt=attempt,
            published=None,
            compaction_warning_emitted=False,
        )


__all__ = [
    "AdaptiveDeps",
    "_AdaptiveMetrics",
]
