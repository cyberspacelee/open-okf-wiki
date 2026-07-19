"""Host readiness: volumes, publication lock, Refresh stage-in, Snapshot freeze.

One deep entry for "make this Wiki Run host-ready" so lifecycle does not
re-encode the stage machine (mounts → lock → refresh → prepare_run).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING

from .models import WikiRunRequest
from .mounts import acquire_publication_lock, release_publication_lock
from .prepare import PreparedMounts, PreparedRun, prepare_mounts, prepare_run
from .publication.fs import stage_published_wiki_for_refresh

if TYPE_CHECKING:
    from .analysis.workspace import AnalysisWorkspace

EmitFn = Callable[..., None]


@dataclass
class HostReadiness:
    """Locked, frozen Host environment ready for the Semantic Workflow agent.

    Owns the publication lock and temporary freeze directory until :meth:`close`.
    """

    mounts: PreparedMounts
    prepared: PreparedRun
    publication_lock: Path
    old_hashes: dict[str, str] = field(default_factory=dict)
    old_repositories: object | None = None
    old_skill_digest: str | None = None
    _closed: bool = field(default=False, repr=False, compare=False)

    @property
    def publication(self) -> Path:
        return self.prepared.publication

    @property
    def staging(self) -> Path:
        return self.prepared.staging

    @property
    def skill_input(self) -> Path:
        return self.prepared.skill_input

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.prepared.close()
        finally:
            release_publication_lock(self.publication_lock)

    def __enter__(self) -> HostReadiness:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


def open_host_readiness(
    request: WikiRunRequest,
    *,
    emit: EmitFn,
    workspace: AnalysisWorkspace | None = None,
) -> HostReadiness:
    """Resolve volumes, acquire publication lock, optional Refresh stage-in, freeze.

    Caller must :meth:`HostReadiness.close` (or use as a context manager).
    """
    mounts = prepare_mounts(request)
    publication_lock = acquire_publication_lock(mounts.publication)
    try:
        old_hashes: dict[str, str] = {}
        old_repositories: object | None = None
        old_skill_digest: str | None = None
        if request.operation == "refresh":
            old_hashes, old_repositories, old_skill_digest = stage_published_wiki_for_refresh(
                mounts.publication, mounts.staging, request.limits
            )
        prepared = prepare_run(
            request,
            emit=emit,
            workspace=workspace,
            mounts=mounts,
        )
    except BaseException:
        release_publication_lock(publication_lock)
        raise
    return HostReadiness(
        mounts=mounts,
        prepared=prepared,
        publication_lock=publication_lock,
        old_hashes=old_hashes,
        old_repositories=old_repositories,
        old_skill_digest=old_skill_digest,
    )


__all__ = [
    "HostReadiness",
    "open_host_readiness",
]
