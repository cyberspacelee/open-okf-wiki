"""Stage, copy, publish, swap, and publication metadata for Wiki Run."""

from __future__ import annotations

import json
import os
import shutil
import stat
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..errors import HostValidationError, PublicationError, operator_error
from ..models import (
    IgnorePattern,
    PagePath,
    RepositoryId,
    RepositorySnapshot,
    SkillDigest,
    WikiChangeSummary,
    WikiManifest,
    WikiRunLimits,
)
from ..mounts import (
    _check_directory_path,
    _create_directory_path,
    _directory_identity,
    _ensure_release_root,
    _ensure_same_volume_for_publication,
    _legacy_symlink_publication_error,
    _path_is_symlink_or_reparse,
)
from ..validation import (
    VISUALIZATION_DIR_NAME,
    _content_digest,
    _hashes,
    _is_canonical_page_path,
    _validate_wiki,
)


PUBLICATION_METADATA_NAME = ".okf-wiki.json"


class _PublishedPage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: PagePath
    sha256: SkillDigest


class _PublishedRepository(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: RepositoryId
    revision: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            to_lower=True,
            pattern=r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
        ),
    ]
    ignore: tuple[IgnorePattern, ...] = ()
    apply_default_source_ignores: bool = True
    effective_ignore: tuple[IgnorePattern, ...] = ()


def published_repository_views(
    repositories: tuple[RepositorySnapshot, ...],
) -> tuple[_PublishedRepository, ...]:
    """Project Repository Snapshots into Host publication provenance views."""
    return tuple(
        _PublishedRepository(
            id=repository.id,
            revision=repository.revision,
            ignore=repository.ignore,
            apply_default_source_ignores=repository.apply_default_source_ignores,
            effective_ignore=tuple(repository.effective_source_ignores()),
        )
        for repository in sorted(repositories, key=lambda repository: repository.id)
    )


# Private alias kept for in-package call sites during the deepening transition.
_published_repositories = published_repository_views


class _PublicationMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    repositories: tuple[_PublishedRepository, ...] = Field(min_length=1)
    skill_digest: SkillDigest
    model: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    generated_at: datetime
    pages: list[_PublishedPage] = Field(min_length=1)
    content_digest: SkillDigest


