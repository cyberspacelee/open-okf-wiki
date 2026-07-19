"""Publication gate, status, finalize, and filesystem swap helpers.

Host-owned gate using pydantic-ai deferred shapes; not agent-inline deferred
tools (ADR 0018 shapes compatible).

Import the finalize entrypoint from the submodule (or ``okf_wiki.host``) so the
``finalize`` module is not shadowed on this package::

    from okf_wiki.host.publication.finalize import finalize, PublicationOutcome
    from okf_wiki.host import finalize, PublicationOutcome
"""

from __future__ import annotations

from .accept import StagingChangeAssessment, assess_staging_changes
from .finalize import PublicationContext, PublicationOutcome, StagingReviewer
from .fs import (
    PUBLICATION_METADATA_NAME,
    published_repository_views,
    stage_published_wiki_for_refresh,
    summarize_wiki_changes,
)
from .gate import (
    PublicationApprovalHandler,
    build_approve_results,
    build_deny_results,
    build_publish_approval_request,
    decision_from_results,
    resolve_publication_approval,
)
from .status import (
    publication_status,
    status_awaiting,
    status_declined,
    status_not_started,
    status_published,
    status_unchanged,
)

__all__ = [
    "PUBLICATION_METADATA_NAME",
    "PublicationApprovalHandler",
    "PublicationContext",
    "PublicationOutcome",
    "StagingChangeAssessment",
    "StagingReviewer",
    "assess_staging_changes",
    "build_approve_results",
    "build_deny_results",
    "build_publish_approval_request",
    "decision_from_results",
    "publication_status",
    "published_repository_views",
    "resolve_publication_approval",
    "stage_published_wiki_for_refresh",
    "status_awaiting",
    "status_declined",
    "status_not_started",
    "status_published",
    "status_unchanged",
    "summarize_wiki_changes",
]
