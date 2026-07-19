"""Analysis Workspace receipt and artifact tests."""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

import pytest

from okf_wiki.run import (
    AnalysisReceipt,
    AnalysisWorkspace,
    WikiRunLimits,
    ReceiptArtifact,
    ReceiptEvidence,
    HandoffRef,
)

from wiki_run_helpers import (
    _minimal_receipt,
    make_repository,
)


def test_analysis_workspace_publishes_and_reads_an_immutable_receipt_and_artifact(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "first\nsecond\nthird\n")
    cited = b"second\n"
    artifact = b"# Findings\n"
    receipt = AnalysisReceipt(
        run_id="run-1",
        node_id="node-1",
        attempt=1,
        status="complete",
        scope="README evidence",
        source_revision=revision,
        summary="One bounded finding",
        findings=["The second line is present."],
        evidence=[
            ReceiptEvidence(
                repository_id="source",
                source_revision=revision,
                path="README.md",
                line_start=2,
                line_end=2,
                claim="The second line is present.",
                sha256=hashlib.sha256(cited).hexdigest(),
            )
        ],
        artifacts=[
            ReceiptArtifact(
                path="findings.md",
                media_type="text/markdown",
                bytes=len(artifact),
                sha256=hashlib.sha256(artifact).hexdigest(),
            )
        ],
    )

    workspace_root = tmp_path / "analysis"
    with AnalysisWorkspace(
        "run-1",
        root=workspace_root,
        repositories={"source": (revision, source)},
    ) as workspace:
        workspace.register_node("node-1", "node-1")
        handoff = workspace.publish_receipt(receipt, artifacts={"findings.md": artifact})
        loaded = workspace.read_receipt(handoff)
        assert isinstance(handoff, HandoffRef)
        assert handoff.schema == "okf.analysis.handoff/v1"
        assert handoff.status == "complete"
        assert handoff.receipt.startswith("receipts/node-1/")
        assert loaded.schema == "okf.analysis.receipt/v1"
        assert loaded.run_id == "run-1"
        assert loaded.evidence == receipt.evidence
        assert loaded.artifacts[0].path.startswith("artifacts/node-1/")
        assert workspace.read_receipt(handoff) == loaded
        first_slice = workspace.read_artifact(handoff, loaded.artifacts[0].path, limit=5)
        assert first_slice.data == artifact.decode()[:5]
        assert first_slice.complete is False
        second_slice = workspace.read_artifact(
            handoff,
            loaded.artifacts[0].path,
            offset=first_slice.next_offset,
        )
        assert first_slice.data + second_slice.data == artifact.decode()
        assert second_slice.complete is True

    assert not workspace_root.exists()


@pytest.mark.parametrize(
    "change",
    [
        "revision",
        "hash",
        "line_range",
        "symlink",
    ],
)
def test_analysis_workspace_rejects_untrusted_evidence(change: str, tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "first\nsecond\n")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    if change == "symlink":
        (source / "escape.md").symlink_to(outside)
    path = "escape.md" if change == "symlink" else "README.md"
    cited = b"second\n"
    evidence = ReceiptEvidence(
        repository_id="source",
        source_revision=("0" * 40 if change == "revision" else revision),
        path=path,
        line_start=2,
        line_end=(3 if change == "line_range" else 2),
        claim="claim",
        sha256=("0" * 64 if change == "hash" else hashlib.sha256(cited).hexdigest()),
    )
    receipt = AnalysisReceipt(
        run_id="run-1",
        node_id="node-1",
        attempt=1,
        status="complete",
        scope="scope",
        source_revision=revision,
        evidence=[evidence],
    )
    with AnalysisWorkspace(
        "run-1",
        root=tmp_path / "analysis",
        repositories={"source": (revision, source)},
    ) as workspace:
        workspace.register_node("node-1", "node-1")
        with pytest.raises(ValueError, match="evidence"):
            workspace.publish_receipt(receipt)
        assert not list((workspace.root / "receipts").rglob("*.json"))


@pytest.mark.parametrize(
    "path", ["../README.md", "/tmp/README.md", "a\\b.md", " README.md ", "README.md\x00"]
)
def test_analysis_receipt_rejects_noncanonical_paths(path: str) -> None:
    with pytest.raises(ValueError, match="canonical relative"):
        ReceiptEvidence(
            source_revision="0" * 40,
            path=path,
            line_start=1,
            line_end=1,
            claim="claim",
            sha256="0" * 64,
        )


def test_analysis_workspace_binds_host_assigned_task_identity(tmp_path: Path) -> None:
    workspace = AnalysisWorkspace("run-1", root=tmp_path / "analysis")
    workspace.register_node("task-a", "node-a")
    with pytest.raises(ValueError, match="identity"):
        workspace.publish_receipt(
            _minimal_receipt(node_id="node-b"),
            task_id="task-a",
        )
    handoff = workspace.publish_receipt(
        _minimal_receipt(node_id="node-a"),
        task_id="task-a",
    )
    with pytest.raises(ValueError, match="attempt"):
        workspace.publish_receipt(
            _minimal_receipt(node_id="node-a", attempt=3),
            task_id="task-a",
        )
    with pytest.raises(ValueError, match="does not match"):
        workspace.read_receipt(
            HandoffRef(
                task_id="task-b",
                node_id="node-a",
                attempt=1,
                status="complete",
                summary="",
                receipt=handoff.receipt,
            )
        )
    workspace.cleanup()


