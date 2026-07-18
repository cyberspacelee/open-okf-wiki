"""Repository snapshot materialization and source inventory."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from fnmatch import fnmatchcase
from pathlib import Path

from .run_models import WikiRunLimits
from .security import git_read, git_read_bytes


_FULL_COMMIT_RE = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})")


def _write_source_inventory(source_mount: Path, sources: Mapping[str, Path]) -> Path:
    """Write a Host-owned inventory under the source mount for Agent discovery."""
    entries: list[dict[str, object]] = []
    for repository_id, root in sorted(sources.items()):
        files: list[str] = []
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if relative.startswith(".okf-wiki-host/"):
                continue
            files.append(relative)
        entries.append(
            {
                "repository_id": repository_id,
                "file_count": len(files),
                "files": files[:2_000],
                "truncated": len(files) > 2_000,
            }
        )
    host_dir = source_mount / ".okf-wiki-host"
    host_dir.mkdir(parents=True, exist_ok=True)
    inventory_path = host_dir / "inventory.json"
    inventory_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "role": "source_inventory",
                "accelerator_only": True,
                "repositories": entries,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return inventory_path


def _materialize_repository_snapshot(
    checkout: Path,
    revision: str,
    target: Path,
    limits: WikiRunLimits,
    *,
    ignore: tuple[str, ...],
    used_files: int,
    used_bytes: int,
) -> tuple[int, int]:
    if _FULL_COMMIT_RE.fullmatch(revision) is None:
        raise ValueError("Repository Snapshot revision must be a complete Git commit ID")
    if git_read(checkout, "rev-parse", "--is-inside-work-tree").strip() != "true":
        raise ValueError("Repository Snapshot must be a Git working tree")
    top = Path(git_read(checkout, "rev-parse", "--show-toplevel").strip()).resolve()
    if top != checkout:
        raise ValueError("Repository Snapshot path must be the Git working-tree root")
    resolved = git_read(checkout, "rev-parse", "--verify", f"{revision}^{{commit}}").strip()
    if resolved.casefold() != revision.casefold():
        raise ValueError("Repository Snapshot revision must resolve to the exact commit")
    config_keys = git_read_bytes(
        checkout, "config", "--includes", "--name-only", "--null", "--list"
    ).split(b"\0")
    if any(
        key.lower().startswith(b"filter.")
        and key.lower().rsplit(b".", 1)[-1] in {b"clean", b"smudge", b"process"}
        for key in config_keys
    ):
        raise ValueError("Repository Snapshot checkout must not configure executable Git filters")
    if git_read(checkout, "status", "--porcelain=v1", "--untracked-files=all").strip():
        raise ValueError("Repository Snapshot checkout must be clean")

    records = git_read_bytes(checkout, "ls-tree", "-r", "-l", "--full-tree", "-z", resolved).split(
        b"\0"
    )
    blobs: list[tuple[bytes, bytes]] = []
    for record in records:
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        _mode, object_type, object_id, raw_size = metadata.split()
        relative = os.fsdecode(raw_path)
        if any(fnmatchcase(relative, pattern) for pattern in ignore):
            continue
        if object_type != b"blob":
            raise ValueError("Repository Snapshot contains an unsupported non-file tree entry")
        size = int(raw_size)
        if size > limits.source_file_bytes_limit:
            raise ValueError("Repository Snapshot source file exceeds the configured byte limit")
        used_bytes += size
        if used_bytes > limits.source_total_bytes_limit:
            raise ValueError("Repository Snapshot Set exceeds the configured total byte limit")
        blobs.append((object_id, raw_path))
        used_files += 1
        if used_files > limits.source_files_limit:
            raise ValueError("Repository Snapshot Set exceeds the configured file count limit")

    target.mkdir()
    for object_id, raw_path in blobs:
        parts = raw_path.split(b"/")
        if any(part in {b"", b".", b".."} for part in parts):
            raise ValueError("Repository Snapshot contains an unsafe path")
        destination = target.joinpath(*(os.fsdecode(part) for part in parts))
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Repository symlink blobs stay inert, so materialization cannot escape the snapshot.
        # ponytail: one safe subprocess per blob; use `cat-file --batch` if profiling demands it.
        destination.write_bytes(git_read_bytes(checkout, "cat-file", "blob", object_id.decode()))
    return used_files, used_bytes
