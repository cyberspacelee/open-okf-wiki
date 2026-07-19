"""Adaptive Root agent assembly and orchestrator state.

This module owns Root capability assembly only. Policy, deps, receipts, child
agent factories, and the host pre-publish reviewer live in sibling modules.

Public deep entry: :func:`build_root_assembly` → :class:`RootAssembly`.
:func:`build_root_agent` remains a thin compatibility wrapper for tests.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, cast

from pydantic_ai import Agent, ModelRetry, ModelSettings, UsageLimits
from pydantic_ai_harness import CodeMode
from pydantic_ai_harness.planning import Planning
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from ..analysis.workspace import AnalysisWorkspace
from ..context import build_context_capabilities
from .agents import (
    _OrchestrationEvents,
    _make_domain,
    _make_reviewer,
    _mounts,
)
from .deps import AdaptiveDeps, _AdaptiveMetrics
from .policy import AdaptivePolicy, should_enable_adaptive
from .receipts import _ReceiptToolset
from .reviewer import (
    HOST_PUBLISH_REVIEWER_NODE_ID,
    HostWikiReviewer,
    ReviewDefectsSummary,
    run_host_wiki_reviewer,
)


class CriticalBranchesIncomplete(Exception):
    """Domain signal: critical research branches remain unresolved.

    Lifecycle maps this to framework ``ModelRetry`` at the agent edge.
    """


@dataclass(slots=True)
class AdaptiveOrchestrator:
    """Built Root capability set plus host state for one Wiki Run."""

    policy: AdaptivePolicy
    root_deps: AdaptiveDeps
    root_usage_limits: UsageLimits
    metrics: _AdaptiveMetrics

    def validate_root_completion(self) -> None:
        """Framework-edge helper: raises ``ModelRetry`` for incomplete critical branches."""
        if self.metrics.unresolved_failures():
            raise ModelRetry(
                "One or more critical research branches are incomplete. Resolve them within the "
                "bounded retry or direct-fallback budget; otherwise fail this Wiki Run. Do not "
                "claim Complete or convert an internal branch failure into NeedsInput."
            )

    def validate_completion(self) -> None:
        """Host-facing completion gate (no framework types)."""
        if self.metrics.unresolved_failures():
            raise CriticalBranchesIncomplete(
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


@dataclass(slots=True)
class RootAssembly:
    """Deep Host handle for one assembled Root + recursive delegation tree."""

    agent: Agent[Any, Any]
    orchestrator: AdaptiveOrchestrator
    source_mount: Path
    skill_mount: Path
    staging: Path
    workspace: AnalysisWorkspace
    run_id: str
    model: object
    settings: ModelSettings
    reviewer_model: object | None
    reviewer_settings: ModelSettings | None

    @property
    def policy(self) -> AdaptivePolicy:
        return self.orchestrator.policy

    @property
    def root_deps(self) -> AdaptiveDeps:
        return self.orchestrator.root_deps

    @property
    def root_usage_limits(self) -> UsageLimits:
        return self.orchestrator.root_usage_limits

    @property
    def metrics(self) -> _AdaptiveMetrics:
        return self.orchestrator.metrics

    def validate_completion(self) -> None:
        self.orchestrator.validate_completion()

    def event_payload(self) -> dict[str, object]:
        return self.orchestrator.event_payload()

    def staging_reviewer(self) -> HostWikiReviewer | None:
        """Host pre-publish Wiki Reviewer adapter, or None when disabled."""
        if not self.policy.enable_reviewer:
            return None
        review_model = self.model if self.reviewer_model is None else self.reviewer_model
        review_settings = (
            self.settings if self.reviewer_settings is None else self.reviewer_settings
        )
        return HostWikiReviewer(
            model=review_model,
            settings=review_settings,
            source_mount=self.source_mount,
            skill_mount=self.skill_mount,
            staging=self.staging,
            workspace=self.workspace,
            run_id=self.run_id,
            policy=self.policy,
            root_deps=self.root_deps,
            metrics=self.metrics,
        )

    def topology_snapshot(self) -> dict[str, object]:
        """Host-facing topology summary for tests (no Harness capability walk)."""
        return {
            "adaptive_enabled": self.policy.enabled,
            "max_depth": self.policy.max_depth,
            "root_fanout": self.policy.root_fanout,
            "domain_fanout": self.policy.domain_fanout,
            "child_concurrency": self.policy.child_concurrency,
            "enable_reviewer": self.policy.enable_reviewer,
            "dynamic_workflow": self.policy.dynamic_workflow,
            "has_publish_reviewer": self.staging_reviewer() is not None,
        }

    def root_subagent_names(self) -> list[str]:
        """Names of Root-level SubAgents roster entries (empty when adaptive is off)."""
        from pydantic_ai_harness.subagents import SubAgents

        names: list[str] = []
        for capability in self.agent.root_capability.capabilities:
            if isinstance(capability, SubAgents):
                for entry in capability.agents:
                    names.append(str(getattr(entry, "name", entry)))
        return names


def build_root_assembly(
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
) -> RootAssembly:
    """Assemble Root agent + 递归委派树; hide SubAgents/DynamicWorkflow wiring."""
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
    orchestrator = AdaptiveOrchestrator(policy, root_deps, root_usage, metrics)
    return RootAssembly(
        agent=root,
        orchestrator=orchestrator,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=staging,
        workspace=workspace,
        run_id=run_id,
        model=model,
        settings=settings,
        reviewer_model=reviewer_model,
        reviewer_settings=reviewer_settings,
    )


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
    """Compatibility wrapper: return ``(agent, orchestrator)`` from :func:`build_root_assembly`."""
    assembly = build_root_assembly(
        model=model,
        settings=settings,
        output_type=output_type,
        instructions=instructions,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=staging,
        workspace=workspace,
        run_id=run_id,
        limits=limits,
        adaptive=adaptive,
        write_limit=write_limit,
        emit=emit,
        reviewer_model=reviewer_model,
        reviewer_settings=reviewer_settings,
    )
    return assembly.agent, assembly.orchestrator


# Backward-compatible re-exports for call sites that import from this module.
__all__ = [
    "AdaptiveDeps",
    "AdaptiveOrchestrator",
    "AdaptivePolicy",
    "CriticalBranchesIncomplete",
    "HOST_PUBLISH_REVIEWER_NODE_ID",
    "ReviewDefectsSummary",
    "RootAssembly",
    "build_root_agent",
    "build_root_assembly",
    "run_host_wiki_reviewer",
    "should_enable_adaptive",
]
