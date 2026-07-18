"""Adaptive multi-agent orchestration."""

from __future__ import annotations

from .deps import AdaptiveDeps
from .orchestration import AdaptiveOrchestrator, build_root_agent
from .policy import AdaptivePolicy, HOST_PUBLISH_REVIEWER_NODE_ID, should_enable_adaptive
from .reviewer import ReviewDefectsSummary, run_host_wiki_reviewer

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
