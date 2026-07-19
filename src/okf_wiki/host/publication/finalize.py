"""Publication finalize: pre-publish review → Host gate → filesystem publish.

Owns the post-Complete publication decision so lifecycle stays thin:

  finalize(PublicationContext) -> PublicationOutcome

Steps when the change summary requires publication:

1. Optional Host Wiki Reviewer via :class:`StagingReviewer` (or precomputed defects)
2. HITL / YOLO via :func:`resolve_publication_approval`
3. On approve: emit ``publication_started``, filesystem publish, emit
   ``publication_succeeded``
4. Map decision → publication status dict + terminal Wiki Run Record status

Wiki Visualization remains lifecycle-owned after a successful publish (ADR 0016).

Host-owned gate using pydantic-ai deferred shapes; not agent-inline deferred
tools (ADR 0018 shapes compatible).

Adaptive / Harness types stay behind :class:`StagingReviewer` adapters — this
module does not import AdaptiveDeps, AdaptivePolicy, or metrics.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..adaptive.reviewer import ReviewDefectsSummary
from ..models import (
    RepositorySnapshot,
    WikiManifest,
    WikiRunLimits,
    WikiRunRecordStatus,
)
from .fs import _publish_wiki, published_repository_views
from .gate import PublicationApprovalHandler, PublicationDecision, resolve_publication_approval
from .status import status_awaiting, status_declined, status_published, status_unchanged

EmitFn = Callable[..., None]


class StagingReviewer(Protocol):
    """Host pre-publish Wiki Reviewer seam (protocol in publication).

    Adaptive implements this with :class:`~okf_wiki.host.adaptive.reviewer.HostWikiReviewer`.
    Tests inject fakes without AdaptiveDeps / policy wiring.
    """

    async def review_staging(self, *, emit: EmitFn) -> ReviewDefectsSummary: ...


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


@dataclass(frozen=True, slots=True)
class PublicationContext:
    """Inputs for one Host publication finalize decision.

    ``reviewer`` runs only when publication is required and ``reviewer_defects``
    is not already supplied (precomputed / test path).
    """

    publication_changed: bool
    auto_approve: bool
    handler: PublicationApprovalHandler | None
    emit: EmitFn
    sources: Mapping[str, Path]
    staging: Path
    publication: Path
    manifest: WikiManifest
    repositories: tuple[RepositorySnapshot, ...]
    skill_digest: str
    model_name: str | None
    limits: WikiRunLimits
    reviewer: StagingReviewer | None = None
    reviewer_defects: ReviewDefectsSummary | None = None


async def finalize(context: PublicationContext) -> PublicationOutcome:
    """Run pre-publish review, Host approval gate, and optional filesystem publish.

    * ``publication_changed=False`` → unchanged / complete (no gate, no review)
    * YOLO / ``auto_approve`` → approve without calling the handler
    * handler approve / deny / None → published / declined / awaiting
    * Reviewer runs only when ``reviewer`` is set and no precomputed defects
    """
    if not context.publication_changed:
        return PublicationOutcome(
            terminal_status="complete",
            publication_status=status_unchanged(),
            published=False,
            reviewer_defects=None,
            decision=None,
        )

    defects = context.reviewer_defects
    if context.reviewer is not None and defects is None:
        defects = await context.reviewer.review_staging(emit=context.emit)

    defects_args: dict[str, object] | None = None if defects is None else defects.as_gate_args()
    decision, _requests, _results = await resolve_publication_approval(
        auto_approve=context.auto_approve,
        handler=context.handler,
        defects=defects_args,
    )
    review_fragment = None if defects is None else defects.as_record_fragment()

    if decision == "approved":
        if not context.model_name:
            raise RuntimeError("Final model response did not identify its model")
        context.emit("publication_started")
        _publish_wiki(
            context.sources,
            context.staging,
            context.publication,
            context.manifest,
            repositories=published_repository_views(context.repositories),
            skill_digest=context.skill_digest,
            model_name=context.model_name,
            limits=context.limits,
        )
        context.emit("publication_succeeded")
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


__all__ = [
    "PublicationContext",
    "PublicationOutcome",
    "StagingReviewer",
    "finalize",
]
