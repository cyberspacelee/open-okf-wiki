"""Portable Host filesystem policy (ADR 0017).

Public façade for path-component safety and atomic single-file handoffs.
Path-walk implementation lives in :mod:`okf_wiki.host.mounts` (publication
layout + locks); this module is the Host-facing import surface and the home of
shared atomic file replace used by Wiki Run Record and Analysis Receipts.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from .mounts import (
    _check_directory_path as check_directory_path,
    _create_directory_path as create_directory_path,
    _disallowed_path_reason as disallowed_path_reason,
    _is_allowed_reparse_tag as is_allowed_reparse_tag,
    _is_cloud_reparse_tag as is_cloud_reparse_tag,
    _is_disallowed_path_component as is_disallowed_path_component,
    _path_component_error as path_component_error,
    _path_is_symlink_or_reparse as path_is_symlink_or_reparse,
)


def write_bytes_atomically(
    path: Path,
    data: bytes,
    *,
    max_bytes: int,
    label: str,
    mode: int = 0o600,
) -> None:
    """Write ``data`` via temp file + ``os.replace`` (immutable handoff).

    Fails closed if the destination already exists.
    """
    if len(data) > max_bytes:
        raise ValueError(f"{label} exceeds the configured byte limit")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, mode)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(descriptor, view) :]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if os.path.lexists(path):
            raise ValueError(f"{label} already exists")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


__all__ = [
    "check_directory_path",
    "create_directory_path",
    "disallowed_path_reason",
    "is_allowed_reparse_tag",
    "is_cloud_reparse_tag",
    "is_disallowed_path_component",
    "path_component_error",
    "path_is_symlink_or_reparse",
    "write_bytes_atomically",
]
