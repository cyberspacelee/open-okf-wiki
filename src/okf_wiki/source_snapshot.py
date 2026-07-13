import asyncio
from pathlib import Path
from urllib.parse import quote_from_bytes

from .security import (
    MAX_ANALYZABLE_FILE_BYTES,
    MAX_SEARCH_MATCHES,
    MAX_TOOL_RESULT_CHARS,
    canonical_source_path,
    git_read,
    git_read_bytes,
)


class GitObjectSnapshotReader:
    """Read only Git objects belonging to one exact commit."""

    def __init__(self, repository: Path, source_id: str, revision: str) -> None:
        self.repository = repository.resolve()
        self.source_id = source_id
        self.revision = revision.lower()
        resolved = (
            git_read(self.repository, "rev-parse", "--verify", f"{revision}^{{commit}}")
            .strip()
            .lower()
        )
        if resolved != self.revision:
            raise ValueError("revision does not resolve to the exact requested commit")
        self._object_ids = self._load_objects()

    def _blob_text(self, path: str) -> str:
        object_id = self._object_ids.get(path)
        if object_id is None:
            raise ValueError("path is missing from the assigned Source Snapshot")
        if int(git_read(self.repository, "cat-file", "-s", object_id)) > MAX_ANALYZABLE_FILE_BYTES:
            raise ValueError("source file exceeds the static-analysis size limit")
        return git_read_bytes(self.repository, "cat-file", "blob", object_id).decode("utf-8")

    def _load_objects(self) -> dict[str, str]:
        objects = {}
        for record in git_read_bytes(
            self.repository, "ls-tree", "-r", "--full-tree", "-z", self.revision
        ).split(b"\0"):
            if not record:
                continue
            metadata, path = record.split(b"\t", 1)
            _mode, object_type, object_id = metadata.split(b" ", 2)
            if object_type == b"blob":
                objects[quote_from_bytes(path, safe="/")] = object_id.decode()
        return objects

    def list_paths_sync(
        self, prefix: str = "", *, allowed: tuple[str, ...] | None = None
    ) -> list[str]:
        prefix = canonical_source_path(prefix) if prefix else ""
        present = self._object_ids
        scope = (
            {canonical_source_path(path) for path in allowed}
            if allowed is not None
            else set(present)
        )
        return sorted(path for path in present if path in scope and path.startswith(prefix))

    async def list_paths(self, prefix: str = "", *, allowed: tuple[str, ...]) -> list[str]:
        return await asyncio.to_thread(self.list_paths_sync, prefix, allowed=allowed)

    def read_text_sync(
        self,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        path = canonical_source_path(path)
        if path not in {canonical_source_path(item) for item in allowed}:
            raise ValueError("path is outside the assigned Source Snapshot scope")
        if start_line < 1 or end_line < start_line:
            raise ValueError("use 1-based lines with end_line >= start_line")
        text = self._blob_text(path)
        lines = text.splitlines()
        if end_line > len(lines):
            raise ValueError("line span is outside the source file")
        result = "\n".join(lines[start_line - 1 : end_line])
        if len(result) > MAX_TOOL_RESULT_CHARS:
            raise ValueError("requested source span exceeds the tool result size limit")
        return result

    async def read_text(
        self,
        path: str,
        start_line: int,
        end_line: int,
        *,
        allowed: tuple[str, ...],
    ) -> str:
        return await asyncio.to_thread(
            self.read_text_sync,
            path,
            start_line,
            end_line,
            allowed=allowed,
        )

    async def search_text(
        self,
        query: str,
        *,
        paths: list[str] | None,
        allowed: tuple[str, ...],
    ) -> list[dict[str, object]]:
        selected = (
            tuple(canonical_source_path(path) for path in paths) if paths is not None else allowed
        )
        if not set(selected) <= {canonical_source_path(path) for path in allowed}:
            raise ValueError("search paths are outside the assigned Source Snapshot scope")
        matches: list[dict[str, object]] = []
        result_chars = 0
        for path in await self.list_paths(allowed=selected):
            text = await self.read_text(
                path, 1, self.line_count(path, allowed=allowed), allowed=allowed
            )
            for line_number, line in enumerate(text.splitlines(), 1):
                if query not in line:
                    continue
                result_chars += len(path) + len(line) + 32
                if len(matches) >= MAX_SEARCH_MATCHES or result_chars > MAX_TOOL_RESULT_CHARS:
                    raise ValueError("search result exceeds the tool result size limit")
                matches.append({"path": path, "line": line_number, "text": line})
        return matches

    def line_count(self, path: str, *, allowed: tuple[str, ...]) -> int:
        path = canonical_source_path(path)
        if path not in allowed:
            raise ValueError("path is outside the assigned Source Snapshot scope")
        return len(self._blob_text(path).splitlines())
