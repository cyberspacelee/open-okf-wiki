"""Host prepare: make a Wiki Run host-ready (mounts + frozen source/skill).

Owns Repository Snapshot materialization, source inventory, and Producer Skill
freeze so lifecycle can stay a thin consumer. Publication lock and refresh
staging remain lifecycle-owned.

These are the practical **host-readiness** entry points after a
:class:`~okf_wiki.host.models.WikiRunRequest` is assembled (YAML / Manual Retry /
programmatic). There is no separate ``validate_request_host_ready`` helper: call
:func:`prepare_mounts` for path/volume checks or :func:`prepare_run` for full
freeze. Error surfaces stay those of mounts/snapshots/skill validation.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING

from .errors import HostValidationError
from .models import WikiRunRequest
from .mounts import _prepare_mounts
from .skill import _validate_producer_skill
from .snapshots import (
    _materialize_repository_snapshot,
    _write_source_inventory,
)

if TYPE_CHECKING:
    from .analysis.workspace import AnalysisWorkspace

EmitFn = Callable[..., None]


@dataclass(frozen=True)
class PreparedMounts:
    """Host volumes resolved before snapshot/skill freeze (and before the publish lock)."""

    checkouts: tuple[Path, ...]
    skill_input: Path
    staging: Path
    publication: Path


@dataclass
class PreparedRun:
    """Frozen source + skill mounts ready for agent construction.

    Owns the temporary freeze directory until :meth:`close` (or context exit).
    """

    checkouts: tuple[Path, ...]
    skill_input: Path
    staging: Path
    publication: Path
    source_mount: Path
    skill: Path
    skill_digest: str
    sources: dict[str, Path]
    used_files: int
    used_bytes: int
    _temporary: tempfile.TemporaryDirectory[str] | None = field(
        default=None, repr=False, compare=False
    )

    def close(self) -> None:
        temporary = self._temporary
        self._temporary = None
        if temporary is not None:
            temporary.cleanup()

    def __enter__(self) -> PreparedRun:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


def prepare_mounts(request: WikiRunRequest) -> PreparedMounts:
    """Resolve checkouts, selected skill, staging, and publication paths."""
    checkouts, skill_input, staging, publication = _prepare_mounts(request)
    return PreparedMounts(
        checkouts=checkouts,
        skill_input=skill_input,
        staging=staging,
        publication=publication,
    )


def prepare_run(
    request: WikiRunRequest,
    *,
    emit: EmitFn,
    workspace: AnalysisWorkspace | None = None,
    mounts: PreparedMounts | None = None,
) -> PreparedRun:
    """Materialize snapshots, write inventory, freeze skill; emit Host events.

    When ``mounts`` is omitted, calls :func:`prepare_mounts` first. Callers that
    already acquired the publication lock after mounts should pass ``mounts`` so
    freeze stays under that lock without re-resolving volumes.
    """
    prepared_mounts = mounts if mounts is not None else prepare_mounts(request)
    temporary = tempfile.TemporaryDirectory(prefix="okf-wiki-run-")
    try:
        return _freeze_prepared_run(
            request,
            mounts=prepared_mounts,
            temporary=temporary,
            emit=emit,
            workspace=workspace,
        )
    except BaseException:
        temporary.cleanup()
        raise


def _freeze_prepared_run(
    request: WikiRunRequest,
    *,
    mounts: PreparedMounts,
    temporary: tempfile.TemporaryDirectory[str],
    emit: EmitFn,
    workspace: AnalysisWorkspace | None,
) -> PreparedRun:
    root = Path(temporary.name)
    source_mount = root / "source"
    skill = root / "skill"
    sources: dict[str, Path] = {}
    used_files = 0
    used_bytes = 0
    if len(request.repositories) > 1:
        source_mount.mkdir()
    for repository, checkout in zip(request.repositories, mounts.checkouts, strict=True):
        target = source_mount if len(request.repositories) == 1 else source_mount / repository.id
        used_files, used_bytes = _materialize_repository_snapshot(
            checkout,
            repository.revision,
            target,
            request.limits,
            ignore=repository.effective_source_ignores(),
            used_files=used_files,
            used_bytes=used_bytes,
        )
        sources[repository.id] = target
    try:
        _write_source_inventory(source_mount, sources)
    except Exception as inventory_error:
        # Inventory is an optional accelerator; never change Snapshot membership.
        emit(
            "source_inventory_skipped",
            {
                "reason_code": "generation_failed",
                "error_type": type(inventory_error).__name__,
            },
        )
    if workspace is not None:
        workspace.configure_sources(
            {
                repository.id: (repository.revision, sources[repository.id])
                for repository in request.repositories
            }
        )
    emit("snapshots_frozen")
    shutil.copytree(mounts.skill_input, skill, symlinks=True)
    _, skill_digest = _validate_producer_skill(skill)
    if skill_digest != request.skill.digest:
        raise HostValidationError(
            "Selected Skill Version changed while it was being frozen: "
            f"expected {request.skill.digest}, found {skill_digest}"
        )
    emit("skill_frozen")
    return PreparedRun(
        checkouts=mounts.checkouts,
        skill_input=mounts.skill_input,
        staging=mounts.staging,
        publication=mounts.publication,
        source_mount=source_mount,
        skill=skill,
        skill_digest=skill_digest,
        sources=sources,
        used_files=used_files,
        used_bytes=used_bytes,
        _temporary=temporary,
    )


__all__ = [
    "PreparedMounts",
    "PreparedRun",
    "prepare_mounts",
    "prepare_run",
]
