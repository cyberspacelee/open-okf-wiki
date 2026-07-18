"""Publication finalize: pre-publish review → Host gate → filesystem publish.

Owns the post-Complete publication decision so lifecycle stays thin:

  finalize(...) -> PublicationOutcome

Steps when the change summary requires publication:

1. Optional Host Wiki Reviewer (or accept precomputed defects)
2. HITL / YOLO via :func:`resolve_publication_approval`
3. On approve: emit ``publication_started``, filesystem publish, emit
   ``publication_succeeded``
4. Map decision → publication status dict + terminal Wiki Run Record status

Wiki Visualization remains lifecycle-owned after a successful publish (ADR 0016).

Host-owned gate using pydantic-ai deferred shapes; not agent-inline deferred
tools (ADR 0018 shapes compatible).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic_ai import ModelSettings

from ..adaptive.deps import AdaptiveDeps
from ..adaptive.policy import AdaptivePolicy
from ..adaptive.reviewer import ReviewDefectsSummary, run_host_wiki_reviewer
from ..models import (
    RepositorySnapshot,
    WikiManifest,
    WikiRunLimits,
    WikiRunRecordStatus,
)
from .fs import _publish_wiki, _published_repositories
from .gate import PublicationApprovalHandler, PublicationDecision, resolve_publication_approval
from .status import status_awaiting, status_declined, status_published, status_unchanged

if TYPE_CHECKING:
    from ..analysis.workspace import AnalysisWorkspace

EmitFn = Callable[..., None]


@dataclass(frozen=True)
class PublicationOutcome:
    """Unified result of Host publication finalize.

    ``published`` is True only when the filesystem publish path ran successfully.
    Lifecycle uses that flag to run optional post-publish visualization.
    """

    terminal_status: WikiRunRecordStatus
    publication_status: dict[str, object]
    published: bool
    reviewer_defects: ReviewDefectsSummary | None = None
    decision: PublicationDecision | None = None


async def finalize(
    *,
    publication_changed: bool,
    auto_approve: bool,
    handler: PublicationApprovalHandler | None,
    emit: EmitFn,
    sources: Mapping[str, Path],
    staging: Path,
    publication: Path,
    manifest: WikiManifest,
    repositories: tuple[RepositorySnapshot, ...],
    skill_digest: str,
    model_name: str | None,
    limits: WikiRunLimits,
    enable_reviewer: bool = False,
    reviewer_defects: ReviewDefectsSummary | None = None,
    review_model: object | None = None,
    review_settings: ModelSettings | None = None,
    source_mount: Path | None = None,
    skill_mount: Path | None = None,
    workspace: AnalysisWorkspace | None = None,
    run_id: str = "",
    policy: AdaptivePolicy | None = None,
    root_deps: AdaptiveDeps | None = None,
    metrics: Any | None = None,
) -> PublicationOutcome:
    """Run pre-publish review, Host approval gate, and optional filesystem publish.

    Zero product behavior change relative to the previous lifecycle-inlined chain:

    * ``publication_changed=False`` → unchanged / complete (no gate, no review)
    * YOLO / ``auto_approve`` → approve without calling the handler
    * handler approve / deny / None → published / declined / awaiting
    * Reviewer runs only when ``enable_reviewer`` and no precomputed defects
    """
    if not publication_changed:
        return PublicationOutcome(
            terminal_status="complete",
            publication_status=status_unchanged(),
            published=False,
            reviewer_defects=None,
            decision=None,
        )

    defects = reviewer_defects
    if enable_reviewer and defects is None:
        defects = await _run_reviewer(
            review_model=review_model,
            review_settings=review_settings,
            source_mount=source_mount,
            skill_mount=skill_mount,
            staging=staging,
            workspace=workspace,
            run_id=run_id,
            policy=policy,
            root_deps=root_deps,
            metrics=metrics,
            emit=emit,
        )

    defects_args: dict[str, object] | None = None if defects is None else defects.as_gate_args()
    decision, _requests, _results = await resolve_publication_approval(
        auto_approve=auto_approve,
        handler=handler,
        defects=defects_args,
    )
    review_fragment = None if defects is None else defects.as_record_fragment()

    if decision == "approved":
        if not model_name:
            raise RuntimeError("Final model response did not identify its model")
        emit("publication_started")
        _publish_wiki(
            sources,
            staging,
            publication,
            manifest,
            repositories=_published_repositories(repositories),
            skill_digest=skill_digest,
            model_name=model_name,
            limits=limits,
        )
        emit("publication_succeeded")
        return PublicationOutcome(
            terminal_status="complete",
            publication_status=status_published(reviewer=review_fragment),
            published=True,
            reviewer_defects=defects,
            decision=decision,
        )

    if decision == "denied":
        # Operator declined: do not publish. Staging remains for further Session
        # work; Published Wiki is untouched.
        return PublicationOutcome(
            terminal_status="publication_declined",
            publication_status=status_declined(reviewer=review_fragment),
            published=False,
            reviewer_defects=defects,
            decision=decision,
        )

    return PublicationOutcome(
        terminal_status="awaiting_publication",
        publication_status=status_awaiting(reviewer=review_fragment),
        published=False,
        reviewer_defects=defects,
        decision=decision,
    )


async def _run_reviewer(
    *,
    review_model: object | None,
    review_settings: ModelSettings | None,
    source_mount: Path | None,
    skill_mount: Path | None,
    staging: Path,
    workspace: AnalysisWorkspace | None,
    run_id: str,
    policy: AdaptivePolicy | None,
    root_deps: AdaptiveDeps | None,
    metrics: Any | None,
    emit: EmitFn,
) -> ReviewDefectsSummary:
    """Invoke Host Wiki Reviewer; fail closed only on missing Host wiring."""
    if (
        review_model is None
        or review_settings is None
        or source_mount is None
        or skill_mount is None
        or workspace is None
        or policy is None
        or root_deps is None
        or metrics is None
    ):
        raise RuntimeError("Host Wiki Reviewer is enabled but finalize is missing reviewer inputs")
    return await run_host_wiki_reviewer(
        model=review_model,
        settings=review_settings,
        source_mount=source_mount,
        skill_mount=skill_mount,
        staging=staging,
        workspace=workspace,
        run_id=run_id,
        policy=policy,
        root_deps=root_deps,
        metrics=metrics,
        emit=emit,
    )


__all__ = [
    "PublicationOutcome",
    "finalize",
]
