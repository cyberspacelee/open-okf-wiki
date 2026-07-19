"""Staging acceptance: run-owned change assessment after Complete.

Mechanical validation still runs in the agent output_validator (framework edge
for ``ModelRetry``). This module owns the post-success change summary so
lifecycle does not assemble hashes / provenance comparisons itself.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ..models import RepositorySnapshot, WikiChangeSummary
from ..validation import page_hashes
from .fs import published_repository_views, summarize_wiki_changes


@dataclass(frozen=True, slots=True)
class StagingChangeAssessment:
    """run-owned Staging vs prior Published Wiki assessment."""

    summary: WikiChangeSummary
    new_hashes: dict[str, str]


def assess_staging_changes(
    *,
    staging: Path,
    pages: Sequence[str],
    old_hashes: dict[str, str],
    old_repositories: object | None,
    old_skill_digest: str | None,
    operation: str,
    repositories: tuple[RepositorySnapshot, ...],
    skill_digest: str,
) -> StagingChangeAssessment:
    """Compute page digests and the run-owned WikiChangeSummary."""
    new_hashes = page_hashes(staging, list(pages))
    summary = summarize_wiki_changes(
        old_hashes,
        new_hashes,
        provenance_changed=(
            operation == "generate"
            or old_repositories != published_repository_views(repositories)
            or old_skill_digest != skill_digest
        ),
    )
    return StagingChangeAssessment(summary=summary, new_hashes=new_hashes)


__all__ = [
    "StagingChangeAssessment",
    "assess_staging_changes",
]
