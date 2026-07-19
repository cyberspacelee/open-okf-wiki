"""Path checks, locks, volumes, and mount preparation for Wiki Run."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from .errors import HostValidationError, PublicationError, operator_error
from .models import WikiRunRequest


# Windows FILE_ATTRIBUTE_REPARSE_POINT — junctions, symlinks, cloud placeholders, …
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

# winnt.h reparse tags used for Host path policy (portable; values are stable).
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003  # directory junction / volume mount
_IO_REPARSE_TAG_SYMLINK = 0xA000000C
# Benign filter/cloud tags that commonly appear as *ancestors* (e.g. OneDrive).
# These do not replace Host roots the way junctions/symlinks do.
_IO_REPARSE_TAG_FILE_PLACEHOLDER = 0x80000015
_IO_REPARSE_TAG_WCI = 0x80000018
_IO_REPARSE_TAG_WCI_1 = 0x90001018
_IO_REPARSE_TAG_CLOUD = 0x9000001A  # family 0x9000n01A for n in 0..F
_IO_REPARSE_TAG_PROJFS = 0x9000001C
_IO_REPARSE_TAG_STORAGE_SYNC = 0x8000001E
_IO_REPARSE_TAG_ONEDRIVE = 0x80000021
_IO_REPARSE_TAG_AF_UNIX = 0x80000023

_DISALLOWED_REPARSE_TAGS = frozenset(
    {
        _IO_REPARSE_TAG_MOUNT_POINT,
        _IO_REPARSE_TAG_SYMLINK,
    }
)
_ALLOWED_REPARSE_TAGS = frozenset(
    {
        _IO_REPARSE_TAG_FILE_PLACEHOLDER,
        _IO_REPARSE_TAG_WCI,
        _IO_REPARSE_TAG_WCI_1,
        _IO_REPARSE_TAG_PROJFS,
        _IO_REPARSE_TAG_STORAGE_SYNC,
        _IO_REPARSE_TAG_ONEDRIVE,
        _IO_REPARSE_TAG_AF_UNIX,
    }
)


def _is_cloud_reparse_tag(tag: int) -> bool:
    """True for the Windows cloud reparse family (OneDrive Files On-Demand, etc.)."""
    # CLOUD..CLOUD_F: 0x9000n01A for n in 0..F
    return (tag & 0xFFFF0FFF) == _IO_REPARSE_TAG_CLOUD


def _is_allowed_reparse_tag(tag: int) -> bool:
    return tag in _ALLOWED_REPARSE_TAGS or _is_cloud_reparse_tag(tag)


def _require_supported_runtime() -> None:
    """Portable capability check for Host staging/publication (ADR 0017).

    Wiki Run no longer requires Linux-only ``dir_fd`` / ``/proc/self/fd``. Hosts must
    support absolute paths, exclusive file create (``O_CREAT|O_EXCL``), and same-volume
    directory rename (``os.rename`` / ``os.replace``). Stricter openat backends are
    optional, not baseline.
    """
    missing: list[str] = []
    for name in ("rename", "replace", "mkdir", "fsync"):
        if not hasattr(os, name):
            missing.append(name)
    if not hasattr(os, "O_CREAT") or not hasattr(os, "O_EXCL"):
        missing.append("O_CREAT|O_EXCL")
    if missing:
        raise HostValidationError(
            "okf-wiki Wiki Run requires portable Host filesystem primitives for atomic "
            f"publication ({', '.join(missing)} missing on platform={sys.platform!r})."
        )


def _disallowed_path_reason(info: os.stat_result | object) -> str | None:
    """Return a short operator reason when a path component is Host-disallowed.

    Portable policy (ADR 0017):
    - Always reject POSIX/Windows symbolic links (``S_ISLNK``).
    - On Windows reparse points, reject directory junctions and symlink reparse tags
      that redirect Host roots; allow common cloud/filter tags (OneDrive, ProjFS, …)
      so normal workspaces under cloud-sync roots can create staging/publication dirs.
    - Reparse bit set with missing/unknown tag fails closed.
    """
    mode = getattr(info, "st_mode", 0)
    if stat.S_ISLNK(mode):
        return "a symbolic link"
    attrs = getattr(info, "st_file_attributes", 0) or 0
    if not (attrs & _FILE_ATTRIBUTE_REPARSE_POINT):
        return None
    tag = int(getattr(info, "st_reparse_tag", 0) or 0)
    if tag in _DISALLOWED_REPARSE_TAGS:
        if tag == _IO_REPARSE_TAG_MOUNT_POINT:
            return "a directory junction or volume mount point"
        return "a symbolic link reparse point"
    if tag and _is_allowed_reparse_tag(tag):
        return None
    if tag:
        return f"an unsupported host reparse point (tag=0x{tag:08X})"
    # Reparse attribute without a tag (or non-Windows attrs): fail closed.
    return "a host reparse point"


def _is_disallowed_path_component(info: os.stat_result | object) -> bool:
    """True for symlinks and disallowed host reparse points (junctions, unknown tags)."""
    return _disallowed_path_reason(info) is not None


def _path_component_error(label: str, reason: str) -> HostValidationError:
    return HostValidationError(f"{label} path must not contain {reason}")


def _legacy_symlink_publication_error(path: Path, *, for_refresh: bool = False) -> PublicationError:
    """Operator-facing rejection of the retired symlink Published Wiki layout."""
    if for_refresh:
        return PublicationError(
            "Refresh requires an existing Host-owned real-directory Published Wiki; "
            f"found a symbolic link or host reparse point at {path}. Delete or clear the "
            "legacy symlink layout and run a full Generate again (automatic migration is "
            "not supported)."
        )
    return PublicationError(
        "Published Wiki path is a symbolic link or host reparse point (legacy producer "
        "layout). okf-wiki no longer migrates symlink publications automatically. "
        f"Delete or clear {path} and run a full Generate again."
    )


def _prepare_mounts(request: WikiRunRequest) -> tuple[tuple[Path, ...], Path, Path, Path]:
    from .skill import _selected_producer_skill

    _require_supported_runtime()
    sources = tuple(
        _existing_directory(repository.path, f"Repository Snapshot {repository.id}")
        for repository in request.repositories
    )
    skill = _selected_producer_skill(request.skill)

    for index, source in enumerate(sources):
        if any(_overlaps(source, other) for other in sources[index + 1 :]):
            raise HostValidationError("Repository Snapshots must not overlap")

    staging_input = request.staging.absolute()
    _check_directory_path(staging_input, "Staging Wiki")
    staging = staging_input.resolve(strict=False)
    if any(
        _overlaps(source, skill) or _overlaps(source, staging) for source in sources
    ) or _overlaps(skill, staging):
        raise HostValidationError(
            "Repository Snapshots, Producer Skill, and Staging Wiki must not overlap"
        )
    _create_directory_path(staging_input, "Staging Wiki")
    staging = staging_input.resolve(strict=True)
    if any(_overlaps(source, staging) for source in sources) or _overlaps(skill, staging):
        raise HostValidationError(
            "Repository Snapshots, Producer Skill, and Staging Wiki must not overlap"
        )
    if any(staging.iterdir()):
        raise HostValidationError("Staging Wiki must be empty")
    publication_input = request.publication.absolute()
    if publication_input.name in {"", ".", ".."}:
        raise HostValidationError("Published Wiki path must name a directory")
    publication_parent = publication_input.parent
    _check_directory_path(publication_parent, "Published Wiki parent")
    _create_directory_path(publication_parent, "Published Wiki parent")
    publication = publication_parent.resolve(strict=True) / publication_input.name
    if (
        any(_overlaps(source, publication) for source in sources)
        or _overlaps(skill, publication)
        or _overlaps(staging, publication)
    ):
        raise HostValidationError(
            "Repository Snapshots, Producer Skill, Staging Wiki, and Published Wiki must not overlap"
        )
    if publication.is_symlink() or (
        os.path.lexists(publication) and _path_is_symlink_or_reparse(publication)
    ):
        raise _legacy_symlink_publication_error(publication)
    if os.path.lexists(publication) and not publication.is_dir():
        raise HostValidationError(
            "Published Wiki path must be absent or a regular directory "
            f"(found a non-directory at {publication})"
        )
    releases = publication.parent / f".{publication.name}.releases"
    _validate_release_root(releases)
    _ensure_same_volume_for_publication(publication, releases)
    return sources, skill, staging, publication


def _existing_directory(path: Path, label: str) -> Path:
    """Resolve an existing directory after portable symlink/reparse rejection."""
    candidate = path if path.is_absolute() else path.absolute()
    _check_directory_path(candidate, label)
    try:
        info = os.lstat(candidate)
    except FileNotFoundError as error:
        raise HostValidationError(f"{label} must be an existing directory") from error
    except OSError as error:
        raise operator_error(
            f"{label} path is not accessible", error, error_cls=HostValidationError
        ) from error
    if reason := _disallowed_path_reason(info):
        raise _path_component_error(label, reason)
    if not stat.S_ISDIR(info.st_mode):
        raise HostValidationError(f"{label} must be an existing directory")
    return candidate.resolve(strict=True)


def _path_is_symlink_or_reparse(path: Path) -> bool:
    try:
        return _is_disallowed_path_component(os.lstat(path))
    except OSError:
        return path.is_symlink()


def _check_directory_path(path: Path, label: str) -> None:
    if not path.is_absolute() or path.name in {"", ".", ".."} or ".." in path.parts:
        raise HostValidationError(f"{label} path must be a canonical directory path")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise operator_error(
                f"{label} path is not accessible", error, error_cls=HostValidationError
            ) from error
        if reason := _disallowed_path_reason(info):
            raise _path_component_error(label, reason)
        if not stat.S_ISDIR(info.st_mode):
            raise HostValidationError(f"{label} path must contain only directories")


def _create_directory_path(path: Path, label: str) -> None:
    """Create a directory tree with portable symlink/reparse rejection (no dir_fd).

    Does not use ``O_DIRECTORY`` / ``dir_fd`` (not portable to Windows). Walks each
    component with ``lstat`` + ``os.mkdir``, applying reparse-tag policy so cloud-sync
    ancestors (OneDrive) can be used while junctions/symlinks still fail closed.
    """
    if not path.is_absolute() or path.name in {"", ".", ".."} or ".." in path.parts:
        raise HostValidationError(f"{label} path must be a canonical directory path")
    current = Path(path.anchor)
    try:
        anchor_info = os.lstat(current)
    except OSError as error:
        raise operator_error(
            f"{label} path is not accessible", error, error_cls=HostValidationError
        ) from error
    if reason := _disallowed_path_reason(anchor_info):
        raise _path_component_error(label, reason)
    if not stat.S_ISDIR(anchor_info.st_mode):
        raise HostValidationError(f"{label} path must contain only directories")
    for part in path.parts[1:]:
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            try:
                os.mkdir(current)
            except FileExistsError:
                pass
            except OSError as error:
                raise operator_error(
                    f"{label} directory could not be created", error, error_cls=HostValidationError
                ) from error
            try:
                info = os.lstat(current)
            except OSError as error:
                raise operator_error(
                    f"{label} path is not accessible after create",
                    error,
                    error_cls=HostValidationError,
                ) from error
        except OSError as error:
            raise operator_error(
                f"{label} path is not accessible",
                error,
                error_cls=HostValidationError,
            ) from error
        if reason := _disallowed_path_reason(info):
            raise _path_component_error(label, reason)
        if not stat.S_ISDIR(info.st_mode):
            raise HostValidationError(f"{label} path must contain only directories")
    try:
        _check_directory_path(path, label)
        final = os.lstat(path)
    except HostValidationError:
        raise
    except OSError as error:
        raise operator_error(
            f"{label} path is not accessible", error, error_cls=HostValidationError
        ) from error
    if reason := _disallowed_path_reason(final):
        raise HostValidationError(f"{label} path changed during creation ({reason})")
    if not stat.S_ISDIR(final.st_mode):
        raise HostValidationError(f"{label} path changed during creation")


def _overlaps(left: Path, right: Path) -> bool:
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def _validate_release_root(path: Path) -> None:
    if os.path.lexists(path) and (_path_is_symlink_or_reparse(path) or not path.is_dir()):
        raise HostValidationError("Published Wiki release directory must be a regular directory")


def _directory_identity(path: Path) -> tuple[int, int] | None:
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISDIR(info.st_mode) or _is_disallowed_path_component(info):
        return None
    return (info.st_dev, info.st_ino)


def _ensure_same_volume_for_publication(publication: Path, releases: Path) -> None:
    """Fail closed when Published Wiki and releases root cannot share a rename volume."""
    parent = publication.parent
    try:
        parent_info = os.stat(parent)
    except OSError as error:
        raise operator_error(
            "Published Wiki parent is not accessible", error, error_cls=HostValidationError
        ) from error
    if os.path.lexists(releases):
        try:
            release_info = os.lstat(releases)
        except OSError as error:
            raise operator_error(
                "Published Wiki release directory is not accessible",
                error,
                error_cls=HostValidationError,
            ) from error
        if _is_disallowed_path_component(release_info) or not stat.S_ISDIR(release_info.st_mode):
            raise HostValidationError(
                "Published Wiki release directory must be a regular directory"
            )
        if release_info.st_dev != parent_info.st_dev:
            raise HostValidationError(
                "Published Wiki path and release directory must share the same volume "
                f"for atomic directory-rename publication (publication parent={parent}, "
                f"releases={releases}). Move both onto one filesystem; copy fallback is not "
                "supported."
            )
    if os.path.lexists(publication) and publication.is_dir() and not publication.is_symlink():
        try:
            publication_info = os.lstat(publication)
        except OSError as error:
            raise operator_error(
                "Published Wiki path is not accessible", error, error_cls=HostValidationError
            ) from error
        if publication_info.st_dev != parent_info.st_dev:
            raise HostValidationError(
                "Published Wiki path and its parent must share the same volume "
                f"for atomic directory-rename publication (path={publication})."
            )


def _ensure_release_root(path: Path) -> Path:
    _validate_release_root(path)
    try:
        os.mkdir(path)
    except FileExistsError:
        pass
    except OSError as error:
        raise operator_error(
            "Published Wiki release directory could not be created",
            error,
            error_cls=HostValidationError,
        ) from error
    _validate_release_root(path)
    if not path.is_dir() or _path_is_symlink_or_reparse(path):
        raise HostValidationError("Published Wiki release directory must be a regular directory")
    return path


def _publication_lock_path(publication: Path) -> Path:
    return publication.parent / f".{publication.name}.publish.lock"


def acquire_publication_lock(publication: Path) -> Path:
    """Exclusive Host lock for one Wiki Run against a Published Wiki path (O_EXCL file).

    Intentionally held for the whole run (prepare through model work to swap), not only the
    final rename: concurrent Wiki Runs must not interleave staging or publication against
    the same destination. Released on the normal exit path. If a previous process crashed,
    operators may remove the stale lock file after confirming no Wiki Run is active for this
    Published Wiki path.
    """
    _create_directory_path(publication.parent, "Published Wiki parent")
    lock_path = _publication_lock_path(publication)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except FileExistsError as error:
        stale_hint = (
            f"If no Wiki Run is active, remove the stale lock file after confirming the path "
            f"is idle: {lock_path}"
        )
        raise PublicationError(
            f"Published Wiki path is locked by another Wiki Run: {publication}. {stale_hint}"
        ) from error
    except OSError as error:
        raise operator_error(
            f"Published Wiki lock could not be acquired for {publication}",
            error,
            error_cls=PublicationError,
        ) from error
    try:
        payload = f"pid={os.getpid()}\n".encode("utf-8")
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return lock_path


def release_publication_lock(lock_path: Path | None) -> None:
    """Release a lock acquired by :func:`acquire_publication_lock`."""
    if lock_path is None:
        return
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass


# Private aliases kept for in-package call sites during the deepening transition.
_acquire_publication_lock = acquire_publication_lock
_release_publication_lock = release_publication_lock