def stage_published_wiki_for_refresh(
    publication: Path, staging: Path, limits: WikiRunLimits
) -> tuple[dict[str, str], tuple[_PublishedRepository, ...], str]:
    """Load a Host-owned real-directory Published Wiki into empty Staging for Refresh."""
    if publication.is_symlink() or _path_is_symlink_or_reparse(publication):
        raise _legacy_symlink_publication_error(publication, for_refresh=True)
    if not publication.is_dir():
        raise HostValidationError(
            "Refresh requires an existing producer-managed Published Wiki "
            f"(regular directory with publication metadata) at {publication}"
        )
    try:
        release = publication.resolve(strict=True)
    except OSError as error:
        raise operator_error(
            "Refresh Published Wiki is not readable", error, error_cls=HostValidationError
        ) from error
    if not release.is_dir() or release.is_symlink():
        raise HostValidationError("Refresh requires an existing producer-managed Published Wiki")

    metadata_path = release / PUBLICATION_METADATA_NAME
    if metadata_path.is_symlink() or not metadata_path.is_file():
        raise HostValidationError(
            "Refresh Published Wiki metadata is missing or not a regular file"
        )
    try:
        metadata = _PublicationMetadata.model_validate_json(metadata_path.read_bytes())
    except Exception as error:
        raise operator_error(
            "Refresh Published Wiki metadata is invalid", error, error_cls=HostValidationError
        ) from error

    page_hashes: dict[str, str] = {}
    for page in metadata.pages:
        if not _is_canonical_page_path(page.path):
            raise HostValidationError(
                f"Refresh Published Wiki page path is not canonical: {page.path!r}"
            )
        if page.path in page_hashes:
            raise HostValidationError(
                f"Refresh Published Wiki metadata has duplicate page: {page.path}"
            )
        page_hashes[page.path] = page.sha256
    if len(page_hashes) > limits.wiki_entries_limit:
        raise HostValidationError("Refresh Published Wiki exceeds the configured entry count limit")
    if _content_digest(page_hashes) != metadata.content_digest:
        raise HostValidationError(
            "Refresh Published Wiki content digest does not match its page manifest"
        )

    actual_files: set[str] = set()
    entries = 0
    total_bytes = 0
    stack = [(release, PurePosixPath())]
    while stack:
        directory, prefix = stack.pop()
        for entry in os.scandir(directory):
            relative = prefix / entry.name
            relative_path = relative.as_posix()
            # Skip Host-owned Wiki Visualization artifacts under the reserved viz/ directory.
            if not prefix.parts and entry.name == VISUALIZATION_DIR_NAME:
                continue
            if relative_path != PUBLICATION_METADATA_NAME:
                entries += 1
                if entries > limits.wiki_entries_limit:
                    raise HostValidationError(
                        "Refresh Published Wiki exceeds the configured entry count limit"
                    )
            if entry.is_symlink():
                raise HostValidationError(
                    f"Refresh Published Wiki contains a symlink: {relative_path}"
                )
            if entry.is_dir(follow_symlinks=False):
                stack.append((Path(entry.path), relative))
            elif entry.is_file(follow_symlinks=False):
                actual_files.add(relative_path)
                if relative_path in page_hashes:
                    size = entry.stat(follow_symlinks=False).st_size
                    if size > limits.wiki_file_bytes_limit:
                        raise HostValidationError(
                            f"Refresh Published Wiki page exceeds the configured byte limit: "
                            f"{relative_path}"
                        )
                    total_bytes += size
                    if total_bytes > limits.wiki_total_bytes_limit:
                        raise HostValidationError(
                            "Refresh Published Wiki exceeds the configured total byte limit"
                        )
            else:
                raise HostValidationError(
                    f"Refresh Published Wiki contains an unsupported artifact: {relative_path}"
                )
    expected_files = set(page_hashes) | {PUBLICATION_METADATA_NAME}
    if actual_files != expected_files:
        raise HostValidationError("Refresh Published Wiki files do not match its page manifest")

    for page in page_hashes:
        source = release.joinpath(*PurePosixPath(page).parts)
        destination = staging.joinpath(*PurePosixPath(page).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        _copy_regular_file_no_follow(
            source,
            destination,
            max_bytes=limits.wiki_file_bytes_limit,
            label=f"Refresh Published Wiki page {page}",
        )
    if _hashes(staging, list(page_hashes)) != page_hashes:
        raise HostValidationError(
            "Refresh Published Wiki page hashes do not match its metadata after copy"
        )
    return page_hashes, metadata.repositories, metadata.skill_digest


# Private alias kept for in-package / test call sites during the deepening transition.
_stage_published_wiki = stage_published_wiki_for_refresh


def _copy_regular_file_no_follow(
    source: Path, destination: Path, *, max_bytes: int, label: str
) -> int:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError as error:
        raise HostValidationError(f"{label} is not a readable regular file") from error
    destination_fd: int | None = None
    try:
        opened = os.fstat(source_fd)
        current = os.lstat(source)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
            current.st_dev,
            current.st_ino,
        ):
            raise HostValidationError(f"{label} is not a readable regular file")
        if opened.st_size > max_bytes:
            raise HostValidationError(f"{label} exceeds the configured byte limit")
        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o644,
        )
        copied = 0
        while chunk := os.read(source_fd, min(1024 * 1024, max_bytes - copied + 1)):
            copied += len(chunk)
            if copied > max_bytes:
                raise HostValidationError(f"{label} exceeds the configured byte limit")
            view = memoryview(chunk)
            while view:
                view = view[os.write(destination_fd, view) :]
    except Exception:
        if destination_fd is not None:
            os.close(destination_fd)
            destination_fd = None
            destination.unlink(missing_ok=True)
        raise
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
    return copied


def _copy_wiki_pages(
    source: Path,
    destination: Path,
    manifest: WikiManifest,
    limits: WikiRunLimits,
) -> None:
    total_bytes = 0
    for page in manifest.pages:
        relative = PurePosixPath(page)
        target = destination.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        copied = _copy_regular_file_no_follow(
            source.joinpath(*relative.parts),
            target,
            max_bytes=min(
                limits.wiki_file_bytes_limit,
                limits.wiki_total_bytes_limit - total_bytes,
            ),
            label=f"Staging Wiki page {page}",
        )
        total_bytes += copied


def summarize_wiki_changes(
    old: dict[str, str], new: dict[str, str], *, provenance_changed: bool
) -> WikiChangeSummary:
    """Host-owned Staging vs prior Published Wiki change summary."""
    old_paths, new_paths = set(old), set(new)
    shared = old_paths & new_paths
    added = sorted(new_paths - old_paths)
    changed = sorted(path for path in shared if old[path] != new[path])
    removed = sorted(old_paths - new_paths)
    unchanged = sorted(path for path in shared if old[path] == new[path])
    content_changed = bool(added or changed or removed)
    return WikiChangeSummary(
        added=added,
        changed=changed,
        removed=removed,
        unchanged=unchanged,
        content_changed=content_changed,
        publication_changed=content_changed or provenance_changed,
    )


# Private alias kept for in-package call sites during the deepening transition.
_summarize_changes = summarize_wiki_changes


