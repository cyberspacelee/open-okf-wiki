"""Run-local, run-owned Analysis Receipt handoff storage."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import threading
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from ..errors import operator_error
from ..security import MAX_ANALYZABLE_FILE_BYTES


RECEIPT_SCHEMA = "okf.analysis.receipt/v1"
HANDOFF_SCHEMA = "okf.analysis.handoff/v1"
DEFAULT_RECEIPT_BYTES_LIMIT = 128 * 1024
DEFAULT_ARTIFACT_BYTES_LIMIT = 2 * 1024 * 1024
DEFAULT_WORKSPACE_BYTES_LIMIT = 32 * 1024 * 1024
DEFAULT_WORKSPACE_ENTRIES_LIMIT = 256

_COMMIT_RE = r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
_SHA_RE = r"^[0-9a-f]{64}$"
_ID_RE = r"^[a-z0-9][a-z0-9-]{0,63}$"


def _canonical_relative_path(path: str) -> str:
    pure = PurePosixPath(path)
    if (
        not path
        or path.strip() != path
        or "\\" in path
        or "\x00" in path
        or pure.is_absolute()
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or pure.as_posix() != path
    ):
        raise ValueError("receipt paths must be canonical relative POSIX paths")
    return path


ReceiptPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=500),
    AfterValidator(_canonical_relative_path),
]
OpaqueId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=_ID_RE),
]
SourceRevision = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, pattern=_COMMIT_RE),
]
Sha256 = Annotated[str, StringConstraints(pattern=_SHA_RE)]


class ReceiptEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    repository_id: OpaqueId = "source"
    source_revision: SourceRevision
    path: ReceiptPath
    line_start: int = Field(gt=0)
    line_end: int = Field(gt=0)
    claim: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)]
    sha256: Sha256

    @model_validator(mode="after")
    def validate_lines(self) -> "ReceiptEvidence":
        if self.line_end < self.line_start:
            raise ValueError("evidence line_end must be greater than or equal to line_start")
        return self


class ReceiptArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: ReceiptPath
    media_type: Literal["text/markdown"]
    bytes: int = Field(gt=0)
    sha256: Sha256

    @model_validator(mode="after")
    def validate_markdown_path(self) -> "ReceiptArtifact":
        if PurePosixPath(self.path).suffix.casefold() not in {".md", ".markdown"}:
            raise ValueError("Analysis artifacts must be Markdown files")
        return self


ReceiptStatus = Literal["complete", "partial", "failed", "cancelled"]


class AnalysisReceipt(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    schema_: Literal["okf.analysis.receipt/v1"] = Field(RECEIPT_SCHEMA, alias="schema")
    run_id: OpaqueId
    node_id: OpaqueId
    parent_id: OpaqueId | None = None
    attempt: int = Field(ge=1, le=999)
    status: ReceiptStatus
    scope: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
    source_revision: SourceRevision | None = None
    summary: Annotated[str, StringConstraints(max_length=4_096)] = ""
    findings: list[Annotated[str, StringConstraints(max_length=4_000)]] = Field(
        default_factory=list, max_length=128
    )
    evidence: list[ReceiptEvidence] = Field(default_factory=list, max_length=256)
    child_receipts: list[ReceiptPath] = Field(default_factory=list, max_length=32)
    artifacts: list[ReceiptArtifact] = Field(default_factory=list, max_length=16)
    open_questions: list[Annotated[str, StringConstraints(max_length=1_000)]] = Field(
        default_factory=list, max_length=32
    )

    @property
    def schema(self) -> str:
        return self.schema_


class HandoffRef(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    schema_: Literal["okf.analysis.handoff/v1"] = Field(HANDOFF_SCHEMA, alias="schema")
    task_id: OpaqueId
    node_id: OpaqueId
    attempt: int = Field(ge=1, le=999)
    status: ReceiptStatus
    summary: Annotated[str, StringConstraints(max_length=4_096)] = ""
    receipt: ReceiptPath

    @property
    def schema(self) -> str:
        return self.schema_


class ArtifactSlice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: ReceiptPath
    offset: int = Field(ge=0)
    next_offset: int = Field(ge=0)
    data: str
    complete: bool


class AnalysisWorkspace:
    """A private run-local store for immutable receipts and bounded artifacts."""

    def __init__(
        self,
        run_id: str,
        *,
        root: Path | None = None,
        repositories: Mapping[str, tuple[str, Path]] | None = None,
        limits: object | None = None,
        retain: bool = False,
    ) -> None:
        self.run_id = _validate_id(run_id, "run_id")
        self._retain = retain
        self._closed = False
        self._receipt_limit = _limit(
            limits, "analysis_receipt_bytes_limit", DEFAULT_RECEIPT_BYTES_LIMIT
        )
        self._artifact_limit = _limit(
            limits, "analysis_artifact_bytes_limit", DEFAULT_ARTIFACT_BYTES_LIMIT
        )
        self._workspace_limit = _limit(
            limits, "analysis_workspace_bytes_limit", DEFAULT_WORKSPACE_BYTES_LIMIT
        )
        self._entries_limit = _limit(
            limits, "analysis_workspace_entries_limit", DEFAULT_WORKSPACE_ENTRIES_LIMIT
        )
        self._repositories = _repositories(repositories)
        self._attempts: set[tuple[str, int]] = set()
        self._next_attempts: dict[str, int] = {}
        self._completed_tasks: set[str] = set()
        self._assignments: dict[str, tuple[str, str | None]] = {}
        self._publish_lock = threading.Lock()
        if root is None:
            if retain:
                self._temporary = None
                self.root = Path(
                    tempfile.mkdtemp(prefix=f"okf-analysis-{self.run_id[:8]}-")
                ).resolve()
            else:
                self._temporary = tempfile.TemporaryDirectory(
                    prefix=f"okf-analysis-{self.run_id[:8]}-"
                )
                self.root = Path(self._temporary.name).resolve()
        else:
            self._temporary = None
            target = Path(root).absolute()
            if target.exists():
                raise ValueError("Analysis Workspace root must not already exist")
            target.mkdir(parents=True, exist_ok=False, mode=0o700)
            self.root = target.resolve(strict=True)
        try:
            (self.root / "receipts").mkdir(mode=0o700)
            (self.root / "artifacts").mkdir(mode=0o700)
            (self.root / "overflow").mkdir(mode=0o700)
        except Exception:
            if self._temporary is not None:
                self._temporary.cleanup()
            else:
                shutil.rmtree(self.root, ignore_errors=True)
            raise

    def __enter__(self) -> "AnalysisWorkspace":
        return self

    def __exit__(self, *_: object) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._retain:
            return
        if self._temporary is not None:
            self._temporary.cleanup()
        else:
            shutil.rmtree(self.root, ignore_errors=True)

    def configure_sources(self, repositories: Mapping[str, tuple[str, Path]]) -> None:
        self._assert_open()
        with self._publish_lock:
            if self._attempts:
                raise ValueError("Analysis Workspace sources cannot change after publication")
            self._repositories = _repositories(repositories)

    def register_node(self, task_id: str, node_id: str, parent_id: str | None = None) -> None:
        """Bind a run-assigned task identity to the receipt node it may publish."""
        self._assert_open()
        task_id = _validate_id(task_id, "task_id")
        node_id = _validate_id(node_id, "node_id")
        if parent_id is not None:
            parent_id = _validate_id(parent_id, "parent_id")
        with self._publish_lock:
            existing = self._assignments.get(task_id)
            assignment = (node_id, parent_id)
            if existing is not None and existing != assignment:
                raise ValueError("task identity is already assigned")
            if any(
                other_task != task_id and assigned_node == node_id
                for other_task, (assigned_node, _) in self._assignments.items()
            ):
                raise ValueError("node identity is already assigned")
            self._assignments[task_id] = assignment
            self._next_attempts.setdefault(task_id, 1)

    def publish_receipt(
        self,
        receipt: AnalysisReceipt,
        *,
        task_id: str | None = None,
        artifacts: Mapping[str, bytes | str] | None = None,
    ) -> HandoffRef:
        self._assert_open()
        if receipt.run_id != self.run_id:
            raise ValueError("receipt run_id does not match the Analysis Workspace")
        task_id = _validate_id(task_id or receipt.node_id, "task_id")
        attempt = (task_id, receipt.attempt)
        with self._publish_lock:
            assignment = self._assignments.get(task_id)
            if assignment is None:
                raise ValueError("task identity is not registered")
            expected_node, expected_parent = assignment
            if receipt.node_id != expected_node or receipt.parent_id != expected_parent:
                raise ValueError("receipt identity does not match the assigned task")
            if task_id in self._completed_tasks:
                raise ValueError("receipt attempt has already been published for a completed task")
            if receipt.attempt != self._next_attempts[task_id]:
                raise ValueError("receipt attempt does not match the run assignment")
            if attempt in self._attempts:
                raise ValueError("receipt attempt has already been published")
            self._attempts.add(attempt)
        try:
            self._validate_evidence(receipt)
            self._validate_child_receipts(receipt)
            materialized = self._materialize_artifacts(receipt, artifacts or {})
            published = receipt.model_copy(update={"artifacts": materialized[0]})
            encoded = json.dumps(
                published.model_dump(mode="json", by_alias=True),
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            if len(encoded) > self._receipt_limit:
                raise ValueError("Analysis Receipt exceeds the configured byte limit")
            artifact_paths = materialized[1]
            with self._publish_lock:
                self._check_quota(
                    len(artifact_paths) + 1,
                    len(encoded) + sum(size for _, size in artifact_paths),
                )
                receipt_path = self.root / "receipts" / task_id
                receipt_path.mkdir(parents=True, exist_ok=True, mode=0o700)
                final = receipt_path / f"attempt-{receipt.attempt:03d}-{uuid.uuid4().hex}.json"
                created: list[Path] = []
                try:
                    for path, data in materialized[2]:
                        _write_atomic(path, data, self._artifact_limit, "Analysis artifact")
                        created.append(path)
                    _write_atomic(final, encoded, self._receipt_limit, "Analysis Receipt")
                    created.append(final)
                    self._next_attempts[task_id] += 1
                    if receipt.status == "complete":
                        self._completed_tasks.add(task_id)
                except Exception:
                    for path in created:
                        path.unlink(missing_ok=True)
                    raise
            relative = final.relative_to(self.root).as_posix()
            return HandoffRef(
                task_id=task_id,
                node_id=receipt.node_id,
                attempt=receipt.attempt,
                status=receipt.status,
                summary=receipt.summary[:4_096],
                receipt=relative,
            )
        except Exception:
            with self._publish_lock:
                self._attempts.discard(attempt)
            raise

    def read_receipt(self, handoff: HandoffRef) -> AnalysisReceipt:
        self._assert_open()
        if not isinstance(handoff, HandoffRef):
            raise TypeError("read_receipt requires a HandoffRef")
        relative = handoff.receipt
        path = self._contained_path(relative)
        if path.is_symlink() or not path.is_file():
            raise ValueError("Analysis Receipt is missing or not a regular file")
        data = path.read_bytes()
        if len(data) > self._receipt_limit:
            raise ValueError("Analysis Receipt exceeds the configured byte limit")
        try:
            receipt = AnalysisReceipt.model_validate_json(data)
        except Exception as error:
            raise operator_error("Analysis Receipt is invalid", error) from error
        if receipt.run_id != self.run_id:
            raise ValueError("Analysis Receipt belongs to another run")
        if isinstance(handoff, HandoffRef) and (
            receipt.node_id != handoff.node_id
            or receipt.attempt != handoff.attempt
            or receipt.status != handoff.status
            or handoff.task_id != self._task_id_for_node(receipt.node_id)
        ):
            raise ValueError("Handoff Ref does not match the Analysis Receipt")
        self._validate_evidence(receipt)
        self._validate_artifact_descriptors(receipt.artifacts)
        return receipt

    def read_artifact(
        self,
        handoff: HandoffRef,
        path: str,
        *,
        offset: int = 0,
        limit: int = 64 * 1024,
    ) -> ArtifactSlice:
        """Read one bounded UTF-8 Markdown artifact slice by byte offset."""
        if offset < 0 or limit <= 0 or limit > 64 * 1024:
            raise ValueError("artifact slice offset/limit is outside the allowed bounds")
        receipt = self.read_receipt(handoff)
        canonical = _canonical_relative_path(path)
        descriptor = next((item for item in receipt.artifacts if item.path == canonical), None)
        if descriptor is None:
            raise ValueError("artifact is not listed in the Analysis Receipt")
        artifact_path = self._contained_path(descriptor.path)
        raw = artifact_path.read_bytes()
        if len(raw) != descriptor.bytes or len(raw) > self._artifact_limit:
            raise ValueError("Analysis artifact size does not match its descriptor")
        if offset > len(raw):
            raise ValueError("artifact slice offset is past the end of the artifact")
        next_offset, data = _bounded_utf8_slice(raw, offset, limit)
        return ArtifactSlice(
            path=canonical,
            offset=offset,
            next_offset=next_offset,
            data=data,
            complete=next_offset == len(raw),
        )

    def publish_overflow(self, key: str, data: bytes) -> str:
        """Store one opaque Harness spill within the Workspace quota."""
        self._assert_open()
        if not isinstance(key, str) or not key:
            raise ValueError("overflow key must be a non-empty string")
        if not isinstance(data, bytes):
            raise TypeError("overflow data must be bytes")
        stem = hashlib.sha256(key.encode("utf-8", errors="replace")).hexdigest()[:16]
        final = self.root / "overflow" / f"{stem}-{uuid.uuid4().hex}.bin"
        with self._publish_lock:
            self._check_quota(1, len(data))
            _write_atomic(final, data, self._workspace_limit, "Analysis overflow")
        return final.relative_to(self.root).as_posix()

    def read_overflow(self, handle: str) -> bytes:
        """Read an opaque Harness spill without exposing directory discovery."""
        self._assert_open()
        canonical = _canonical_relative_path(handle)
        pure = PurePosixPath(canonical)
        if len(pure.parts) != 2 or pure.parts[0] != "overflow":
            raise ValueError("overflow handle is invalid")
        path = self._contained_path(canonical)
        if path.is_symlink() or not path.is_file():
            raise ValueError("Analysis overflow is missing or not a regular file")
        if path.stat().st_size > self._workspace_limit:
            raise ValueError("Analysis overflow exceeds the Workspace byte limit")
        return path.read_bytes()

    def _assert_open(self) -> None:
        if self._closed:
            raise ValueError("Analysis Workspace is closed")

    def _task_id_for_node(self, node_id: str) -> str:
        matches = [
            task_id for task_id, (assigned, _) in self._assignments.items() if assigned == node_id
        ]
        if len(matches) != 1:
            raise ValueError("receipt node is not assigned to a unique task")
        return matches[0]

    def _contained_path(self, relative: str) -> Path:
        path = self.root.joinpath(*PurePosixPath(relative).parts)
        try:
            resolved = path.resolve(strict=False)
            if not resolved.is_relative_to(self.root.resolve()):
                raise ValueError("Analysis Workspace path escapes its root")
        except OSError as error:
            raise operator_error("Analysis Workspace path is not accessible", error) from error
        return path

    def _validate_evidence(self, receipt: AnalysisReceipt) -> None:
        for item in receipt.evidence:
            if (
                receipt.source_revision is not None
                and item.source_revision != receipt.source_revision
            ):
                raise ValueError("evidence revision does not match the receipt source_revision")
            configured = self._repositories.get(item.repository_id)
            if configured is None:
                raise ValueError(f"unknown evidence repository: {item.repository_id}")
            revision, root = configured
            if item.source_revision != revision:
                raise ValueError("evidence revision does not match the frozen snapshot")
            source_root = root.resolve(strict=True)
            candidate = source_root.joinpath(*PurePosixPath(item.path).parts)
            self._assert_no_symlink_path(source_root, candidate)
            try:
                resolved = candidate.resolve(strict=True)
            except OSError as error:
                raise operator_error(f"evidence path does not exist: {item.path}", error) from error
            if not resolved.is_relative_to(source_root) or not candidate.is_file():
                raise ValueError("evidence path is not a regular file in the snapshot")
            if candidate.stat().st_size > MAX_ANALYZABLE_FILE_BYTES:
                raise ValueError("evidence path exceeds the analyzable file limit")
            raw = candidate.read_bytes()
            if b"\0" in raw:
                raise ValueError("evidence path is not an analyzable UTF-8 text file")
            try:
                lines = raw.decode("utf-8").splitlines(keepends=True)
            except UnicodeDecodeError as error:
                raise operator_error(
                    f"evidence path is not UTF-8 text: {item.path}", error
                ) from error
            if item.line_end > len(lines):
                raise ValueError("evidence line range does not resolve")
            cited = "".join(lines[item.line_start - 1 : item.line_end]).encode("utf-8")
            if hashlib.sha256(cited).hexdigest() != item.sha256:
                raise ValueError("evidence hash does not match the frozen source bytes")

    def _validate_child_receipts(self, receipt: AnalysisReceipt) -> None:
        if len(set(receipt.child_receipts)) != len(receipt.child_receipts):
            raise ValueError("receipt child references must be unique")
        for relative in receipt.child_receipts:
            path = self._contained_path(relative)
            if path.is_symlink() or not path.is_file():
                raise ValueError("receipt child reference is missing or not a regular file")
            if path.stat().st_size > self._receipt_limit:
                raise ValueError("receipt child reference exceeds the byte limit")
            try:
                child = AnalysisReceipt.model_validate_json(path.read_bytes())
            except Exception as error:
                raise operator_error(
                    f"receipt child reference is invalid: {relative}", error
                ) from error
            if child.run_id != self.run_id or child.parent_id != receipt.node_id:
                raise ValueError("receipt child reference does not belong to this parent")

    def _assert_no_symlink_path(self, root: Path, candidate: Path) -> None:
        relative = candidate.relative_to(root)
        current = root
        for part in relative.parts:
            current /= part
            try:
                if current.is_symlink():
                    raise ValueError("evidence path must not traverse a symlink")
            except OSError as error:
                raise operator_error("evidence path is not accessible", error) from error

    def _materialize_artifacts(
        self,
        receipt: AnalysisReceipt,
        artifacts: Mapping[str, bytes | str],
    ) -> tuple[list[ReceiptArtifact], list[tuple[Path, int]], list[tuple[Path, bytes]]]:
        if set(artifacts) != {item.path for item in receipt.artifacts}:
            if artifacts or receipt.artifacts:
                raise ValueError("artifact descriptors and supplied artifacts do not match")
        descriptors: list[ReceiptArtifact] = []
        sizes: list[tuple[Path, int]] = []
        writes: list[tuple[Path, bytes]] = []
        for item in receipt.artifacts:
            raw = _artifact_bytes(artifacts[item.path], self._artifact_limit)
            if len(raw) != item.bytes:
                raise ValueError("artifact byte count does not match its descriptor")
            if len(raw) > self._artifact_limit:
                raise ValueError("Analysis artifact exceeds the configured byte limit")
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError as error:
                raise operator_error(
                    f"Analysis artifact is not UTF-8 Markdown: {item.path}", error
                ) from error
            digest = hashlib.sha256(raw).hexdigest()
            if digest != item.sha256:
                raise ValueError("artifact hash does not match its descriptor")
            suffix = Path(item.path).suffix if Path(item.path).suffix else ".bin"
            assigned = (
                self.root
                / "artifacts"
                / receipt.node_id
                / f"{receipt.attempt:03d}-{uuid.uuid4().hex}{suffix}"
            )
            descriptors.append(
                item.model_copy(update={"path": assigned.relative_to(self.root).as_posix()})
            )
            sizes.append((assigned, len(raw)))
            writes.append((assigned, raw))
        return descriptors, sizes, writes

    def _validate_artifact_descriptors(self, artifacts: Sequence[ReceiptArtifact]) -> None:
        for item in artifacts:
            path = self._contained_path(item.path)
            if path.is_symlink() or not path.is_file():
                raise ValueError("Analysis artifact is missing or not a regular file")
            if path.stat().st_size > self._artifact_limit:
                raise ValueError("Analysis artifact exceeds the configured byte limit")
            raw = path.read_bytes()
            if len(raw) != item.bytes or len(raw) > self._artifact_limit:
                raise ValueError("Analysis artifact size does not match its descriptor")
            if hashlib.sha256(raw).hexdigest() != item.sha256:
                raise ValueError("Analysis artifact hash does not match its descriptor")

    def _check_quota(self, new_entries: int, new_bytes: int) -> None:
        entries = 0
        total = 0
        for path in self.root.rglob("*"):
            if path.is_symlink():
                raise ValueError("Analysis Workspace must not contain symlinks")
            if path.is_file():
                entries += 1
                total += path.stat().st_size
        if entries + new_entries > self._entries_limit:
            raise ValueError("Analysis Workspace entry quota was exceeded")
        if total + new_bytes > self._workspace_limit:
            raise ValueError("Analysis Workspace byte quota was exceeded")


def _validate_id(value: str, label: str) -> str:
    if re.fullmatch(_ID_RE, value) is None:
        raise ValueError(f"{label} must be an opaque lowercase identifier")
    return value


def _limit(limits: object | None, name: str, default: int) -> int:
    value = getattr(limits, name, default) if limits is not None else default
    if not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _repositories(
    value: Mapping[str, tuple[str, Path]] | None,
) -> dict[str, tuple[str, Path]]:
    if value is None:
        return {}
    result = {}
    for repository_id, item in value.items():
        revision, root = item
        result[_validate_id(str(repository_id), "repository_id")] = (
            str(revision).lower(),
            Path(root).resolve(strict=True),
        )
    return result


def _artifact_bytes(value: bytes | str, max_bytes: int) -> bytes:
    if isinstance(value, bytes):
        return value
    encoded = value.encode("utf-8")
    if len(encoded) > max_bytes:
        raise ValueError("Analysis artifact exceeds the configured byte limit")
    return encoded


def _bounded_utf8_slice(raw: bytes, offset: int, limit: int) -> tuple[int, str]:
    end = min(len(raw), offset + limit)
    start = offset
    while start < end and (raw[start] & 0xC0) == 0x80:
        start += 1
    while end <= len(raw):
        try:
            return end, raw[start:end].decode("utf-8")
        except UnicodeDecodeError:
            end += 1
    raise ValueError("Analysis artifact is not UTF-8 Markdown")


def _write_atomic(path: Path, data: bytes, max_bytes: int, label: str) -> None:
    from ..filesystem import write_bytes_atomically

    write_bytes_atomically(path, data, max_bytes=max_bytes, label=label)


__all__ = [
    "AnalysisReceipt",
    "AnalysisWorkspace",
    "ArtifactSlice",
    "HandoffRef",
    "ReceiptArtifact",
    "ReceiptEvidence",
]
