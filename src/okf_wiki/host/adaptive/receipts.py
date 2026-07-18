"""Host-mediated receipt toolset and failure-receipt helpers."""

from __future__ import annotations

import hashlib
from typing import Literal

from pydantic_ai import FunctionToolset, ModelRetry
from pydantic_ai.tools import RunContext

from ..analysis.workspace import (
    AnalysisReceipt,
    HandoffRef,
    ReceiptArtifact,
    ReceiptEvidence,
)
from .deps import AdaptiveDeps


class _ReceiptToolset(FunctionToolset[AdaptiveDeps]):
    """Host-mediated receipt access; no Analysis Workspace mount is exposed."""

    def __init__(self) -> None:
        super().__init__(sequential=True)
        self.add_function(self.publish_receipt, name="publish_receipt")
        self.add_function(self.publish_fallback_receipt, name="publish_fallback_receipt")
        self.add_function(self.read_receipt, name="read_receipt")
        self.add_function(self.read_artifact, name="read_artifact")

    def publish_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        run_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        scope: str,
        parent_id: str | None = None,
        source_revision: str | None = None,
        summary: str = "",
        findings: list[str] | None = None,
        evidence: list[ReceiptEvidence] | None = None,
        child_receipts: list[str] | None = None,
        open_questions: list[str] | None = None,
        artifact_name: str | None = None,
        artifact_markdown: str | None = None,
    ) -> str:
        deps = _require_deps(ctx)
        if run_id != deps.run_id or node_id != deps.node_id or parent_id != deps.parent_id:
            raise ModelRetry("Receipt identity does not match the Host assignment")
        if attempt != deps.attempt:
            raise ModelRetry(f"Use the Host-assigned receipt attempt {deps.attempt}")
        if (artifact_name is None) != (artifact_markdown is None):
            raise ModelRetry("Provide both artifact_name and artifact_markdown, or neither")
        artifacts: dict[str, str] = {}
        descriptors: list[ReceiptArtifact] = []
        if artifact_name is not None and artifact_markdown is not None:
            raw = artifact_markdown.encode("utf-8")
            descriptors.append(
                ReceiptArtifact(
                    path=artifact_name,
                    media_type="text/markdown",
                    bytes=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                )
            )
            artifacts[artifact_name] = artifact_markdown
        receipt = AnalysisReceipt(
            run_id=run_id,
            node_id=node_id,
            parent_id=parent_id,
            attempt=attempt,
            status=status,
            scope=scope,
            source_revision=source_revision,
            summary=summary,
            findings=findings or [],
            evidence=evidence or [],
            child_receipts=child_receipts or [],
            artifacts=descriptors,
            open_questions=open_questions or [],
        )
        return self._publish(deps, receipt, task_id=deps.task_id, artifacts=artifacts, current=True)

    def publish_fallback_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        run_id: str,
        task_id: str,
        node_id: str,
        parent_id: str,
        attempt: int,
        scope: str,
        source_revision: str | None = None,
        summary: str = "",
        findings: list[str] | None = None,
        evidence: list[ReceiptEvidence] | None = None,
        child_receipts: list[str] | None = None,
        open_questions: list[str] | None = None,
        artifact_name: str | None = None,
        artifact_markdown: str | None = None,
    ) -> str:
        """Publish a complete receipt for a failed child after bounded retries."""
        deps = _require_deps(ctx)
        if deps.role == "leaf":
            raise ModelRetry("Leaf agents cannot perform direct fallback research")
        if run_id != deps.run_id:
            raise ModelRetry("Fallback receipt run_id does not match the Host assignment")
        if deps.metrics.node_parents.get(node_id) != deps.node_id:
            raise ModelRetry("Fallback target is not an assigned child of this Host")
        if parent_id != deps.node_id:
            raise ModelRetry("Fallback parent_id does not match the Host assignment")
        if task_id != node_id:
            raise ModelRetry("Fallback task_id and node_id must match the Host assignment")
        if attempt != deps.metrics.next_attempts.get(node_id):
            expected = deps.metrics.next_attempts.get(node_id, 1)
            raise ModelRetry(f"Use the Host-assigned fallback receipt attempt {expected}")
        if (artifact_name is None) != (artifact_markdown is None):
            raise ModelRetry("Provide both artifact_name and artifact_markdown, or neither")
        artifacts: dict[str, str] = {}
        descriptors: list[ReceiptArtifact] = []
        if artifact_name is not None and artifact_markdown is not None:
            raw = artifact_markdown.encode("utf-8")
            descriptors.append(
                ReceiptArtifact(
                    path=artifact_name,
                    media_type="text/markdown",
                    bytes=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                )
            )
            artifacts[artifact_name] = artifact_markdown
        receipt = AnalysisReceipt(
            run_id=run_id,
            node_id=node_id,
            parent_id=parent_id,
            attempt=attempt,
            status="complete",
            scope=scope,
            source_revision=source_revision,
            summary=summary,
            findings=findings or [],
            evidence=evidence or [],
            child_receipts=child_receipts or [],
            artifacts=descriptors,
            open_questions=open_questions or [],
        )
        try:
            deps.metrics.mark_direct_fallback(node_id)
            return self._publish(
                deps, receipt, task_id=task_id, artifacts=artifacts, current=False, fallback=True
            )
        except Exception:
            # Do not let a failed publication make an incomplete branch appear complete.
            deps.metrics.node_states[node_id] = "failed"
            deps.metrics.next_attempts[node_id] = attempt
            deps.metrics.direct_fallbacks = max(0, deps.metrics.direct_fallbacks - 1)
            raise

    def _publish(
        self,
        deps: AdaptiveDeps,
        receipt: AnalysisReceipt,
        *,
        task_id: str,
        artifacts: dict[str, str],
        current: bool,
        fallback: bool = False,
    ) -> str:
        handoff = deps.workspace.publish_receipt(receipt, task_id=task_id, artifacts=artifacts)
        if current:
            deps.published = handoff
        receipt_size = 0
        try:
            receipt_size = (deps.workspace.root / handoff.receipt).stat().st_size
        except OSError:
            pass
        deps.emit(
            "receipt_published",
            {
                "depth": deps.depth,
                "status": handoff.status,
                "receipt_bytes": receipt_size,
                "fallback": fallback,
            },
            node_id=receipt.node_id,
        )
        return handoff.model_dump_json()

    def read_receipt(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        task_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        receipt: str,
    ) -> str:
        deps = _require_deps(ctx)
        handoff = HandoffRef(
            task_id=task_id,
            node_id=node_id,
            attempt=attempt,
            status=status,
            receipt=receipt,
        )
        if deps.role != "root":
            allowed = handoff.task_id == deps.task_id or handoff.task_id.startswith(
                f"{deps.task_id}-leaf-"
            )
            if not allowed:
                raise ModelRetry("Receipt access is limited to this task and its assigned children")
        loaded = deps.workspace.read_receipt(handoff)
        # The Analysis Workspace already enforces the canonical 128 KiB receipt cap.
        return loaded.model_dump_json(by_alias=True)

    def read_artifact(
        self,
        ctx: RunContext[AdaptiveDeps],
        *,
        task_id: str,
        node_id: str,
        attempt: int,
        status: Literal["complete", "partial", "failed", "cancelled"],
        receipt: str,
        path: str,
        offset: int = 0,
        limit: int = 64 * 1024,
    ) -> str:
        deps = _require_deps(ctx)
        handoff = HandoffRef(
            task_id=task_id,
            node_id=node_id,
            attempt=attempt,
            status=status,
            receipt=receipt,
        )
        if deps.role != "root":
            allowed = handoff.task_id == deps.task_id or handoff.task_id.startswith(
                f"{deps.task_id}-leaf-"
            )
            if not allowed:
                raise ModelRetry(
                    "Artifact access is limited to this task and its assigned children"
                )
        return deps.workspace.read_artifact(
            handoff, path, offset=offset, limit=limit
        ).model_dump_json()


