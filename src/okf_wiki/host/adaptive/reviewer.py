"""Host pre-publish Wiki Reviewer (publication gate), distinct from mid-run roster."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic_ai import ModelSettings

from ..analysis.workspace import AnalysisWorkspace, HandoffRef
from ..security import environment_secrets, redact_secrets
from .agents import _make_reviewer
from .deps import AdaptiveDeps, _AdaptiveMetrics
from .policy import HOST_PUBLISH_REVIEWER_NODE_ID, AdaptivePolicy

# Bounded defects fields exposed on the publication gate / lifecycle.
_MAX_DEFECT_FINDINGS = 16
_MAX_DEFECT_TEXT_CHARS = 500


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


@dataclass(slots=True)
class HostWikiReviewer:
    """Adaptive adapter for the publication :class:`StagingReviewer` protocol.

    Holds Host pre-publish wiring so lifecycle / finalize never see AdaptiveDeps,
    AdaptivePolicy, or metrics as publication kwargs.
    """

    model: object
    settings: ModelSettings
    source_mount: Path
    skill_mount: Path
    staging: Path
    workspace: AnalysisWorkspace
    run_id: str
    policy: AdaptivePolicy
    root_deps: AdaptiveDeps
    metrics: _AdaptiveMetrics

    async def review_staging(self, *, emit: Callable[..., None]) -> ReviewDefectsSummary:
        return await run_host_wiki_reviewer(
            model=self.model,
            settings=self.settings,
            source_mount=self.source_mount,
            skill_mount=self.skill_mount,
            staging=self.staging,
            workspace=self.workspace,
            run_id=self.run_id,
            policy=self.policy,
            root_deps=self.root_deps,
            metrics=self.metrics,
            emit=emit,
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


__all__ = [
    "HOST_PUBLISH_REVIEWER_NODE_ID",
    "HostWikiReviewer",
    "ReviewDefectsSummary",
    "run_host_wiki_reviewer",
]
