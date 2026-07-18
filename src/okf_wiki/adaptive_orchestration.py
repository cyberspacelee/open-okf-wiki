"""Small host seam for bounded Harness research orchestration.

This module deliberately owns policy and capability assembly only.  Semantic
splitting remains model-owned (``delegate_task``/``run_workflow``); the Host
only supplies a fixed roster, receipts, mounts, budgets, and a semaphore.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, cast

from pydantic_ai import (
    Agent,
    FunctionToolset,
    ModelRetry,
    ModelSettings,
    RunUsage,
    ToolDefinition,
    UsageLimits,
)
from pydantic_ai.agent import AbstractAgent, AgentRunResult, WrapperAgent
from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import RunContext
from pydantic_ai_harness import CodeMode
from pydantic_ai_harness.dynamic_workflow import DynamicWorkflow, WorkflowAgent
from pydantic_ai_harness.planning import Planning
from pydantic_ai_harness.subagents import SubAgent, SubAgents
from pydantic_monty import MountDir

from .analysis_workspace import (
    AnalysisReceipt,
    AnalysisWorkspace,
    HandoffRef,
    ReceiptArtifact,
    ReceiptEvidence,
)
from .context_capabilities import build_context_capabilities
from .security import environment_secrets, redact_secrets


Role = Literal["root", "domain", "leaf", "reviewer"]
NodeState = Literal["pending", "running", "complete", "partial", "failed", "cancelled"]

# Host pre-publish Reviewer node (distinct from adaptive mid-run roster ``reviewer``).
HOST_PUBLISH_REVIEWER_NODE_ID = "publish-reviewer"

# Bounded defects fields exposed on the publication gate / lifecycle.
_MAX_DEFECT_FINDINGS = 16
_MAX_DEFECT_TEXT_CHARS = 500


@dataclass(frozen=True, slots=True)
class AdaptivePolicy:
    """Host-enforced limits for one bounded Root → Domain → Leaf tree."""

    enabled: bool
    max_depth: int = 2
    # Normal runs expose two domains; callers may raise this to four explicitly.
    root_fanout: int = 2
    domain_fanout: int = 2
    child_concurrency: int = 4
    context_target_tokens: int = 100_000
    child_timeout_seconds: float = 120.0
    leaf_timeout_seconds: float = 90.0
    domain_request_limit: int = 6
    leaf_request_limit: int = 3
    domain_total_tokens_limit: int = 25_000
    leaf_total_tokens_limit: int = 18_000
    # Optional independent Wiki Reviewer; at most one child run, no delegation.
    enable_reviewer: bool = True
    reviewer_request_limit: int = 5
    reviewer_total_tokens_limit: int = 30_000
    dynamic_workflow: bool = False

    def __post_init__(self) -> None:
        if not 0 <= self.max_depth <= 2:
            raise ValueError("adaptive max_depth must be between 0 and 2")
        if not 0 <= self.root_fanout <= 4:
            raise ValueError("adaptive root fan-out must be between 0 and 4")
        if not 0 <= self.domain_fanout <= 2:
            raise ValueError("adaptive domain fan-out must be between 0 and 2")
        if not 1 <= self.child_concurrency <= 4:
            raise ValueError("adaptive child concurrency must be between 1 and 4")
        if self.context_target_tokens < 1:
            raise ValueError("adaptive context target must be positive")
        if not math.isfinite(self.child_timeout_seconds) or self.child_timeout_seconds <= 0:
            raise ValueError("adaptive child timeout must be positive")
        if not math.isfinite(self.leaf_timeout_seconds) or self.leaf_timeout_seconds <= 0:
            raise ValueError("adaptive leaf timeout must be positive")
        if self.domain_request_limit < 1 or self.leaf_request_limit < 1:
            raise ValueError("adaptive child request limits must be positive")
        if self.domain_total_tokens_limit < 1 or self.leaf_total_tokens_limit < 1:
            raise ValueError("adaptive child token limits must be positive")
        if self.reviewer_request_limit < 1 or self.reviewer_total_tokens_limit < 1:
            raise ValueError("adaptive reviewer budgets must be positive")
        if self.dynamic_workflow and self.max_depth < 2:
            raise ValueError("DynamicWorkflow requires the Root → Domain → Leaf depth")
        if self.dynamic_workflow and self.domain_fanout < 1:
            raise ValueError("DynamicWorkflow requires at least one Leaf agent")

    @classmethod
    def from_limits(cls, limits: object, *, enabled: bool) -> "AdaptivePolicy":
        def value(name: str, default: Any) -> Any:
            return getattr(limits, name, default)

        domain_timeout = float(value("adaptive_child_timeout_seconds", 120.0))
        return cls(
            enabled=enabled,
            max_depth=int(value("adaptive_max_depth", 2)),
            root_fanout=int(value("adaptive_root_fanout", 2)),
            domain_fanout=int(value("adaptive_domain_fanout", 2)),
            child_concurrency=int(value("adaptive_child_concurrency", 4)),
            context_target_tokens=int(value("context_target_tokens", 100_000)),
            child_timeout_seconds=domain_timeout,
            leaf_timeout_seconds=float(value("adaptive_leaf_timeout_seconds", 90.0)),
            domain_request_limit=int(value("adaptive_domain_request_limit", 6)),
            leaf_request_limit=int(value("adaptive_leaf_request_limit", 3)),
            domain_total_tokens_limit=int(value("adaptive_domain_total_tokens_limit", 25_000)),
            leaf_total_tokens_limit=int(value("adaptive_leaf_total_tokens_limit", 18_000)),
            enable_reviewer=bool(value("adaptive_enable_reviewer", True)),
            reviewer_request_limit=int(value("adaptive_reviewer_request_limit", 5)),
            reviewer_total_tokens_limit=int(value("adaptive_reviewer_total_tokens_limit", 30_000)),
            dynamic_workflow=bool(value("adaptive_dynamic_workflow", False)),
        )

    def child_count_reservation(self) -> tuple[int, int]:
        """Worst-case child requests/tokens reserved before Root starts."""
        if not self.enabled:
            return 0, 0
        domains = self.root_fanout if self.max_depth >= 1 else 0
        leaves = domains * self.domain_fanout if self.max_depth >= 2 else 0
        requests = domains * self.domain_request_limit + leaves * self.leaf_request_limit
        tokens = domains * self.domain_total_tokens_limit + leaves * self.leaf_total_tokens_limit
        if self.enable_reviewer:
            requests += self.reviewer_request_limit
            tokens += self.reviewer_total_tokens_limit
        return requests, tokens


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


class _ReceiptToolset(FunctionToolset[AdaptiveDeps]):
    """Host-mediated receipt access; no Analysis Workspace mount is exposed."""

    def __init__(self) -> None:
        super().__init__(sequential=True)
        self.add_function(self.publish_receipt, name="publish_receipt")
        self.add_function(self.publish_fallback_receipt, name="publish_fallback_receipt")
        self.add_function(self.read_receipt, name="read_receipt")
        self.add_function(self.read_artifact, name="read_artifact")

    def publish_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        run_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        scope: str,
        parent_id: str | None = None,
        source_revision: str | None = None,
        summary: str = "",
        findings: list[str] | None = None,
        evidence: list[ReceiptEvidence] | None = None,
        child_receipts: list[str] | None = None,
        open_questions: list[str] | None = None,
        artifact_name: str | None = None,
        artifact_markdown: str | None = None,
    ) -> str:
        deps = _require_deps(ctx)
        if run_id != deps.run_id or node_id != deps.node_id or parent_id != deps.parent_id:
            raise ModelRetry("Receipt identity does not match the Host assignment")
        if attempt != deps.attempt:
            raise ModelRetry(f"Use the Host-assigned receipt attempt {deps.attempt}")
        if (artifact_name is None) != (artifact_markdown is None):
            raise ModelRetry("Provide both artifact_name and artifact_markdown, or neither")
        artifacts: dict[str, str] = {}
        descriptors: list[ReceiptArtifact] = []
        if artifact_name is not None and artifact_markdown is not None:
            raw = artifact_markdown.encode("utf-8")
            descriptors.append(
                ReceiptArtifact(
                    path=artifact_name,
                    media_type="text/markdown",
                    bytes=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                )
            )
            artifacts[artifact_name] = artifact_markdown
        receipt = AnalysisReceipt(
            run_id=run_id,
            node_id=node_id,
            parent_id=parent_id,
            attempt=attempt,
            status=status,
            scope=scope,
            source_revision=source_revision,
            summary=summary,
            findings=findings or [],
            evidence=evidence or [],
            child_receipts=child_receipts or [],
            artifacts=descriptors,
            open_questions=open_questions or [],
        )
        return self._publish(deps, receipt, task_id=deps.task_id, artifacts=artifacts, current=True)

    def publish_fallback_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        run_id: str,
        task_id: str,
        node_id: str,
        parent_id: str,
        attempt: int,
        scope: str,
        source_revision: str | None = None,
        summary: str = "",
        findings: list[str] | None = None,
        evidence: list[ReceiptEvidence] | None = None,
        child_receipts: list[str] | None = None,
        open_questions: list[str] | None = None,
        artifact_name: str | None = None,
        artifact_markdown: str | None = None,
    ) -> str:
        """Publish a complete receipt for a failed child after bounded retries."""
        deps = _require_deps(ctx)
        if deps.role == "leaf":
            raise ModelRetry("Leaf agents cannot perform direct fallback research")
        if run_id != deps.run_id:
            raise ModelRetry("Fallback receipt run_id does not match the Host assignment")
        if deps.metrics.node_parents.get(node_id) != deps.node_id:
            raise ModelRetry("Fallback target is not an assigned child of this Host")
        if parent_id != deps.node_id:
            raise ModelRetry("Fallback parent_id does not match the Host assignment")
        if task_id != node_id:
            raise ModelRetry("Fallback task_id and node_id must match the Host assignment")
        if attempt != deps.metrics.next_attempts.get(node_id):
            expected = deps.metrics.next_attempts.get(node_id, 1)
            raise ModelRetry(f"Use the Host-assigned fallback receipt attempt {expected}")
        if (artifact_name is None) != (artifact_markdown is None):
            raise ModelRetry("Provide both artifact_name and artifact_markdown, or neither")
        artifacts: dict[str, str] = {}
        descriptors: list[ReceiptArtifact] = []
        if artifact_name is not None and artifact_markdown is not None:
            raw = artifact_markdown.encode("utf-8")
            descriptors.append(
                ReceiptArtifact(
                    path=artifact_name,
                    media_type="text/markdown",
                    bytes=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                )
            )
            artifacts[artifact_name] = artifact_markdown
        receipt = AnalysisReceipt(
            run_id=run_id,
            node_id=node_id,
            parent_id=parent_id,
            attempt=attempt,
            status="complete",
            scope=scope,
            source_revision=source_revision,
            summary=summary,
            findings=findings or [],
            evidence=evidence or [],
            child_receipts=child_receipts or [],
            artifacts=descriptors,
            open_questions=open_questions or [],
        )
        try:
            deps.metrics.mark_direct_fallback(node_id)
            return self._publish(
                deps, receipt, task_id=task_id, artifacts=artifacts, current=False, fallback=True
            )
        except Exception:
            # Do not let a failed publication make an incomplete branch appear complete.
            deps.metrics.node_states[node_id] = "failed"
            deps.metrics.next_attempts[node_id] = attempt
            deps.metrics.direct_fallbacks = max(0, deps.metrics.direct_fallbacks - 1)
            raise

    def _publish(
        self,
        deps: AdaptiveDeps,
        receipt: AnalysisReceipt,
        *,
        task_id: str,
        artifacts: dict[str, str],
        current: bool,
        fallback: bool = False,
    ) -> str:
        handoff = deps.workspace.publish_receipt(receipt, task_id=task_id, artifacts=artifacts)
        if current:
            deps.published = handoff
        receipt_size = 0
        try:
            receipt_size = (deps.workspace.root / handoff.receipt).stat().st_size
        except OSError:
            pass
        deps.emit(
            "receipt_published",
            {
                "depth": deps.depth,
                "status": handoff.status,
                "receipt_bytes": receipt_size,
                "fallback": fallback,
            },
            node_id=receipt.node_id,
        )
        return handoff.model_dump_json()

    def read_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        task_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        receipt: str,
    ) -> str:
        deps = _require_deps(ctx)
        handoff = HandoffRef(
            task_id=task_id,
            node_id=node_id,
            attempt=attempt,
            status=status,
            receipt=receipt,
        )
        if deps.role != "root":
            allowed = handoff.task_id == deps.task_id or handoff.task_id.startswith(
                f"{deps.task_id}-leaf-"
            )
            if not allowed:
                raise ModelRetry("Receipt access is limited to this task and its assigned children")
        loaded = deps.workspace.read_receipt(handoff)
        # The Analysis Workspace already enforces the canonical 128 KiB receipt cap.
        return loaded.model_dump_json(by_alias=True)

    def read_artifact(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        task_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        receipt: str,
        path: str,
        offset: int = 0,
        limit: int = 64 * 1024,
    ) -> str:
        deps = _require_deps(ctx)
        handoff = HandoffRef(
            task_id=task_id,
            node_id=node_id,
            attempt=attempt,
            status=status,
            receipt=receipt,
        )
        if deps.role != "root":
            allowed = handoff.task_id == deps.task_id or handoff.task_id.startswith(
                f"{deps.task_id}-leaf-"
            )
            if not allowed:
                raise ModelRetry(
                    "Artifact access is limited to this task and its assigned children"
                )
        return deps.workspace.read_artifact(
            handoff, path, offset=offset, limit=limit
        ).model_dump_json()


def _require_deps(ctx: RunContext[AdaptiveDeps]) -> AdaptiveDeps:
    if not isinstance(ctx.deps, AdaptiveDeps):
        raise ModelRetry("Host orchestration dependencies are unavailable; stop delegation")
    return ctx.deps


def _publish_failure_receipt(
    deps: AdaptiveDeps, status: Literal["failed", "cancelled"], reason: str
) -> None:
    """Leave a bounded host receipt when a child exits before publishing one."""
    if deps.published is not None:
        return
    try:
        receipt = AnalysisReceipt(
            run_id=deps.run_id,
            node_id=deps.node_id,
            parent_id=deps.parent_id,
            attempt=deps.attempt,
            status=status,
            scope=f"{deps.role}:{deps.task_id}",
            summary="Child execution did not produce a complete research receipt.",
            open_questions=[reason],
        )
        handoff = deps.workspace.publish_receipt(receipt, task_id=deps.task_id)
        deps.published = handoff
        receipt_size = 0
        try:
            receipt_size = (deps.workspace.root / handoff.receipt).stat().st_size
        except OSError:
            pass
        deps.emit(
            "receipt_published",
            {"depth": deps.depth, "status": handoff.status, "receipt_bytes": receipt_size},
            node_id=deps.node_id,
        )
    except Exception:
        # The original child error remains authoritative; diagnostics must not mask it.
        pass


class _BoundedAgent(WrapperAgent[AdaptiveDeps, str]):
    """Add the one global child-concurrency gate to an ordinary Agent."""

    def __init__(
        self,
        wrapped: AbstractAgent[AdaptiveDeps, str],
        *,
        task_id: str,
        node_id: str,
        parent_id: str,
        depth: int,
        role: Role,
        semaphore: asyncio.Semaphore,
        parent_semaphore: asyncio.Semaphore | None,
        retry_request_cost: int,
        retry_token_cost: int,
        metrics: _AdaptiveMetrics,
        emit: Callable[..., None],
    ) -> None:
        super().__init__(wrapped)
        self._task_id = task_id
        self._node_id = node_id
        self._parent_id = parent_id
        self._depth = depth
        self._role = role
        self._semaphore = semaphore
        self._parent_semaphore = parent_semaphore
        self._attempt_lock = asyncio.Lock()
        self._retry_request_cost = retry_request_cost
        self._retry_token_cost = retry_token_cost
        self._metrics = metrics
        self._emit = emit

    def _finish(
        self,
        deps: AdaptiveDeps,
        state: NodeState,
        started_at: float,
        *,
        reason_code: str | None = None,
    ) -> None:
        if deps.published is not None:
            state = cast(NodeState, deps.published.status)
        self._metrics.finish_attempt(
            self._node_id, state, receipt_published=deps.published is not None
        )
        payload: dict[str, object] = {
            "depth": self._depth,
            "node_kind": self._role,
            "status": state,
            "active": self._metrics.active_children - 1,
            "duration_seconds": max(0.0, asyncio.get_running_loop().time() - started_at),
        }
        if reason_code is not None:
            payload["reason_code"] = reason_code
        self._emit("child_finished", payload, node_id=self._node_id)

    async def run(self, *args: Any, **kwargs: Any) -> AgentRunResult[str]:
        incoming = kwargs.get("deps")
        if not isinstance(incoming, AdaptiveDeps):
            raise ValueError("bounded child Agent requires Host orchestration dependencies")
        self._emit(
            "child_dispatched",
            {"depth": self._depth, "node_kind": self._role},
            node_id=self._node_id,
        )
        loop = asyncio.get_running_loop()
        queue_started = loop.time()
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(self._attempt_lock)
            if self._parent_semaphore is not None:
                await stack.enter_async_context(self._parent_semaphore)
            await stack.enter_async_context(self._semaphore)
            queue_seconds = max(0.0, loop.time() - queue_started)
            self._metrics.record_queue_wait(queue_seconds)
            try:
                attempt = self._metrics.begin_attempt(
                    self._node_id,
                    retry_request_cost=self._retry_request_cost,
                    retry_token_cost=self._retry_token_cost,
                )
            except ModelRetry:
                self._emit(
                    "child_rejected",
                    {
                        "depth": self._depth,
                        "node_kind": self._role,
                        "reason_code": "retry_reserve",
                        "queue_seconds": queue_seconds,
                    },
                    node_id=self._node_id,
                )
                raise
            deps = incoming.for_node(
                task_id=self._task_id,
                node_id=self._node_id,
                parent_id=self._parent_id,
                depth=self._depth,
                role=self._role,
                attempt=attempt,
            )
            kwargs["deps"] = deps
            child_usage = RunUsage()
            kwargs["usage"] = child_usage
            self._metrics.active_children += 1
            self._metrics.max_active_children = max(
                self._metrics.max_active_children, self._metrics.active_children
            )
            self._metrics.child_runs += 1
            started_at = loop.time()
            self._emit(
                "child_started",
                {
                    "depth": self._depth,
                    "node_kind": self._role,
                    "active": self._metrics.active_children,
                    "queue_seconds": queue_seconds,
                },
                node_id=self._node_id,
            )
            try:
                try:
                    result = await self.wrapped.run(*args, **kwargs)
                except asyncio.CancelledError:
                    _publish_failure_receipt(deps, "cancelled", "CancelledError")
                    self._finish(deps, "cancelled", started_at, reason_code="CancelledError")
                    raise
                except Exception as error:
                    reason = type(error).__name__
                    _publish_failure_receipt(deps, "failed", reason)
                    self._finish(deps, "failed", started_at, reason_code=reason)
                    raise
                self._finish(deps, "complete", started_at)
                return result
            finally:
                _add_usage(self._metrics.usage, child_usage)
                self._metrics.active_children -= 1


def _add_usage(target: dict[str, int], usage: object) -> None:
    for key in target:
        target[key] += int(getattr(usage, key, 0) or 0)
    target["total_tokens"] = target["input_tokens"] + target["output_tokens"]


class _OrchestrationEvents(AbstractCapability[AdaptiveDeps]):
    """Project bounded Harness state changes into the public event seam."""

    async def after_tool_execute(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        result: Any,
    ) -> Any:
        del tool_def
        if call.tool_name == "write_plan":
            deps = _require_deps(ctx)
            items = args.get("items")
            total = len(items) if isinstance(items, list) else 0
            deps.emit(
                "plan_updated",
                {"depth": deps.depth, "node_kind": deps.role, "total": total},
                node_id=deps.node_id,
            )
        return result


def _mounts(
    *,
    source_mount: Path,
    skill_mount: Path,
    staging: Path | None,
    root: bool,
    write_limit: int,
    wiki_mode: Literal["read-write", "read-only"] | None = None,
) -> list[MountDir]:
    mounts = [
        MountDir("/source", str(source_mount), mode="read-only"),
        MountDir("/skill", str(skill_mount), mode="read-only"),
    ]
    resolved_wiki_mode = wiki_mode
    if resolved_wiki_mode is None and root and staging is not None:
        resolved_wiki_mode = "read-write"
    if resolved_wiki_mode is not None and staging is not None:
        if resolved_wiki_mode == "read-write":
            mounts.append(
                MountDir(
                    "/wiki",
                    str(staging),
                    mode="read-write",
                    write_bytes_limit=write_limit,
                )
            )
        else:
            mounts.append(MountDir("/wiki", str(staging), mode="read-only"))
    return mounts


def _child_limits(
    policy: AdaptivePolicy, role: Literal["domain", "leaf", "reviewer"]
) -> UsageLimits:
    if role == "domain":
        requests, tokens = policy.domain_request_limit, policy.domain_total_tokens_limit
    elif role == "reviewer":
        requests, tokens = policy.reviewer_request_limit, policy.reviewer_total_tokens_limit
    else:
        requests, tokens = policy.leaf_request_limit, policy.leaf_total_tokens_limit
    return UsageLimits(
        request_limit=requests,
        tool_calls_limit=max(1, requests * 2),
        total_tokens_limit=tokens,
    )


def _handoff_validator(agent: Agent[AdaptiveDeps, str]) -> None:
    @agent.output_validator
    def validate(ctx: RunContext[AdaptiveDeps], output: str) -> str:
        deps = _require_deps(ctx)
        try:
            handoff = HandoffRef.model_validate_json(output)
        except Exception as error:
            raise ModelRetry(
                "Return only the JSON Handoff Ref produced by publish_receipt; do not return prose."
            ) from error
        if deps.published is None or handoff != deps.published:
            raise ModelRetry(
                "Publish the assigned Analysis Receipt before returning its Handoff Ref."
            )
        if handoff.task_id != deps.task_id or handoff.node_id != deps.node_id:
            raise ModelRetry("The Handoff Ref identity does not match the assigned task.")
        return handoff.model_dump_json()


def _make_leaf(
    *,
    model: object,
    settings: ModelSettings,
    source_mount: Path,
    skill_mount: Path,
    workspace: AnalysisWorkspace,
    run_id: str,
    policy: AdaptivePolicy,
    parent_id: str,
    index: int,
    semaphore: asyncio.Semaphore,
    metrics: _AdaptiveMetrics,
    emit: Callable[..., None],
) -> SubAgent[AdaptiveDeps]:
    task_id = f"{parent_id}-leaf-{index}"
    node_id = task_id
    workspace.register_node(task_id, node_id, parent_id)
    metrics.register_node(node_id, parent_id)

    def leaf_instructions(ctx: RunContext[AdaptiveDeps]) -> str:
        deps = _require_deps(ctx)
        return (
            "You are a Leaf Researcher. Read /skill/references/leaf-research.md in full before "
            "reading /source, then follow it. /source and /skill are read-only; /wiki and further "
            "delegation are unavailable. Call publish_receipt with named fields matching this "
            "Host assignment, not a nested receipt object. "
            f"Host assignment: run_id={run_id}, task_id={task_id}, node_id={node_id}, "
            f"parent_id={parent_id}, attempt={deps.attempt}."
        )

    agent = Agent[AdaptiveDeps, str](
        cast(Any, model),
        name=f"leaf_{index}",
        description="Investigate one self-contained source scope and publish a bounded receipt.",
        deps_type=AdaptiveDeps,
        output_type=str,
        instructions=leaf_instructions,
        model_settings=settings,
        retries=2,
        toolsets=[_ReceiptToolset()],
        capabilities=[
            *build_context_capabilities(
                model=model,
                target_tokens=policy.context_target_tokens,
                workspace=workspace,
            ),
            CodeMode(
                max_retries=2,
                os_access=None,
                mount=_mounts(
                    source_mount=source_mount,
                    skill_mount=skill_mount,
                    staging=None,
                    root=False,
                    write_limit=0,
                ),
            ),
        ],
    )
    agent.instrument = False
    _handoff_validator(agent)
    bounded = _BoundedAgent(
        agent,
        task_id=task_id,
        node_id=node_id,
        parent_id=parent_id,
        depth=2,
        role="leaf",
        semaphore=semaphore,
        parent_semaphore=None,
        retry_request_cost=policy.leaf_request_limit,
        retry_token_cost=policy.leaf_total_tokens_limit,
        metrics=metrics,
        emit=emit,
    )
    return SubAgent(
        bounded,
        name=f"leaf_{index}",
        usage_limits=_child_limits(policy, "leaf"),
        timeout_seconds=policy.leaf_timeout_seconds,
        # One intentional Host retry; tool_retries covers transient ModelRetry only.
        max_calls=2,
        on_failure=(
            "Leaf incomplete. Retry once within budget, else leave unresolved and continue."
        ),
        contain_errors=True,
    )


def _make_domain(
    *,
    model: object,
    settings: ModelSettings,
    source_mount: Path,
    skill_mount: Path,
    workspace: AnalysisWorkspace,
    run_id: str,
    policy: AdaptivePolicy,
    index: int,
    semaphore: asyncio.Semaphore,
    domain_semaphore: asyncio.Semaphore,
    metrics: _AdaptiveMetrics,
    emit: Callable[..., None],
    write_limit: int,
) -> SubAgent[AdaptiveDeps]:
    task_id = f"domain-{index}"
    workspace.register_node(task_id, task_id, "root")
    metrics.register_node(task_id, "root")
    leaves = (
        [
            _make_leaf(
                model=model,
                settings=settings,
                source_mount=source_mount,
                skill_mount=skill_mount,
                workspace=workspace,
                run_id=run_id,
                policy=policy,
                parent_id=task_id,
                index=leaf_index,
                semaphore=semaphore,
                metrics=metrics,
                emit=emit,
            )
            for leaf_index in range(1, policy.domain_fanout + 1)
        ]
        if policy.max_depth >= 2
        else []
    )
    leaf_agents = [entry.agent for entry in leaves]
    leaf_capability: object
    if policy.dynamic_workflow and leaves:
        # DynamicWorkflow is intentionally one-layer only. Leaf agents have no
        # DynamicWorkflow capability, so nesting cannot be silently introduced.
        leaf_capability = DynamicWorkflow(
            agents=[WorkflowAgent(cast(Any, agent)) for agent in leaf_agents],
            max_agent_calls=policy.domain_fanout,
            max_retries=2,
            forward_usage=False,
            sub_agent_usage_limits=_child_limits(policy, "leaf"),
        )
    elif leaves:
        leaf_capability = SubAgents(
            agents=leaves,
            agent_folders=None,
            inherit_tools=False,
            forward_usage=False,
            # max_calls=2 owns the intentional second attempt; keep tool retries thin.
            tool_retries=1,
            contain_errors=True,
        )
    domain_capabilities: list[Any] = [
        _OrchestrationEvents(),
        Planning(),
        *build_context_capabilities(
            model=model,
            target_tokens=policy.context_target_tokens,
            workspace=workspace,
        ),
    ]
    if leaves:
        domain_capabilities.append(cast(Any, leaf_capability))

    def domain_instructions(ctx: RunContext[AdaptiveDeps]) -> str:
        deps = _require_deps(ctx)
        return (
            "You are a Domain Researcher. Read /skill/references/domain-research.md in full before "
            "reading /source, then follow it. /source and /skill are read-only; /wiki is unavailable. "
            "A DynamicWorkflow cannot be nested. When two independent Leaf scopes are needed, fan "
            "them out in one CodeMode script with asyncio.gather over delegate_task (or the "
            "optional DynamicWorkflow); do not serialize independent Leaf work. Every "
            "delegate_task must be self-contained. Call publish_receipt with named fields matching "
            "this Host assignment, not a nested receipt object. "
            f"Host assignment: run_id={run_id}, task_id={task_id}, node_id={task_id}, "
            f"parent_id=root, attempt={deps.attempt}."
        )

    agent = Agent[AdaptiveDeps, str](
        cast(Any, model),
        name=f"domain_{index}",
        description="Research one bounded domain and reduce child receipts into one handoff.",
        deps_type=AdaptiveDeps,
        output_type=str,
        instructions=domain_instructions,
        model_settings=settings,
        retries=2,
        toolsets=[_ReceiptToolset()],
        capabilities=[
            *domain_capabilities,
            CodeMode(
                max_retries=2,
                os_access=None,
                mount=_mounts(
                    source_mount=source_mount,
                    skill_mount=skill_mount,
                    staging=None,
                    root=False,
                    write_limit=write_limit,
                ),
            ),
        ],
    )
    agent.instrument = False
    _handoff_validator(agent)
    bounded = _BoundedAgent(
        agent,
        task_id=task_id,
        node_id=task_id,
        parent_id="root",
        depth=1,
        role="domain",
        semaphore=semaphore,
        parent_semaphore=domain_semaphore,
        retry_request_cost=policy.domain_request_limit,
        retry_token_cost=policy.domain_total_tokens_limit,
        metrics=metrics,
        emit=emit,
    )
    return SubAgent(
        bounded,
        name=f"domain_{index}",
        usage_limits=_child_limits(policy, "domain"),
        timeout_seconds=policy.child_timeout_seconds,
        max_calls=2,
        on_failure=(
            "Domain incomplete. Retry once within budget, else leave unresolved and fallback."
        ),
        contain_errors=True,
    )


@dataclass(frozen=True, slots=True)
class ReviewDefectsSummary:
    """Bounded, secret-safe Wiki Reviewer outcome for the publication gate."""

    status: Literal["complete", "partial", "failed", "cancelled", "skipped"]
    summary: str = ""
    findings: tuple[str, ...] = ()
    open_questions: tuple[str, ...] = ()
    defect_count: int = 0

    def as_gate_args(self) -> dict[str, object]:
        """Shape attached to the deferred ``publish_wiki`` approval args."""
        return {
            "status": self.status,
            "summary": self.summary,
            "findings": list(self.findings),
            "open_questions": list(self.open_questions),
            "defect_count": self.defect_count,
        }

    def as_record_fragment(self) -> dict[str, object]:
        """Compact fragment for Wiki Run Record publication metadata."""
        return {
            "status": self.status,
            "summary": self.summary,
            "defect_count": self.defect_count,
            "findings": list(self.findings),
        }


def _bound_defect_text(value: str, *, max_chars: int = _MAX_DEFECT_TEXT_CHARS) -> str:
    text = redact_secrets(" ".join(str(value).split()), environment_secrets())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1] + "…"


def _bound_defect_list(
    values: list[str] | tuple[str, ...], *, max_items: int = _MAX_DEFECT_FINDINGS
) -> tuple[str, ...]:
    return tuple(_bound_defect_text(item) for item in list(values)[:max_items])


def _make_reviewer(
    *,
    model: object,
    settings: ModelSettings,
    source_mount: Path,
    skill_mount: Path,
    staging: Path,
    workspace: AnalysisWorkspace,
    run_id: str,
    policy: AdaptivePolicy,
    semaphore: asyncio.Semaphore,
    metrics: _AdaptiveMetrics,
    emit: Callable[..., None],
    task_id: str = "reviewer",
    max_calls: int = 2,
) -> SubAgent[AdaptiveDeps]:
    """Independent Wiki Reviewer: read-only /wiki, no delegation, defects receipt only."""
    workspace.register_node(task_id, task_id, "root")
    metrics.register_node(task_id, "root")

    def reviewer_instructions(ctx: RunContext[AdaptiveDeps]) -> str:
        deps = _require_deps(ctx)
        return (
            "You are a Wiki Reviewer. Read /skill/references/review.md in full before inspecting "
            "/wiki or /source, then follow it. /source, /skill, and /wiki are read-only; you cannot "
            "delegate or write Wiki pages. Publish a defects receipt through publish_receipt with "
            "named fields matching this Host assignment, not a nested receipt object. Root remains "
            "the only writer and will decide how to repair. "
            f"Host assignment: run_id={run_id}, task_id={task_id}, node_id={task_id}, "
            f"parent_id=root, attempt={deps.attempt}."
        )

    agent = Agent[AdaptiveDeps, str](
        cast(Any, model),
        name=task_id,
        description=(
            "Independently review staged Wiki pages against source and the Producer Skill review "
            "checklist; publish a bounded defects receipt."
        ),
        deps_type=AdaptiveDeps,
        output_type=str,
        instructions=reviewer_instructions,
        model_settings=settings,
        retries=2,
        toolsets=[_ReceiptToolset()],
        capabilities=[
            _OrchestrationEvents(),
            Planning(),
            *build_context_capabilities(
                model=model,
                target_tokens=policy.context_target_tokens,
                workspace=workspace,
            ),
            CodeMode(
                max_retries=2,
                os_access=None,
                mount=_mounts(
                    source_mount=source_mount,
                    skill_mount=skill_mount,
                    staging=staging,
                    root=False,
                    write_limit=0,
                    wiki_mode="read-only",
                ),
            ),
        ],
    )
    agent.instrument = False
    _handoff_validator(agent)
    bounded = _BoundedAgent(
        agent,
        task_id=task_id,
        node_id=task_id,
        parent_id="root",
        depth=1,
        role="reviewer",
        semaphore=semaphore,
        parent_semaphore=None,
        retry_request_cost=policy.reviewer_request_limit,
        retry_token_cost=policy.reviewer_total_tokens_limit,
        metrics=metrics,
        emit=emit,
    )
    return SubAgent(
        bounded,
        name=task_id,
        usage_limits=_child_limits(policy, "reviewer"),
        timeout_seconds=policy.child_timeout_seconds,
        # One Reviewer roster slot; max_calls=2 allows the single intentional retry.
        max_calls=max_calls,
        on_failure=(
            "Review incomplete. Retry once within budget; do not claim Complete if still unresolved."
        ),
        contain_errors=True,
    )


async def run_host_wiki_reviewer(
    *,
    model: object,
    settings: ModelSettings,
    source_mount: Path,
    skill_mount: Path,
    staging: Path,
    workspace: AnalysisWorkspace,
    run_id: str,
    policy: AdaptivePolicy,
    root_deps: AdaptiveDeps,
    metrics: _AdaptiveMetrics,
    emit: Callable[..., None],
) -> ReviewDefectsSummary:
    """Run the Host-owned Wiki Reviewer once before the publication approval gate.

    Soft-fails into a ``failed`` summary so the operator can still approve/deny;
    Host mechanical validation remains independent and must already have passed.
    """
    emit(
        "review_started",
        {"node_kind": "reviewer", "status": "running"},
        node_id=HOST_PUBLISH_REVIEWER_NODE_ID,
    )
    semaphore = root_deps.semaphore
    subagent = _make_reviewer(
        model=model,
        settings=settings,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=staging,
        workspace=workspace,
        run_id=run_id,
        policy=policy,
        semaphore=semaphore,
        metrics=metrics,
        emit=emit,
        task_id=HOST_PUBLISH_REVIEWER_NODE_ID,
        # Host runs the Reviewer once; intentional single retry stays inside the agent.
        max_calls=2,
    )
    prompt = (
        "Review the staged Wiki pages under /wiki against /source and "
        "/skill/references/review.md. Publish a bounded defects receipt via publish_receipt, "
        "then return only that Handoff Ref JSON."
    )
    try:
        async with asyncio.timeout(policy.child_timeout_seconds):
            result = await subagent.agent.run(
                prompt,
                deps=root_deps,
                usage_limits=subagent.usage_limits,
            )
        handoff = HandoffRef.model_validate_json(result.output)
        receipt = workspace.read_receipt(handoff)
        findings = _bound_defect_list(receipt.findings)
        open_questions = _bound_defect_list(receipt.open_questions)
        summary = ReviewDefectsSummary(
            status=receipt.status,
            summary=_bound_defect_text(receipt.summary),
            findings=findings,
            open_questions=open_questions,
            defect_count=len(findings) + len(open_questions),
        )
        emit(
            "review_succeeded",
            {
                "node_kind": "reviewer",
                "status": summary.status,
                "count": summary.defect_count,
            },
            node_id=HOST_PUBLISH_REVIEWER_NODE_ID,
        )
        return summary
    except Exception as error:
        reason = type(error).__name__
        summary = ReviewDefectsSummary(
            status="failed",
            summary=_bound_defect_text(f"Wiki Reviewer did not complete: {reason}"),
            findings=(),
            open_questions=(),
            defect_count=0,
        )
        emit(
            "review_failed",
            {"node_kind": "reviewer", "status": "failed", "reason_code": reason},
            node_id=HOST_PUBLISH_REVIEWER_NODE_ID,
        )
        return summary


@dataclass(slots=True)
class AdaptiveOrchestrator:
    """Built Root capability set plus host state for one Wiki Run."""

    policy: AdaptivePolicy
    root_deps: AdaptiveDeps
    root_usage_limits: UsageLimits
    metrics: _AdaptiveMetrics

    def validate_root_completion(self) -> None:
        if self.metrics.unresolved_failures():
            raise ModelRetry(
                "One or more critical research branches are incomplete. Resolve them within the "
                "bounded retry or direct-fallback budget; otherwise fail this Wiki Run. Do not "
                "claim Complete or convert an internal branch failure into NeedsInput."
            )

    def event_payload(self) -> dict[str, object]:
        return {
            "depth": self.policy.max_depth,
            "fanout": self.metrics.child_runs,
            "retries": self.metrics.retries,
            "fallbacks": self.metrics.direct_fallbacks,
            "active": self.metrics.active_children,
            "max_active": self.metrics.max_active_children,
            "queue_seconds_total": round(self.metrics.queue_seconds_total, 3),
            "max_queue_seconds": round(self.metrics.max_queue_seconds, 3),
            "critical_failures": self.metrics.unresolved_failures(),
        }


def should_enable_adaptive(
    *, repository_count: int, source_files: int, source_bytes: int, limits: object
) -> bool:
    """Cheap deterministic trigger; semantic splitting remains model-owned."""
    file_threshold = int(getattr(limits, "adaptive_source_files_threshold", 128))
    byte_threshold = int(getattr(limits, "adaptive_source_bytes_threshold", 1_000_000))
    if file_threshold < 1 or byte_threshold < 1:
        raise ValueError("adaptive source thresholds must be positive")
    if repository_count < 0 or source_files < 0 or source_bytes < 0:
        raise ValueError("adaptive source measurements must be non-negative")
    return repository_count > 1 or source_files >= file_threshold or source_bytes >= byte_threshold


def build_root_agent(
    *,
    model: object,
    settings: ModelSettings,
    output_type: object,
    instructions: str,
    source_mount: Path,
    skill_mount: Path,
    staging: Path,
    workspace: AnalysisWorkspace,
    run_id: str,
    limits: object,
    adaptive: bool,
    write_limit: int,
    emit: Callable[..., None],
    reviewer_model: object | None = None,
    reviewer_settings: ModelSettings | None = None,
) -> tuple[Agent[Any, Any], AdaptiveOrchestrator]:
    policy = AdaptivePolicy.from_limits(limits, enabled=adaptive)
    metrics = _AdaptiveMetrics()
    semaphore = asyncio.Semaphore(policy.child_concurrency)
    # When leaves exist, reserve fan-out slots so concurrent Domains do not leave only
    # one global slot for all Leaf work (Domain holds a slot for its whole run).
    if policy.max_depth >= 2:
        domain_capacity = max(1, policy.child_concurrency - policy.domain_fanout)
    else:
        domain_capacity = policy.child_concurrency
    domain_semaphore = asyncio.Semaphore(max(1, domain_capacity))
    root_deps = AdaptiveDeps(
        run_id=run_id,
        workspace=workspace,
        task_id="root",
        node_id="root",
        parent_id=None,
        depth=0,
        role="root",
        attempt=1,
        semaphore=semaphore,
        emit=emit,
        metrics=metrics,
    )
    metrics.register_node("root", None)
    if adaptive and (policy.max_depth < 1 or policy.root_fanout < 1):
        emit("adaptive_disabled", {"reason_code": "topology_empty"})
        policy = replace(policy, enabled=False)
        adaptive = False
    if adaptive and policy.max_depth >= 2 and policy.child_concurrency < 2:
        emit("adaptive_disabled", {"reason_code": "concurrency_too_small"})
        policy = replace(policy, enabled=False)
        adaptive = False
    reserved_requests, reserved_tokens = policy.child_count_reservation()
    request_limit = int(getattr(limits, "request_limit", 50))
    tool_calls_limit = int(getattr(limits, "tool_calls_limit", 200))
    total_tokens_limit = int(getattr(limits, "total_tokens_limit", 350_000))
    if (
        adaptive
        and policy.root_fanout > 2
        and (
            request_limit - reserved_requests < 18 or total_tokens_limit - reserved_tokens < 150_000
        )
    ):
        emit("adaptive_disabled", {"reason_code": "expanded_envelope_too_small"})
        policy = replace(policy, enabled=False)
        adaptive = False
    root_request_budget = min(18, request_limit - reserved_requests) if adaptive else request_limit
    # Harness child runs use isolated local usage accounting in this first
    # version, so the existing tool-call ceiling remains the run-level value.
    root_tool_calls_budget = tool_calls_limit
    root_token_budget = (
        min(150_000, total_tokens_limit - reserved_tokens) if adaptive else total_tokens_limit
    )
    if adaptive and (root_request_budget < 1 or root_token_budget < 1):
        # Fail closed instead of silently adding children on top of the product envelope.
        emit("adaptive_disabled", {"reason_code": "envelope_too_small"})
        policy = replace(policy, enabled=False)
        adaptive = False
        root_request_budget = request_limit
        root_tool_calls_budget = tool_calls_limit
        root_token_budget = total_tokens_limit
    if adaptive:
        metrics.retry_requests_remaining = max(
            0, request_limit - root_request_budget - reserved_requests
        )
        metrics.retry_tokens_remaining = max(
            0, total_tokens_limit - root_token_budget - reserved_tokens
        )
    root_usage = UsageLimits(
        request_limit=max(1, root_request_budget),
        tool_calls_limit=max(1, root_tool_calls_budget),
        total_tokens_limit=max(1, root_token_budget),
        input_tokens_limit=int(getattr(limits, "input_tokens_limit", 250_000)),
        output_tokens_limit=int(getattr(limits, "output_tokens_limit", 100_000)),
    )
    # Every root that issues model requests gets harness context management.
    # Adaptive additionally enables Planning, orchestration events, and children.
    capabilities: list[Any] = [
        *build_context_capabilities(
            model=model,
            target_tokens=policy.context_target_tokens,
            workspace=workspace,
        ),
    ]
    toolsets: list[Any] = []
    if adaptive:
        capabilities.extend(
            [
                _OrchestrationEvents(),
                Planning(),
            ]
        )
        toolsets.append(_ReceiptToolset())
        roster: list[SubAgent[AdaptiveDeps]] = [
            _make_domain(
                model=model,
                settings=settings,
                source_mount=source_mount,
                skill_mount=skill_mount,
                workspace=workspace,
                run_id=run_id,
                policy=policy,
                index=index,
                semaphore=semaphore,
                domain_semaphore=domain_semaphore,
                metrics=metrics,
                emit=emit,
                write_limit=write_limit,
            )
            for index in range(1, policy.root_fanout + 1)
        ]
        if policy.enable_reviewer:
            review_model = model if reviewer_model is None else reviewer_model
            review_settings = settings if reviewer_settings is None else reviewer_settings
            roster.append(
                _make_reviewer(
                    model=review_model,
                    settings=review_settings,
                    source_mount=source_mount,
                    skill_mount=skill_mount,
                    staging=staging,
                    workspace=workspace,
                    run_id=run_id,
                    policy=policy,
                    semaphore=semaphore,
                    metrics=metrics,
                    emit=emit,
                )
            )
        capabilities.append(
            SubAgents(
                agents=roster,
                agent_folders=None,
                inherit_tools=False,
                forward_usage=False,
                # max_calls=2 owns the intentional second attempt; keep tool retries thin.
                tool_retries=1,
                contain_errors=True,
            )
        )
        emit(
            "adaptive_enabled",
            {
                "depth": policy.max_depth,
                "fanout": policy.root_fanout,
                "concurrency": policy.child_concurrency,
                "dynamic_workflow": policy.dynamic_workflow,
                "reviewer": policy.enable_reviewer,
            },
        )
    capabilities.append(
        CodeMode(
            max_retries=int(getattr(limits, "retries", 2)),
            os_access=None,
            mount=_mounts(
                source_mount=source_mount,
                skill_mount=skill_mount,
                staging=staging,
                root=True,
                write_limit=write_limit,
            ),
        )
    )
    root = Agent[AdaptiveDeps, Any](
        cast(Any, model),
        name="repository_wiki_producer",
        deps_type=AdaptiveDeps,
        output_type=cast(Any, output_type),
        instructions=instructions,
        model_settings=settings,
        retries={
            "tools": int(getattr(limits, "retries", 2)),
            "output": int(getattr(limits, "retries", 2)),
        },
        tool_timeout=float(getattr(limits, "tool_timeout_seconds", 30)),
        toolsets=toolsets,
        capabilities=capabilities,
    )
    root.instrument = False
    return root, AdaptiveOrchestrator(policy, root_deps, root_usage, metrics)


__all__ = [
    "AdaptiveDeps",
    "AdaptiveOrchestrator",
    "AdaptivePolicy",
    "HOST_PUBLISH_REVIEWER_NODE_ID",
    "ReviewDefectsSummary",
    "build_root_agent",
    "run_host_wiki_reviewer",
    "should_enable_adaptive",
]
