"""Bounded child agents: leaf, domain, and mid-run roster reviewer factories."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Literal, cast

from pydantic_ai import (
    Agent,
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

from ..analysis.workspace import AnalysisWorkspace, HandoffRef
from ..context import build_context_capabilities
from .deps import AdaptiveDeps, _AdaptiveMetrics
from .policy import AdaptivePolicy, NodeState, Role
from .receipts import _ReceiptToolset, _publish_failure_receipt, _require_deps


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
            raise ValueError("bounded child Agent requires run orchestration dependencies")
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


def _assignment_suffix(
    *,
    run_id: str,
    task_id: str,
    node_id: str,
    parent_id: str,
    attempt: int,
) -> str:
    return (
        "Call publish_receipt with named fields matching this run assignment, not a nested "
        "receipt object. "
        f"run assignment: run_id={run_id}, task_id={task_id}, node_id={node_id}, "
        f"parent_id={parent_id}, attempt={attempt}."
    )


def _wrap_research_subagent(
    *,
    agent: Agent[AdaptiveDeps, str],
    name: str,
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
    policy: AdaptivePolicy,
    usage_role: Literal["domain", "leaf", "reviewer"],
    timeout_seconds: float,
    max_calls: int,
    on_failure: str,
) -> SubAgent[AdaptiveDeps]:
    """Shared Agent → handoff validator → BoundedAgent → SubAgent packaging."""
    agent.instrument = False
    _handoff_validator(agent)
    bounded = _BoundedAgent(
        agent,
        task_id=task_id,
        node_id=node_id,
        parent_id=parent_id,
        depth=depth,
        role=role,
        semaphore=semaphore,
        parent_semaphore=parent_semaphore,
        retry_request_cost=retry_request_cost,
        retry_token_cost=retry_token_cost,
        metrics=metrics,
        emit=emit,
    )
    return SubAgent(
        bounded,
        name=name,
        usage_limits=_child_limits(policy, usage_role),
        timeout_seconds=timeout_seconds,
        max_calls=max_calls,
        on_failure=on_failure,
        contain_errors=True,
    )


def _research_agent(
    *,
    model: object,
    settings: ModelSettings,
    name: str,
    description: str,
    instructions: Callable[[RunContext[AdaptiveDeps]], str],
    workspace: AnalysisWorkspace,
    policy: AdaptivePolicy,
    source_mount: Path,
    skill_mount: Path,
    staging: Path | None,
    write_limit: int,
    wiki_mode: Literal["read-write", "read-only"] | None,
    extra_capabilities: list[Any],
    include_planning: bool,
) -> Agent[AdaptiveDeps, str]:
    """Build a research-role Agent with context stack, optional Planning, and CodeMode mounts."""
    capabilities: list[Any] = []
    if include_planning:
        capabilities.extend([_OrchestrationEvents(), Planning()])
    capabilities.extend(
        build_context_capabilities(
            model=model,
            target_tokens=policy.context_target_tokens,
            workspace=workspace,
        )
    )
    capabilities.extend(extra_capabilities)
    capabilities.append(
        CodeMode(
            max_retries=2,
            os_access=None,
            mount=_mounts(
                source_mount=source_mount,
                skill_mount=skill_mount,
                staging=staging,
                root=False,
                write_limit=write_limit,
                wiki_mode=wiki_mode,
            ),
        )
    )
    return Agent[AdaptiveDeps, str](
        cast(Any, model),
        name=name,
        description=description,
        deps_type=AdaptiveDeps,
        output_type=str,
        instructions=instructions,
        model_settings=settings,
        retries=2,
        toolsets=[_ReceiptToolset()],
        capabilities=capabilities,
    )


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
            "delegation are unavailable. "
            + _assignment_suffix(
                run_id=run_id,
                task_id=task_id,
                node_id=node_id,
                parent_id=parent_id,
                attempt=deps.attempt,
            )
        )

    agent = _research_agent(
        model=model,
        settings=settings,
        name=f"leaf_{index}",
        description="Investigate one self-contained source scope and publish a bounded receipt.",
        instructions=leaf_instructions,
        workspace=workspace,
        policy=policy,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=None,
        write_limit=0,
        wiki_mode=None,
        extra_capabilities=[],
        include_planning=False,
    )
    return _wrap_research_subagent(
        agent=agent,
        name=f"leaf_{index}",
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
        policy=policy,
        usage_role="leaf",
        timeout_seconds=policy.leaf_timeout_seconds,
        # One intentional run-boundary retry; tool_retries covers transient ModelRetry only.
        max_calls=2,
        on_failure=(
            "Leaf incomplete. Retry once within budget, else leave unresolved and continue."
        ),
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
    extra_capabilities: list[Any] = []
    if policy.dynamic_workflow and leaves:
        # DynamicWorkflow is intentionally one-layer only. Leaf agents have no
        # DynamicWorkflow capability, so nesting cannot be silently introduced.
        extra_capabilities.append(
            DynamicWorkflow(
                agents=[WorkflowAgent(cast(Any, agent)) for agent in leaf_agents],
                max_agent_calls=policy.domain_fanout,
                max_retries=2,
                forward_usage=False,
                sub_agent_usage_limits=_child_limits(policy, "leaf"),
            )
        )
    elif leaves:
        extra_capabilities.append(
            SubAgents(
                agents=leaves,
                agent_folders=None,
                inherit_tools=False,
                forward_usage=False,
                # max_calls=2 owns the intentional second attempt; keep tool retries thin.
                tool_retries=1,
                contain_errors=True,
            )
        )

    def domain_instructions(ctx: RunContext[AdaptiveDeps]) -> str:
        deps = _require_deps(ctx)
        return (
            "You are a Domain Researcher. Read /skill/references/domain-research.md in full before "
            "reading /source, then follow it. /source and /skill are read-only; /wiki is unavailable. "
            "A DynamicWorkflow cannot be nested. When two independent Leaf scopes are needed, fan "
            "them out in one CodeMode script with asyncio.gather over delegate_task (or the "
            "optional DynamicWorkflow); do not serialize independent Leaf work. Every "
            "delegate_task must be self-contained. "
            + _assignment_suffix(
                run_id=run_id,
                task_id=task_id,
                node_id=task_id,
                parent_id="root",
                attempt=deps.attempt,
            )
        )

    agent = _research_agent(
        model=model,
        settings=settings,
        name=f"domain_{index}",
        description="Research one bounded domain and reduce child receipts into one handoff.",
        instructions=domain_instructions,
        workspace=workspace,
        policy=policy,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=None,
        write_limit=write_limit,
        wiki_mode=None,
        extra_capabilities=extra_capabilities,
        include_planning=True,
    )
    return _wrap_research_subagent(
        agent=agent,
        name=f"domain_{index}",
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
        policy=policy,
        usage_role="domain",
        timeout_seconds=policy.child_timeout_seconds,
        max_calls=2,
        on_failure=(
            "Domain incomplete. Retry once within budget, else leave unresolved and fallback."
        ),
    )


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
            "delegate or write Wiki pages. Root remains the only writer and will decide how to "
            "repair. "
            + _assignment_suffix(
                run_id=run_id,
                task_id=task_id,
                node_id=task_id,
                parent_id="root",
                attempt=deps.attempt,
            )
        )

    agent = _research_agent(
        model=model,
        settings=settings,
        name=task_id,
        description=(
            "Independently review staged Wiki pages against source and the Producer Skill review "
            "checklist; publish a bounded defects receipt."
        ),
        instructions=reviewer_instructions,
        workspace=workspace,
        policy=policy,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=staging,
        write_limit=0,
        wiki_mode="read-only",
        extra_capabilities=[],
        include_planning=True,
    )
    return _wrap_research_subagent(
        agent=agent,
        name=task_id,
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
        policy=policy,
        usage_role="reviewer",
        timeout_seconds=policy.child_timeout_seconds,
        # One Reviewer roster slot; max_calls=2 allows the single intentional retry.
        max_calls=max_calls,
        on_failure=(
            "Review incomplete. Retry once within budget; do not claim Complete if still unresolved."
        ),
    )


__all__ = [
    "_BoundedAgent",
    "_OrchestrationEvents",
    "_make_domain",
    "_make_leaf",
    "_make_reviewer",
    "_mounts",
]