def _require_deps(ctx: RunContext[AdaptiveDeps]) -> AdaptiveDeps:
    if not isinstance(ctx.deps, AdaptiveDeps):
        raise ModelRetry("Host orchestration dependencies are unavailable; stop delegation")
    return ctx.deps


def _publish_failure_receipt(
    deps: AdaptiveDeps, status: Literal["failed", "cancelled"], reason: str
) -> None:
    """Leave a bounded host receipt when a child exits before publishing one."""
    if deps.published is not None:
        return
    try:
        receipt = AnalysisReceipt(
            run_id=deps.run_id,
            node_id=deps.node_id,
            parent_id=deps.parent_id,
            attempt=deps.attempt,
            status=status,
            scope=f"{deps.role}:{deps.task_id}",
            summary="Child execution did not produce a complete research receipt.",
            open_questions=[reason],
        )
        handoff = deps.workspace.publish_receipt(receipt, task_id=deps.task_id)
        deps.published = handoff
        receipt_size = 0
        try:
            receipt_size = (deps.workspace.root / handoff.receipt).stat().st_size
        except OSError:
            pass
        deps.emit(
            "receipt_published",
            {"depth": deps.depth, "status": handoff.status, "receipt_bytes": receipt_size},
            node_id=deps.node_id,
        )
    except Exception:
        # The original child error remains authoritative; diagnostics must not mask it.
        pass


__all__ = [
    "_ReceiptToolset",
    "_publish_failure_receipt",
    "_require_deps",
]