def test_analysis_workspace_accepts_only_markdown_artifacts() -> None:
    with pytest.raises(ValueError, match="Markdown"):
        ReceiptArtifact(
            path="payload.bin",
            media_type="text/markdown",
            bytes=1,
            sha256=hashlib.sha256(b"x").hexdigest(),
        )


def test_analysis_workspace_artifact_slices_preserve_utf8_boundaries(tmp_path: Path) -> None:
    artifact = "éclair".encode("utf-8")
    receipt = _minimal_receipt().model_copy(
        update={
            "artifacts": [
                ReceiptArtifact(
                    path="findings.md",
                    media_type="text/markdown",
                    bytes=len(artifact),
                    sha256=hashlib.sha256(artifact).hexdigest(),
                )
            ]
        }
    )
    with AnalysisWorkspace("run-1", root=tmp_path / "analysis") as workspace:
        workspace.register_node("node-1", "node-1")
        handoff = workspace.publish_receipt(receipt, artifacts={"findings.md": artifact})
        loaded = workspace.read_receipt(handoff)
        first = workspace.read_artifact(handoff, loaded.artifacts[0].path, limit=1)
        assert first.data == "é"
        assert first.next_offset == len("é".encode())


def test_analysis_workspace_enforces_receipt_artifact_and_workspace_quotas(
    tmp_path: Path,
) -> None:
    # Keep construction explicit so the quota is tested at publication, not schema parsing.
    oversized = AnalysisReceipt(
        run_id="run-1",
        node_id="node-1",
        attempt=1,
        status="complete",
        scope="scope",
        summary="x" * 500,
    )
    with AnalysisWorkspace(
        "run-1",
        root=tmp_path / "receipt-limit",
        limits=WikiRunLimits(analysis_receipt_bytes_limit=200),
    ) as workspace:
        workspace.register_node("node-1", "node-1")
        with pytest.raises(ValueError, match="Receipt"):
            workspace.publish_receipt(oversized)

    artifact = b"artifact"
    with AnalysisWorkspace(
        "run-1",
        root=tmp_path / "artifact-limit",
        limits=WikiRunLimits(analysis_artifact_bytes_limit=3),
    ) as workspace:
        workspace.register_node("node-1", "node-1")
        receipt = _minimal_receipt()
        receipt = receipt.model_copy(
            update={
                "artifacts": [
                    ReceiptArtifact(
                        path="a.md",
                        media_type="text/markdown",
                        bytes=len(artifact),
                        sha256=hashlib.sha256(artifact).hexdigest(),
                    )
                ]
            }
        )
        with pytest.raises(ValueError, match="artifact"):
            workspace.publish_receipt(receipt, artifacts={"a.md": artifact})

    with AnalysisWorkspace(
        "run-1",
        root=tmp_path / "entry-limit",
        limits=WikiRunLimits(analysis_workspace_entries_limit=1),
    ) as workspace:
        workspace.register_node("node-1", "node-1")
        workspace.register_node("node-2", "node-2")
        workspace.publish_receipt(_minimal_receipt())
        with pytest.raises(ValueError, match="entry quota"):
            workspace.publish_receipt(_minimal_receipt(node_id="node-2"))


def test_analysis_workspace_publication_is_atomic_and_attempts_are_immutable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = AnalysisWorkspace("run-1", root=tmp_path / "analysis")
    workspace.register_node("node-1", "node-1")
    receipt = _minimal_receipt()

    def fail_replace(_: str | os.PathLike[str], __: str | os.PathLike[str]) -> None:
        raise OSError("injected replacement failure")

    monkeypatch.setattr("okf_wiki.run.filesystem.os.replace", fail_replace)
    with pytest.raises(OSError, match="replacement"):
        workspace.publish_receipt(receipt)
    assert not list(workspace.root.rglob("*.json"))
    assert not list(workspace.root.rglob("*.tmp"))

    monkeypatch.undo()
    handoff = workspace.publish_receipt(receipt)
    with pytest.raises(ValueError, match="already been published"):
        workspace.publish_receipt(receipt)
    with pytest.raises(ValueError, match="does not match"):
        workspace.read_receipt(
            HandoffRef(
                task_id="node-1",
                node_id="node-1",
                attempt=1,
                status="partial",
                summary="",
                receipt=handoff.receipt,
            )
        )
    workspace.cleanup()


def test_analysis_workspace_can_be_retained_only_explicitly(tmp_path: Path) -> None:
    root = tmp_path / "retained"
    workspace = AnalysisWorkspace("run-1", root=root, retain=True)
    workspace.register_node("node-1", "node-1")
    workspace.publish_receipt(_minimal_receipt())
    workspace.cleanup()
    assert root.exists()
    shutil.rmtree(root)

    generated = AnalysisWorkspace("run-2", retain=True)
    generated.register_node("node-1", "node-1")
    generated_root = generated.root
    generated.cleanup()
    assert generated_root.exists()
    shutil.rmtree(generated_root)
