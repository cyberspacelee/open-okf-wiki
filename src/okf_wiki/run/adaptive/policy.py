"""Run Boundary-enforced adaptive policy and enablement trigger."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal


Role = Literal["root", "domain", "leaf", "reviewer"]
NodeState = Literal["pending", "running", "complete", "partial", "failed", "cancelled"]

# Run Boundary pre-publish Reviewer node (distinct from adaptive mid-run roster ``reviewer``).
RUN_PUBLISH_REVIEWER_NODE_ID = "publish-reviewer"


@dataclass(frozen=True, slots=True)
class AdaptivePolicy:
    """Run Boundary-enforced limits for one bounded Root → Domain → Leaf tree."""

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


__all__ = [
    "AdaptivePolicy",
    "RUN_PUBLISH_REVIEWER_NODE_ID",
    "NodeState",
    "Role",
    "should_enable_adaptive",
]