def _write_publication_metadata(path: Path, metadata: _PublicationMetadata) -> None:
    encoded = (
        json.dumps(metadata.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o644)
        try:
            view = memoryview(encoded)
            while view:
                view = view[os.write(descriptor, view) :]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if os.path.lexists(path):
            raise PublicationError("Published Wiki metadata already exists in the release tree")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class _PublicationSwapUnrecoverable(PublicationError):
    """Mid-swap failure where aside/release artifacts must be left for the operator."""


def _swap_published_directory(
    destination: Path,
    new_release: Path,
    *,
    release_id: str,
) -> None:
    """Expose a complete release at the stable Published Wiki path via directory rename.

    Mid-swap recovery: if the previous tree was moved aside and the new tree cannot be
    installed, best-effort rename the previous tree back. Never leave a partial tree at
    the stable name; if restore fails, leave recoverable aside/release paths and raise.
    """
    if destination.is_symlink() or (
        os.path.lexists(destination) and _path_is_symlink_or_reparse(destination)
    ):
        raise _legacy_symlink_publication_error(destination)
    if os.path.lexists(destination) and not destination.is_dir():
        raise PublicationError(
            "Published Wiki path must be absent or a regular directory "
            f"(found a non-directory at {destination})"
        )

    aside: Path | None = None
    installed = False
    try:
        if os.path.lexists(destination):
            aside = destination.parent / f".{destination.name}.aside.{release_id}"
            if os.path.lexists(aside):
                raise OSError(f"Published Wiki aside path already exists: {aside}")
            os.rename(destination, aside)
        os.rename(new_release, destination)
        installed = True
    except Exception as error:
        if aside is not None and not os.path.lexists(destination):
            try:
                os.rename(aside, destination)
                aside = None
            except OSError as restore_error:
                raise _PublicationSwapUnrecoverable(
                    "Publication swap failed and the previous Published Wiki could not be "
                    f"restored. Recoverable paths: previous tree={aside}; "
                    f"new release={new_release if new_release.exists() else 'missing'}; "
                    f"stable path={destination}. Swap error: {error}; restore error: "
                    f"{restore_error}."
                ) from restore_error
        raise
    finally:
        if installed and aside is not None:
            shutil.rmtree(aside, ignore_errors=True)


def _cleanup_release_tree(releases: Path, *, keep: frozenset[str] = frozenset()) -> None:
    """Best-effort delete superseded release directories after a successful swap."""
    if not releases.is_dir() or releases.is_symlink():
        return
    try:
        entries = list(releases.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.name in keep:
            continue
        if entry.is_symlink():
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)


def _publish_wiki(
    sources: Mapping[str, Path],
    staging: Path,
    destination: Path,
    manifest: WikiManifest,
    *,
    repositories: tuple[_PublishedRepository, ...],
    skill_digest: str,
    model_name: str,
    limits: WikiRunLimits,
) -> None:
    """Materialize a validated release then expose it via same-volume directory rename."""
    _check_directory_path(destination.parent, "Published Wiki parent")
    _create_directory_path(destination.parent, "Published Wiki parent")
    if destination.is_symlink() or (
        os.path.lexists(destination) and _path_is_symlink_or_reparse(destination)
    ):
        raise _legacy_symlink_publication_error(destination)
    if os.path.lexists(destination) and not destination.is_dir():
        raise PublicationError(
            "Published Wiki path must be absent or a regular directory "
            f"(found a non-directory at {destination})"
        )

    releases = destination.parent / f".{destination.name}.releases"
    parent_before = _directory_identity(destination.parent)
    if parent_before is None:
        raise PublicationError("Published Wiki parent must be a regular directory")
    _ensure_release_root(releases)
    _ensure_same_volume_for_publication(destination, releases)
    releases_before = _directory_identity(releases)
    if releases_before is None:
        raise PublicationError("Published Wiki release directory must be a regular directory")

    release_id = uuid.uuid4().hex
    final_release = releases / release_id
    final_release_owned = False
    try:
        try:
            os.mkdir(final_release)
        except FileExistsError as error:
            raise OSError(f"Published Wiki release already exists: {release_id}") from error
        final_release_owned = True
        _copy_wiki_pages(staging, final_release, manifest, limits)
        errors = _validate_wiki(sources, final_release, manifest, limits)
        if errors:
            raise HostValidationError("Copied Wiki validation failed: " + "; ".join(errors))
        page_hashes = _hashes(final_release, manifest.pages)
        metadata = _PublicationMetadata(
            repositories=repositories,
            skill_digest=skill_digest,
            model=model_name,
            generated_at=datetime.now(UTC),
            pages=[
                _PublishedPage(path=path, sha256=digest) for path, digest in page_hashes.items()
            ],
            content_digest=_content_digest(page_hashes),
        )
        _write_publication_metadata(final_release / PUBLICATION_METADATA_NAME, metadata)
        if (
            _directory_identity(destination.parent) != parent_before
            or _directory_identity(releases) != releases_before
        ):
            raise PublicationError("Published Wiki release directory changed during publication")
        _ensure_same_volume_for_publication(destination, releases)
        try:
            _swap_published_directory(destination, final_release, release_id=release_id)
        except _PublicationSwapUnrecoverable:
            # Leave the validated release and aside tree for operator recovery.
            final_release_owned = False
            raise
        final_release_owned = False
        _cleanup_release_tree(releases)
    except _PublicationSwapUnrecoverable:
        raise
    except Exception:
        if final_release_owned and final_release.exists():
            shutil.rmtree(final_release, ignore_errors=True)
        raise


__all__ = [
    "PUBLICATION_METADATA_NAME",
    "published_repository_views",
    "stage_published_wiki_for_refresh",
    "summarize_wiki_changes",
]
