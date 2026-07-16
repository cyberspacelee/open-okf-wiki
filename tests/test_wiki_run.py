import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai import Agent, ModelRequest, ModelResponse, ToolCallPart, UnexpectedModelBehavior
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.instrumented import InstrumentationSettings

from okf_wiki.cli import main, parser
from okf_wiki.security import MAX_ANALYZABLE_FILE_BYTES
from okf_wiki.wiki_run import (
    AnalysisReceipt,
    AnalysisWorkspace,
    Complete,
    ModelProviderConfig,
    NeedsInput,
    ProducerSkillFork,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiManifest,
    WikiChangeSummary,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunEvent,
    WikiRunResourceLimitError,
    WikiRunRequest,
    ReceiptArtifact,
    ReceiptEvidence,
    HandoffRef,
    _materialize_repository_snapshot,
)


REQUIRED_PRODUCER_SKILL_PATHS = {
    "SKILL.md",
    "references/domain-research.md",
    "references/generate.md",
    "references/leaf-research.md",
    "references/refresh.md",
    "references/review.md",
    "templates/architecture.md",
    "templates/concept.md",
    "templates/flow.md",
    "templates/module.md",
    "templates/overview.md",
}


def make_repository(path: Path, source_text: str) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text(source_text, encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def make_published_wiki(path: Path) -> Path:
    release = path.parent / f".{path.name}.releases" / "old"
    release.mkdir(parents=True)
    (release / "index.md").write_text("old publication\n", encoding="utf-8")
    path.symlink_to(os.path.relpath(release, path.parent), target_is_directory=True)
    return release


def make_producer_skill(path: Path) -> ProducerSkillVersion:
    return ProducerSkillFork.create(ProducerSkillVersion.default(), path).version()


def writing_model(
    code: str, pages: list[str], *, summary: dict[str, object] | None = None
) -> FunctionModel:
    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            payload: dict[str, object] = {
                "status": "complete",
                "manifest": {"pages": pages},
            }
            if summary is not None:
                payload["summary"] = summary
            return ModelResponse(parts=[ToolCallPart(complete.name, payload)])
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    return FunctionModel(model)


TEST_WIKI_LIMITS = WikiRunLimits(
    request_limit=3,
    tool_calls_limit=2,
    retries=0,
    request_timeout_seconds=5,
    tool_timeout_seconds=5,
)
SIMPLE_WIKI_PAGE = "---\ntitle: Wiki\n---\n# Wiki\n\n[Source](repo:README.md#L1-L1)\n"


def write_pages_code(pages: dict[str, str]) -> str:
    return "from pathlib import Path\n" + "\n".join(
        f"Path('/wiki/{path}').write_text({content!r})" for path, content in pages.items()
    )


def run_test_wiki(
    source: Path,
    revision: str,
    skill: ProducerSkillVersion,
    staging: Path,
    publication: Path,
    model: FunctionModel,
    *,
    operation: Literal["generate", "refresh"] = "generate",
) -> Complete | NeedsInput:
    return asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                operation=operation,
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(model=model),
                limits=TEST_WIKI_LIMITS,
                staging=staging,
                publication=publication,
            )
        )
    )


def publish_test_pages(
    source: Path,
    revision: str,
    skill: ProducerSkillVersion,
    staging: Path,
    publication: Path,
    pages: dict[str, str],
) -> Complete | NeedsInput:
    return run_test_wiki(
        source,
        revision,
        skill,
        staging,
        publication,
        writing_model(write_pages_code(pages), list(pages)),
    )


def generated_test_wiki(
    tmp_path: Path, page: str = SIMPLE_WIKI_PAGE
) -> tuple[Path, str, ProducerSkillFork, Path]:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    publication = tmp_path / "published"
    publish_test_pages(
        source,
        revision,
        fork.version(),
        tmp_path / "generate-staging",
        publication,
        {"index.md": page},
    )
    return source, revision, fork, publication


def publication_state(publication: Path) -> tuple[str, Path, list[str], dict[str, bytes]]:
    release = publication.resolve()
    files = {
        path.relative_to(release).as_posix(): path.read_bytes()
        for path in release.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    return (
        os.readlink(publication),
        release,
        sorted(path.name for path in release.parent.iterdir()),
        files,
    )


def run_records(publication: Path) -> list[dict[str, Any]]:
    directory = publication.parent / f".{publication.name}.runs"
    return [json.loads(path.read_bytes()) for path in sorted(directory.glob("*.json"))]


def analysis_workspace_paths(run_id: str) -> set[Path]:
    return set(Path(tempfile.gettempdir()).glob(f"okf-analysis-{run_id[:8]}-*"))


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


def _minimal_receipt(
    run_id: str = "run-1", node_id: str = "node-1", attempt: int = 1
) -> AnalysisReceipt:
    return AnalysisReceipt(
        run_id=run_id,
        node_id=node_id,
        attempt=attempt,
        status="complete",
        scope="scope",
        summary="bounded summary",
    )


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

    monkeypatch.setattr("okf_wiki.analysis_workspace.os.replace", fail_replace)
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


def test_default_producer_skill_is_a_complete_content_addressed_version() -> None:
    version = ProducerSkillVersion.default()

    assert {
        path.relative_to(version.path).as_posix()
        for path in version.path.rglob("*")
        if path.is_file()
    } == REQUIRED_PRODUCER_SKILL_PATHS
    assert version.digest == "77880859f9ee6be22e4a8112c9afae757ef2a55df499c5b68762d9b5cbea7c52"


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("missing", "missing required file: references/generate.md"),
        ("unreadable", "unreadable file: references/generate.md"),
        ("malformed", "SKILL.md has invalid YAML frontmatter"),
        ("ambiguous", "ambiguous paths"),
    ],
)
def test_wiki_run_rejects_an_invalid_skill_before_model_work(
    tmp_path: Path, case: str, message: str
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    version = fork.version()
    if case == "missing":
        (fork.path / "references/generate.md").unlink()
    elif case == "unreadable":
        (fork.path / "references/generate.md").chmod(0)
    elif case == "malformed":
        (fork.path / "SKILL.md").write_text("---\nname: [\n---\nBroken\n", encoding="utf-8")
    else:
        (fork.path / "references/GENERATE.md").write_text("# Ambiguous\n", encoding="utf-8")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an invalid Producer Skill")

    with pytest.raises(ValueError, match=message):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )

    assert not model_called


def test_wiki_run_rejects_a_changed_selected_skill_version_before_model_work(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    selected = fork.version()
    template = fork.path / "templates/overview.md"
    template.write_text(template.read_text(encoding="utf-8") + "\nAudience: operators\n")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run with a changed Skill Version")

    with pytest.raises(ValueError, match="Selected Skill Version content changed"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=selected,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )

    assert not model_called


def test_skill_fork_is_an_owned_copy_that_product_versions_cannot_overwrite(
    tmp_path: Path,
) -> None:
    default = ProducerSkillVersion.default()
    default_template = (default.path / "templates/overview.md").read_text(encoding="utf-8")
    fork = ProducerSkillFork.create(default, tmp_path / "my-skill")
    fork_template = fork.path / "templates/overview.md"
    customized = default_template + "\nAudience: maintainers\n"
    fork_template.write_text(customized, encoding="utf-8")

    with pytest.raises(ValueError, match="destination must not already exist"):
        ProducerSkillFork.create(default, fork.path)

    assert fork_template.read_text(encoding="utf-8") == customized
    assert (default.path / "templates/overview.md").read_text(encoding="utf-8") == default_template
    assert fork.version().digest != default.digest


def test_skill_fork_does_not_remove_a_competing_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "skill"
    marker = destination / "owned-by-competitor"
    mkdir = os.mkdir

    def race(path: str | os.PathLike[str], mode: int = 0o777) -> None:
        if Path(path) == destination:
            mkdir(path, mode)
            marker.write_text("keep\n", encoding="utf-8")
            raise FileExistsError(path)
        mkdir(path, mode)

    monkeypatch.setattr(os, "mkdir", race)

    with pytest.raises(ValueError, match="destination must not already exist"):
        ProducerSkillFork.create(ProducerSkillVersion.default(), destination)

    assert marker.read_text(encoding="utf-8") == "keep\n"


@pytest.mark.parametrize("customization_path", ["references/generate.md", "templates/overview.md"])
def test_skill_fork_customization_changes_wiki_output_through_the_same_run_seam(
    tmp_path: Path, customization_path: str
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    customizable = fork.path / customization_path

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": f"""from pathlib import Path
customization = Path('/skill/{customization_path}').read_text()
marker = [line[len('Customization: '):] for line in customization.splitlines() if line.startswith('Customization: ')][0]
Path('/wiki/index.md').write_text(f'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n{{marker}}\\n\\n[Source](repo:README.md#L1-L1)\\n')
""",
                    },
                )
            ]
        )

    application = WikiRunApplication()

    def run(version: ProducerSkillVersion, name: str) -> str:
        asyncio.run(
            application.run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / f"{name}-staging",
                    publication=tmp_path / f"{name}-published",
                )
            )
        )
        return (tmp_path / f"{name}-published/index.md").read_text(encoding="utf-8")

    original = customizable.read_text(encoding="utf-8")
    customizable.write_text(original + "\nCustomization: platform team\n", encoding="utf-8")
    first = run(fork.version(), "first")
    customizable.write_text(original + "\nCustomization: library users\n", encoding="utf-8")
    second = run(fork.version(), "second")

    assert "platform team" in first
    assert "library users" in second
    assert first != second


def test_complete_wiki_run_validates_and_atomically_publishes_pages(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "# Example\n\nSource fact.\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {
                            "status": "complete",
                            "manifest": {"pages": ["index.md", "architecture.md"]},
                        },
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": """from pathlib import Path
Path('/wiki/index.md').write_text('''---
title: Example Wiki
---
# Example Wiki

[Architecture](architecture.md#architecture)

[Source](repo:README.md#L1-L3)
''')
Path('/wiki/architecture.md').write_text('''---
title: Architecture
---
# Architecture

[Home](index.md#example-wiki)

[Source](repo:README.md#L3-L3)
''')
"""
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=3,
                    tool_calls_limit=2,
                    retries=1,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=staging,
                publication=published,
            )
        )
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md", "architecture.md"]),
        summary=WikiChangeSummary(
            added=["architecture.md", "index.md"],
            content_changed=True,
            publication_changed=True,
        ),
    )
    assert published.is_symlink()
    assert published.resolve() != old_release
    assert (old_release / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert (published / "index.md").is_file()
    assert (published / "architecture.md").is_file()
    metadata = json.loads((published / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata == {
        "content_digest": "14c2fd1d8457426f3cc295b29a454cda8dbc89530ea7a9a86a1ba5cad8850c31",
        "generated_at": metadata["generated_at"],
        "model": "function:model:",
        "pages": [
            {
                "path": "architecture.md",
                "sha256": "57fa785fb701f4d2f0a7dfe27b9402d9060989ab637c7b3cde51026fd54e640e",
            },
            {
                "path": "index.md",
                "sha256": "4873cca881fd27de06dd9358471107e5c510898bf1c9a6239b6a3b47451461ac",
            },
        ],
        "repositories": [
            {"id": "source", "ignore": [], "revision": source_revision},
        ],
        "skill_digest": skill_version.digest,
    }
    assert datetime.fromisoformat(metadata["generated_at"]).tzinfo == UTC


def test_complete_wiki_run_emits_ordered_bounded_public_events(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    events: list[WikiRunEvent] = []

    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
            )
        )
    )

    assert isinstance(result, Complete)
    assert [event.type for event in events] == [
        "run_created",
        "snapshots_frozen",
        "skill_frozen",
        "validation_started",
        "validation_succeeded",
        "publication_started",
        "publication_succeeded",
        "run_succeeded",
    ]
    assert len({event.run_id for event in events}) == 1
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    assert {event.node_id for event in events} == {"root"}
    assert all(len(event.model_dump_json().encode()) <= 8_192 for event in events)
    assert analysis_workspace_paths(events[0].run_id) == set()


def test_complete_wiki_run_writes_a_bounded_secret_free_terminal_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    secret = "private-run-record-header"
    monkeypatch.setenv("OKF_RECORD_TOKEN", secret)
    events: list[WikiRunEvent] = []

    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(
                    RepositorySnapshot(
                        id="repo",
                        path=source,
                        revision=revision,
                        ignore=("generated/**",),
                    ),
                ),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    ),
                    settings={
                        "temperature": 0.25,
                        "stop_sequences": [secret],
                        "extra_headers": {"Authorization": f"Bearer {secret}"},
                    },
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
            )
        )
    )

    [record] = run_records(publication)
    encoded = json.dumps(record, sort_keys=True).encode()
    assert isinstance(result, Complete)
    assert record["schema_version"] == 1
    assert record["run_id"] == events[0].run_id
    assert record["status"] == "complete"
    assert record["operation"] == "generate"
    assert record["repositories"] == [
        {
            "id": "repo",
            "path": str(source.resolve()),
            "revision": revision,
            "ignore": ["generated/**"],
        }
    ]
    assert record["skill"] == {"path": str(skill.path), "digest": skill.digest}
    assert record["model"] == {
        "identity": "function:model:",
        "replayable": False,
        "settings": {
            "temperature": 0.25,
            "stop_sequences": ["[REDACTED CREDENTIAL]"],
            "extra_headers": "[redacted]",
        },
    }
    assert record["limits"] == TEST_WIKI_LIMITS.model_dump(mode="json")
    assert record["explicit_answers"] == {}
    assert record["usage"]["requests"] == 2
    assert record["retry_counters"] == {
        "provider": 0,
        "provider_attempts": 0,
        "provider_possible_duplicates": 0,
        "tool": 0,
        "output": 0,
    }
    assert record["publication"] == {"status": "published", "changed": True}
    assert record["failure_category"] is None
    assert datetime.fromisoformat(record["started_at"]).tzinfo == UTC
    assert datetime.fromisoformat(record["completed_at"]).tzinfo == UTC
    assert record["duration_seconds"] >= 0
    assert len(encoded) <= 128 * 1024
    assert secret.encode() not in encoded


def test_record_write_failure_is_observable_without_changing_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    events: list[WikiRunEvent] = []

    def fail_record(*_: object, **__: object) -> None:
        raise OSError("record storage unavailable")

    monkeypatch.setattr("okf_wiki.wiki_run._write_run_record", fail_record)
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
            )
        )
    )

    assert isinstance(result, Complete)
    assert (publication / "index.md").is_file()
    assert events[-1].type == "run_record_failed"


def test_early_wiki_run_failure_still_writes_a_terminal_record(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    events: list[WikiRunEvent] = []

    with pytest.raises(ValueError, match="overlap"):
        asyncio.run(
            WikiRunApplication(observer=events.append).run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(model="test:model"),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=source,
                )
            )
        )

    records = run_records(source)
    assert len(records) == 1
    assert records[0]["status"] == "failed"
    assert events[-1].type == "run_failed"


def test_needs_input_emits_a_terminal_event_and_record(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    events: list[WikiRunEvent] = []

    def model(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        needs_input = next(tool for tool in info.output_tools if tool.name.endswith("NeedsInput"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    needs_input.name,
                    {"status": "needs_input", "questions": ["Which audience?"]},
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
            )
        )
    )

    [record] = run_records(publication)
    assert result == NeedsInput(questions=["Which audience?"])
    assert [event.type for event in events] == [
        "run_created",
        "snapshots_frozen",
        "skill_frozen",
        "needs_input",
    ]
    assert record["status"] == "needs_input"
    assert record["publication"] == {"status": "not_published", "changed": False}


def test_failed_wiki_run_emits_a_terminal_event_and_secret_free_record(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    secret = "record-failure-secret"
    events: list[WikiRunEvent] = []

    def observe(event: WikiRunEvent) -> None:
        events.append(event)
        raise RuntimeError("observer failure")

    def fail(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"provider failed with {secret}")

    with pytest.raises(RuntimeError, match="diagnostics withheld"):
        asyncio.run(
            WikiRunApplication(observer=observe).run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=FunctionModel(fail),
                        settings={"extra_headers": {"Authorization": secret}},
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=publication,
                )
            )
        )

    [record] = run_records(publication)
    assert record["status"] == "failed"
    assert record["failure_category"] == "RuntimeError"
    assert secret.encode() not in json.dumps(record).encode()
    assert analysis_workspace_paths(events[0].run_id) == set()


def test_cancelled_wiki_run_emits_a_terminal_event_and_record(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    events: list[WikiRunEvent] = []
    started = asyncio.Event()

    async def slow(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        started.set()
        await asyncio.Event().wait()
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name,
                    {"status": "complete", "manifest": {"pages": ["index.md"]}},
                )
            ]
        )

    async def scenario() -> None:
        task = asyncio.create_task(
            WikiRunApplication(observer=events.append).run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(model=FunctionModel(slow)),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=publication,
                )
            )
        )
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    [record] = run_records(publication)
    assert record["status"] == "cancelled"
    assert events[-1].type == "run_cancelled"
    assert analysis_workspace_paths(events[0].run_id) == set()


def test_refresh_replaces_the_complete_wiki_and_reports_mechanical_changes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    source_revision = make_repository(
        source,
        "# Example\n\nOld architecture.\nLegacy flow.\nStable concept.\n",
    )
    (source / "legacy.txt").write_text("legacy source\n", encoding="utf-8")
    subprocess.run(["git", "add", "legacy.txt"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "legacy source"], cwd=source, check=True)
    source_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), skill)
    skill_version = fork.version()
    old_pages = {
        "index.md": """---
title: Example Wiki
---
# Example Wiki

[Architecture](architecture.md#architecture)
[Legacy](legacy.md#legacy)
[Concept](concept.md#concept)

[Source](repo:README.md#L3-L3)
""",
        "architecture.md": """---
title: Architecture
---
# Architecture

[Home](index.md#example-wiki)

[Source](repo:README.md#L3-L3)
""",
        "legacy.md": """---
title: Legacy
---
# Legacy

[Home](index.md#example-wiki)

[Source](repo:legacy.txt#L1-L1)
""",
        "concept.md": """---
title: Concept
---
# Concept

[Home](index.md#example-wiki)

[Source](repo:README.md#L5-L5)
""",
    }

    publish_test_pages(
        source,
        source_revision,
        skill_version,
        tmp_path / "generate-staging",
        published,
        old_pages,
    )
    old_release = published.resolve()
    old_metadata = (old_release / ".okf-wiki.json").read_bytes()

    (source / "README.md").write_text(
        "# Example\n\nNew architecture.\nCurrent flow.\nStable concept.\n",
        encoding="utf-8",
    )
    (source / "legacy.txt").unlink()
    subprocess.run(["git", "add", "--all"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "refresh source"], cwd=source, check=True)
    source_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    refresh_guidance = fork.path / "references/refresh.md"
    refresh_guidance.write_text(
        refresh_guidance.read_text(encoding="utf-8") + "\nCustomization: audience-first\n",
        encoding="utf-8",
    )
    refreshed_skill = fork.version()
    refreshed_pages = {
        "index.md": """---
title: Example Wiki
---
# Example Wiki

audience-first

[Architecture](architecture.md#architecture)
[Flow](flow.md#flow)
[Concept](concept.md#concept)

[Source](repo:README.md#L3-L4)
""",
        "architecture.md": """---
title: Architecture
---
# Architecture

[Home](index.md#example-wiki)

[Source](repo:README.md#L3-L4)
""",
        "flow.md": """---
title: Flow
---
# Flow

[Home](index.md#example-wiki)

[Source](repo:README.md#L4-L4)
""",
    }
    refresh_code = (
        """from pathlib import Path
assert Path('/wiki/index.md').is_file()
assert Path('/wiki/architecture.md').is_file()
assert Path('/wiki/legacy.md').is_file()
assert Path('/wiki/concept.md').is_file()
assert not Path('/wiki/.okf-wiki.json').exists()
guidance = Path('/skill/references/refresh.md').read_text()
assert 'Customization: audience-first' in guidance
"""
        + "\n".join(
            f"Path('/wiki/{path}').write_text({content!r})"
            for path, content in refreshed_pages.items()
        )
        + "\nPath('/wiki/legacy.md').unlink()\n"
    )

    result = run_test_wiki(
        source,
        source_revision,
        refreshed_skill,
        tmp_path / "refresh-staging",
        published,
        writing_model(
            refresh_code,
            ["index.md", "architecture.md", "flow.md", "concept.md"],
        ),
        operation="refresh",
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md", "architecture.md", "flow.md", "concept.md"]),
        summary=WikiChangeSummary(
            added=["flow.md"],
            changed=["architecture.md", "index.md"],
            removed=["legacy.md"],
            unchanged=["concept.md"],
            content_changed=True,
            publication_changed=True,
        ),
    )
    assert published.resolve() != old_release
    assert (old_release / ".okf-wiki.json").read_bytes() == old_metadata
    assert not (published / "legacy.md").exists()
    assert "[Flow](flow.md#flow)" in (published / "index.md").read_text(encoding="utf-8")
    metadata = json.loads((published / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["repositories"] == [{"id": "source", "ignore": [], "revision": source_revision}]
    assert metadata["skill_digest"] == refreshed_skill.digest


def test_content_identical_refresh_is_a_true_publication_noop(tmp_path: Path) -> None:
    source, source_revision, fork, published = generated_test_wiki(tmp_path)
    skill_version = fork.version()
    pages = {"index.md": SIMPLE_WIKI_PAGE}
    before = publication_state(published)

    result = run_test_wiki(
        source,
        source_revision,
        skill_version,
        tmp_path / "refresh-staging",
        published,
        writing_model(write_pages_code(pages), ["index.md"]),
        operation="refresh",
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            unchanged=["index.md"],
            content_changed=False,
            publication_changed=False,
        ),
    )
    assert publication_state(published) == before


def test_refresh_with_different_revision_casing_is_a_true_publication_noop(
    tmp_path: Path,
) -> None:
    source, source_revision, fork, published = generated_test_wiki(tmp_path)
    before = publication_state(published)

    result = run_test_wiki(
        source,
        source_revision.upper(),
        fork.version(),
        tmp_path / "refresh-staging",
        published,
        writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]),
        operation="refresh",
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            unchanged=["index.md"],
            content_changed=False,
            publication_changed=False,
        ),
    )
    assert publication_state(published) == before


def test_refresh_can_overwrite_a_read_only_published_page(tmp_path: Path) -> None:
    source, source_revision, fork, published = generated_test_wiki(tmp_path)
    published_page = published.resolve() / "index.md"
    published_page.chmod(0o444)
    updated_page = SIMPLE_WIKI_PAGE.replace("# Wiki", "# Updated Wiki")

    result = run_test_wiki(
        source,
        source_revision,
        fork.version(),
        tmp_path / "refresh-staging",
        published,
        writing_model(write_pages_code({"index.md": updated_page}), ["index.md"]),
        operation="refresh",
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            changed=["index.md"],
            content_changed=True,
            publication_changed=True,
        ),
    )
    assert (published / "index.md").read_text(encoding="utf-8") == updated_page


@pytest.mark.parametrize("changed", ["source", "skill"])
def test_content_identical_refresh_publishes_changed_provenance(
    tmp_path: Path, changed: str
) -> None:
    source, source_revision, fork, published = generated_test_wiki(tmp_path)
    skill_version = fork.version()
    pages = {"index.md": SIMPLE_WIKI_PAGE}
    old_release = published.resolve()
    if changed == "source":
        (source / "README.md").write_text("updated source\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
        subprocess.run(["git", "commit", "-qm", "new revision"], cwd=source, check=True)
        source_revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    else:
        guidance = fork.path / "references/refresh.md"
        guidance.write_text(
            guidance.read_text(encoding="utf-8") + "\nAudience: operators\n",
            encoding="utf-8",
        )
        skill_version = fork.version()

    result = run_test_wiki(
        source,
        source_revision,
        skill_version,
        tmp_path / "refresh-staging",
        published,
        writing_model(write_pages_code(pages), ["index.md"]),
        operation="refresh",
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            unchanged=["index.md"],
            content_changed=False,
            publication_changed=True,
        ),
    )
    assert published.resolve() != old_release
    metadata = json.loads((published / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["repositories"] == [{"id": "source", "ignore": [], "revision": source_revision}]
    assert metadata["skill_digest"] == skill_version.digest


def test_refresh_requires_an_existing_producer_publication_before_model_work(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run without a current publication")

    with pytest.raises(ValueError, match="existing producer-managed Published Wiki"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            tmp_path / "published",
            FunctionModel(model),
            operation="refresh",
        )

    assert not model_called


@pytest.mark.parametrize("tamper", ["page", "symlink", "metadata", "extra"])
def test_refresh_rejects_a_tampered_producer_publication_before_model_work(
    tmp_path: Path, tamper: str
) -> None:
    source, revision, fork, published = generated_test_wiki(tmp_path)
    skill = fork.version()
    release = published.resolve()
    if tamper == "page":
        (release / "index.md").write_text("tampered\n", encoding="utf-8")
    elif tamper == "symlink":
        outside = tmp_path / "outside.md"
        outside.write_text(SIMPLE_WIKI_PAGE, encoding="utf-8")
        (release / "index.md").unlink()
        (release / "index.md").symlink_to(outside)
    elif tamper == "metadata":
        (release / ".okf-wiki.json").write_text("{}\n", encoding="utf-8")
    else:
        (release / "notes.txt").write_text("unexpected\n", encoding="utf-8")
    pointer = os.readlink(published)
    releases = sorted(path.name for path in release.parent.iterdir())
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run with a tampered publication")

    with pytest.raises(ValueError, match="Refresh Published Wiki"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "refresh-staging",
            published,
            FunctionModel(model),
            operation="refresh",
        )

    assert not model_called
    assert os.readlink(published) == pointer
    assert sorted(path.name for path in release.parent.iterdir()) == releases


def test_refresh_enforces_wiki_copy_ceilings_before_model_work(tmp_path: Path) -> None:
    source, revision, fork, published = generated_test_wiki(tmp_path)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an oversized Published Wiki")

    with pytest.raises(ValueError, match="Published Wiki page exceeds.*limit"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    operation="refresh",
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=fork.version(),
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(wiki_file_bytes_limit=10),
                    staging=tmp_path / "refresh-staging",
                    publication=published,
                )
            )
        )

    assert not model_called


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="platform has no no-follow open")
def test_refresh_rejects_a_page_swapped_for_a_symlink_during_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, revision, fork, published = generated_test_wiki(tmp_path)
    page = published.resolve() / "index.md"
    outside = tmp_path / "outside.md"
    outside.write_text(SIMPLE_WIKI_PAGE, encoding="utf-8")
    real_open = os.open
    swapped = False

    def swap_before_open(
        path: os.PathLike[str] | str, flags: int, *args: Any, **kwargs: Any
    ) -> int:
        nonlocal swapped
        if Path(path) == page and not swapped:
            page.unlink()
            page.symlink_to(outside)
            swapped = True
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", swap_before_open)

    with pytest.raises(ValueError, match="not a readable regular file"):
        run_test_wiki(
            source,
            revision,
            fork.version(),
            tmp_path / "refresh-staging",
            published,
            FunctionModel(
                lambda *_: (_ for _ in ()).throw(
                    AssertionError("model must not run after a publication page race")
                )
            ),
            operation="refresh",
        )

    assert swapped
    assert not (tmp_path / "refresh-staging/index.md").exists()


def test_refresh_rejects_a_model_supplied_change_summary(tmp_path: Path) -> None:
    old_page = "---\ntitle: Old\n---\n# Old\n\n[Source](repo:README.md#L1-L1)\n"
    new_page = "---\ntitle: New\n---\n# New\n\n[Source](repo:README.md#L1-L1)\n"
    source, revision, fork, published = generated_test_wiki(tmp_path, old_page)
    skill = fork.version()
    before = publication_state(published)

    with pytest.raises(UnexpectedModelBehavior, match="maximum output retries"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "refresh-staging",
            published,
            writing_model(
                write_pages_code({"index.md": new_page}),
                ["index.md"],
                summary={
                    "added": [],
                    "changed": [],
                    "removed": [],
                    "unchanged": ["index.md"],
                    "content_changed": False,
                    "publication_changed": False,
                },
            ),
            operation="refresh",
        )

    assert publication_state(published) == before


@pytest.mark.parametrize("failure", ["needs_input", "model", "validation"])
def test_refresh_semantic_and_model_failures_leave_the_publication_exactly_unchanged(
    tmp_path: Path, failure: str
) -> None:
    old_page = "---\ntitle: Old\n---\n# Old\n\n[Source](repo:README.md#L1-L1)\n"
    source, revision, fork, published = generated_test_wiki(tmp_path, old_page)
    skill = fork.version()
    before = publication_state(published)

    if failure == "needs_input":

        def model(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
            tool = next(item for item in info.output_tools if item.name.endswith("NeedsInput"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        tool.name,
                        {"status": "needs_input", "questions": ["Which audience?"]},
                    )
                ]
            )

        refresh_model = FunctionModel(model)
    elif failure == "model":

        def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
            raise RuntimeError("refresh model failure")

        refresh_model = FunctionModel(model)
    else:
        refresh_model = writing_model(
            "from pathlib import Path\nPath('/wiki/index.md').write_text('# invalid\\n')",
            ["index.md"],
        )

    def refresh() -> Complete | NeedsInput:
        return run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "refresh-staging",
            published,
            refresh_model,
            operation="refresh",
        )

    if failure == "needs_input":
        assert refresh() == NeedsInput(questions=["Which audience?"])
    elif failure == "model":
        with pytest.raises(RuntimeError, match="refresh model failure"):
            refresh()
    else:
        with pytest.raises(UnexpectedModelBehavior, match="maximum output retries"):
            refresh()

    assert publication_state(published) == before


@pytest.mark.parametrize("fault", ["metadata", "replacement"])
def test_refresh_publication_failure_leaves_the_publication_exactly_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    old_page = "---\ntitle: Old\n---\n# Old\n\n[Source](repo:README.md#L1-L1)\n"
    new_page = "---\ntitle: New\n---\n# New\n\n[Source](repo:README.md#L1-L1)\n"
    source, revision, fork, published = generated_test_wiki(tmp_path, old_page)
    skill = fork.version()
    before = publication_state(published)

    if fault == "metadata":
        write_text = Path.write_text

        def fail_metadata(
            path: Path,
            data: str,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
        ) -> int:
            if path.name == ".okf-wiki.json":
                raise OSError("refresh metadata failure")
            return write_text(path, data, encoding=encoding, errors=errors, newline=newline)

        monkeypatch.setattr(Path, "write_text", fail_metadata)
    else:
        replace = os.replace

        def fail_replacement(
            source_path: os.PathLike[str], destination_path: os.PathLike[str]
        ) -> None:
            if Path(destination_path).name == published.name:
                raise OSError("refresh replacement failure")
            replace(source_path, destination_path)

        monkeypatch.setattr(os, "replace", fail_replacement)

    with pytest.raises(OSError, match=f"refresh {fault} failure"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "refresh-staging",
            published,
            writing_model(write_pages_code({"index.md": new_page}), ["index.md"]),
            operation="refresh",
        )

    assert publication_state(published) == before


def test_complete_wiki_run_resolves_canonical_encoded_source_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source_revision = make_repository(source, "source\n")
    (source / "文档.md").write_text("来源\n", encoding="utf-8")
    subprocess.run(["git", "add", "文档.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "unicode source"], cwd=source, check=True)
    source_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    skill_version = make_producer_skill(skill)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": "from pathlib import Path\n"
                        "Path('/wiki/index.md').write_text('---\\ntitle: Wiki\\n---\\n"
                        "# Wiki\\n\\n[Source](repo:%E6%96%87%E6%A1%A3.md#L1-L1)\\n')"
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=3,
                    tool_calls_limit=2,
                    retries=0,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=staging,
                publication=tmp_path / "published",
            )
        )
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            added=["index.md"], content_changed=True, publication_changed=True
        ),
    )


def test_oversized_source_citation_is_rejected_before_content_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "x" * (MAX_ANALYZABLE_FILE_BYTES + 1))
    skill = make_producer_skill(tmp_path / "skill")
    real_read_bytes = Path.read_bytes

    def reject_materialized_source_read(path: Path) -> bytes:
        if path.name == "README.md" and path.parent.name == "source" and path.parent != source:
            raise AssertionError("oversized citation source must not be read")
        return real_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", reject_materialized_source_read)

    with pytest.raises(WikiRunResourceLimitError, match="quota"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            tmp_path / "published",
            writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]),
        )


def test_complete_validation_retry_lets_the_same_agent_fix_staging(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    turn = 0

    def model(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal turn
        current, turn = turn, turn + 1
        if current in {1, 3}:
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        body = (
            "---\ntitle: Fixed Wiki\n---\n# Fixed Wiki\n\n"
            "[Top](#fixed-wiki) [Web](https://example.com) [Mail](mailto:docs@example.com)\n\n"
            "[Source](repo:README.md#L1-L1)\n"
            if current == 2
            else "---\ntitle: ''\n---\n# Broken Wiki\n\n[Missing](missing.md)\n"
        )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": f"from pathlib import Path\nPath('/wiki/index.md').write_text({body!r})"
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=5,
                    tool_calls_limit=3,
                    retries=1,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=staging,
                publication=published,
            )
        )
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            added=["index.md"], content_changed=True, publication_changed=True
        ),
    )
    assert "# Fixed Wiki" in (published / "index.md").read_text(encoding="utf-8")


def test_needs_input_leaves_the_published_wiki_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)

    def model(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        needs_input = next(tool for tool in info.output_tools if tool.name.endswith("NeedsInput"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    needs_input.name,
                    {"status": "needs_input", "questions": ["Which audience is required?"]},
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(request_limit=2, request_timeout_seconds=5),
                staging=tmp_path / "staging",
                publication=published,
            )
        )
    )

    assert result == NeedsInput(questions=["Which audience is required?"])
    assert published.resolve() == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert list(old_release.parent.iterdir()) == [old_release]


def test_exhausted_validation_retry_leaves_the_published_wiki_unchanged(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": "from pathlib import Path\n"
                        "Path('/wiki/index.md').write_text('# no frontmatter\\n')"
                    },
                )
            ]
        )

    with pytest.raises(UnexpectedModelBehavior, match="maximum output retries"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert list(old_release.parent.iterdir()) == [old_release]


@pytest.mark.parametrize("fault", ["metadata", "replacement"])
def test_publication_failure_leaves_the_published_wiki_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": "from pathlib import Path\n"
                        "Path('/wiki/index.md').write_text('---\\ntitle: New Wiki\\n---\\n"
                        "# New Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')"
                    },
                )
            ]
        )

    if fault == "metadata":
        real_write_text = Path.write_text

        def fail_metadata(
            path: Path,
            data: str,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
        ) -> int:
            if path.name == ".okf-wiki.json":
                raise OSError("metadata failure")
            return real_write_text(path, data, encoding=encoding, errors=errors, newline=newline)

        monkeypatch.setattr(Path, "write_text", fail_metadata)
    else:
        real_replace = os.replace

        def fail_replacement(source_path: os.PathLike[str], target_path: os.PathLike[str]) -> None:
            if Path(target_path).name == published.name:
                raise OSError("replacement failure")
            real_replace(source_path, target_path)

        monkeypatch.setattr(os, "replace", fail_replacement)

    with pytest.raises(OSError, match=f"{fault} failure"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=1,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert list(old_release.parent.iterdir()) == [old_release]


@pytest.mark.parametrize("collision", ["final_release", "temporary_link"])
def test_publication_collision_never_removes_a_competing_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, collision: str
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)
    releases = old_release.parent

    class FixedUUID:
        hex = "fixed"

    monkeypatch.setattr("okf_wiki.wiki_run.uuid.uuid4", lambda: FixedUUID())
    if collision == "final_release":
        competing = releases / "fixed"
        competing.mkdir()
        sentinel = competing / "sentinel"
    else:
        competing = tmp_path / ".published.fixed.tmp"
        sentinel = competing
    sentinel.write_text("competitor\n", encoding="utf-8")

    with pytest.raises(OSError):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert sentinel.read_text(encoding="utf-8") == "competitor\n"
    assert published.resolve() == old_release


def test_publication_release_root_symlink_race_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)
    releases = old_release.parent
    moved_releases = tmp_path / "owned-releases"
    outside = tmp_path / "outside"
    outside.mkdir()
    real_mkdir = os.mkdir
    swapped = False

    class FixedUUID:
        hex = "fixed-release-race"

    monkeypatch.setattr("okf_wiki.wiki_run.uuid.uuid4", lambda: FixedUUID())

    def swap_release_root(
        path: os.PathLike[str] | str,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal swapped
        if path == FixedUUID.hex and dir_fd is not None and not swapped:
            releases.rename(moved_releases)
            releases.symlink_to(outside, target_is_directory=True)
            swapped = True
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_release_root)

    with pytest.raises(ValueError, match="release directory changed"):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert swapped
    assert list(outside.iterdir()) == []
    assert list(moved_releases.iterdir()) == [moved_releases / "old"]


def test_publication_parent_symlink_race_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    parent = tmp_path / "publication-parent"
    parent.mkdir()
    moved_parent = tmp_path / "owned-publication-parent"
    outside = tmp_path / "outside"
    outside.mkdir()
    real_mkdir = os.mkdir
    swapped = False

    class FixedUUID:
        hex = "fixed-parent-race"

    monkeypatch.setattr("okf_wiki.wiki_run.uuid.uuid4", lambda: FixedUUID())

    def swap_publication_parent(
        path: os.PathLike[str] | str,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal swapped
        if path == FixedUUID.hex and dir_fd is not None and not swapped:
            parent.rename(moved_parent)
            parent.symlink_to(outside, target_is_directory=True)
            swapped = True
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_publication_parent)

    with pytest.raises(ValueError, match="release directory changed"):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            parent / "published",
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert swapped
    assert list(outside.iterdir()) == []
    assert list((moved_parent / ".published.releases").iterdir()) == []


def test_publication_copy_revalidates_a_page_swapped_for_a_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)
    outside = tmp_path / "outside.md"
    page = "---\ntitle: New Wiki\n---\n# New Wiki\n\n[Source](repo:README.md#L1-L1)\n"
    outside.write_text(page, encoding="utf-8")

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": f"from pathlib import Path\n"
                        f"Path('/wiki/index.md').write_text({page!r})"
                    },
                )
            ]
        )

    real_open = os.open
    swapped = False

    def swap_then_open(path: os.PathLike[str] | str, flags: int, *args: Any, **kwargs: Any) -> int:
        nonlocal swapped
        if Path(path) == staging / "index.md" and not swapped:
            (staging / "index.md").unlink()
            (staging / "index.md").symlink_to(outside)
            swapped = True
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", swap_then_open)

    with pytest.raises(ValueError, match="not a readable regular file"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=staging,
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert list(old_release.parent.iterdir()) == [old_release]
    assert swapped


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "undeclared",
        "duplicate",
        "noncanonical",
        "whitespace",
        "escaped",
        "symlink",
        "non_markdown",
        "temporary",
        "missing_index",
        "frontmatter",
        "frontmatter_yaml",
        "duplicate_frontmatter",
        "internal_link",
        "fragment",
        "no_citation",
        "citation_syntax",
        "citation_path",
        "citation_binary",
        "citation_range",
        "citation_reversed",
        "citation_traversal",
        "citation_encoded_separator",
        "citation_query",
        "raw_html",
    ],
)
def test_invalid_staging_manifest_and_artifacts_never_publish(tmp_path: Path, case: str) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    if case == "citation_binary":
        (source / "README.md").write_bytes(b"binary\0source")
    elif case == "citation_encoded_separator":
        (source / "README%2Fcopy.md").write_text("encoded separator\n", encoding="utf-8")
    elif case == "citation_query":
        (source / "README.md?draft").write_text("query-shaped path\n", encoding="utf-8")
    if case in {"citation_binary", "citation_encoded_separator", "citation_query"}:
        subprocess.run(["git", "add", "."], cwd=source, check=True)
        subprocess.run(["git", "commit", "-qm", "adversarial source path"], cwd=source, check=True)
        source_revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)
    outside = tmp_path / "outside.md"
    outside.write_text("outside\n", encoding="utf-8")
    uncited_page = "---\ntitle: Valid Wiki\n---\n# Valid Wiki\n"
    valid_page = uncited_page + "\n[Source](repo:README.md#L1-L1)\n"
    code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({valid_page!r})"
    pages = ["index.md"]
    if case == "missing":
        pages.append("missing.md")
    elif case == "undeclared":
        code += f"\nPath('/wiki/extra.md').write_text({valid_page!r})"
    elif case == "duplicate":
        pages.append("index.md")
    elif case == "noncanonical":
        pages = ["./index.md"]
    elif case == "whitespace":
        pages = [" index.md"]
    elif case == "escaped":
        pages = ["../index.md"]
    elif case == "non_markdown":
        code += "\nPath('/wiki/notes.txt').write_text('notes')"
    elif case == "temporary":
        code += "\nPath('/wiki/draft.tmp').write_text('draft')"
    elif case == "missing_index":
        code = f"from pathlib import Path\nPath('/wiki/other.md').write_text({valid_page!r})"
        pages = ["other.md"]
    elif case == "frontmatter":
        code = "from pathlib import Path\nPath('/wiki/index.md').write_text('# Missing\\n')"
    elif case == "frontmatter_yaml":
        invalid = "---\ntitle: [\n---\n# Invalid YAML\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "duplicate_frontmatter":
        invalid = (
            "---\ntitle: First\ntitle: Second\n---\n# Duplicate\n\n[Source](repo:README.md#L1-L1)\n"
        )
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "internal_link":
        invalid = valid_page + "\n[Missing](missing.md)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "fragment":
        index = valid_page + "\n[Other](other.md#missing)\n"
        code = (
            "from pathlib import Path\n"
            f"Path('/wiki/index.md').write_text({index!r})\n"
            f"Path('/wiki/other.md').write_text({valid_page!r})"
        )
        pages.append("other.md")
    elif case == "no_citation":
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({uncited_page!r})"
    elif case == "citation_syntax":
        invalid = uncited_page + "\n[Source](repo:README.md#L0-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_path":
        invalid = uncited_page + "\n[Source](repo:missing.py#L1-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_range":
        invalid = uncited_page + "\n[Source](repo:README.md#L2-L2)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_reversed":
        invalid = uncited_page + "\n[Source](repo:README.md#L2-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_traversal":
        invalid = uncited_page + "\n[Source](repo:../README.md#L1-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_encoded_separator":
        invalid = uncited_page + "\n[Source](repo:README%2Fcopy.md#L1-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "citation_query":
        invalid = uncited_page + "\n[Source](repo:README.md?draft#L1-L1)\n"
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"
    elif case == "raw_html":
        invalid = valid_page + '\n<a href="missing.md">Missing</a>\n'
        code = f"from pathlib import Path\nPath('/wiki/index.md').write_text({invalid!r})"

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            if case == "symlink":
                (staging / "linked.md").symlink_to(outside)
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": pages}},
                    )
                ]
            )
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    with pytest.raises(UnexpectedModelBehavior, match="maximum output retries"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=staging,
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release
    assert list(old_release.parent.iterdir()) == [old_release]


def test_wiki_run_freezes_source_and_skill_before_model_work(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source_text = "# Example repository\n\nThe source marker is SOURCE-FIRST.\n"
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), skill)
    skill_text = """---
name: repository-wiki-producer
description: Produce a source-grounded Wiki.
---

# Producer Skill

Use the skill marker SKILL-FIRST.
"""
    source_revision = make_repository(source, source_text)
    (skill / "SKILL.md").write_text(skill_text, encoding="utf-8")
    skill_version = fork.version()
    originals_changed = False

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal originals_changed
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        (source / "README.md").write_text("changed after snapshot\n", encoding="utf-8")
        (skill / "SKILL.md").write_text("changed after snapshot\n", encoding="utf-8")
        originals_changed = True
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": """from pathlib import Path
skill = Path('/skill/SKILL.md').read_text()
source = Path('/source/README.md').read_text()
source_write_blocked = False
skill_write_blocked = False
try:
    Path('/source/README.md').write_text('tampered')
except Exception:
    source_write_blocked = True
try:
    Path('/skill/SKILL.md').write_text('tampered')
except Exception:
    skill_write_blocked = True
assert source_write_blocked and skill_write_blocked
Path('/wiki/index.md').write_text('---\\ntitle: Example Wiki\\n---\\n# Example Wiki\\n\\n' + skill + '\\n' + source + '\\n[Source](repo:README.md#L1-L3)\\n')
"""
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=3,
                    tool_calls_limit=2,
                    input_tokens_limit=10_000,
                    output_tokens_limit=2_000,
                    total_tokens_limit=12_000,
                    retries=1,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=staging,
                publication=tmp_path / "published",
            )
        )
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            added=["index.md"], content_changed=True, publication_changed=True
        ),
    )
    assert (staging / "index.md").read_text(encoding="utf-8") == (
        "---\ntitle: Example Wiki\n---\n# Example Wiki\n\n"
        + skill_text
        + "\n"
        + source_text
        + "\n[Source](repo:README.md#L1-L3)\n"
    )
    assert originals_changed
    assert (source / "README.md").read_text(encoding="utf-8") == "changed after snapshot\n"
    assert (skill / "SKILL.md").read_text(encoding="utf-8") == "changed after snapshot\n"
    metadata = json.loads((tmp_path / "published" / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["skill_digest"] == skill_version.digest


def test_codemode_exposes_only_the_three_mounts_and_no_host_capabilities(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    plugin_marker = tmp_path / "plugin-ran"
    (source / "plugin.py").write_text(
        f"from pathlib import Path\nPath({str(plugin_marker)!r}).write_text('ran')\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "plugin.py"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "adversarial plugin"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    skill = make_producer_skill(tmp_path / "skill")
    host_marker = tmp_path / "host-write"
    code = f"""from pathlib import Path
blocked = []
for path in [
    Path('/source/README.md'),
    Path('/skill/SKILL.md'),
    Path({str(host_marker)!r}),
    Path('/wiki/../../host-write'),
    Path('//tmp/host-write'),
]:
    try:
        path.write_text('escaped')
    except Exception:
        blocked.append(str(path))
assert len(blocked) == 5
symlink_blocked = False
try:
    Path('/wiki/link').symlink_to('/source/README.md')
except Exception:
    symlink_blocked = True
assert symlink_blocked
import os
os_blocked = []
try:
    os.system('echo escaped')
except Exception:
    os_blocked.append('system')
try:
    os.getenv('OKF_WIKI_SENTINEL')
except Exception:
    os_blocked.append('environment')
assert len(os_blocked) == 2
unavailable = []
execution_blocked = False
try:
    exec('repository_code_executed = True')
except Exception:
    execution_blocked = True
assert execution_blocked
try:
    import subprocess
except Exception:
    unavailable.append('subprocess')
try:
    import socket
except Exception:
    unavailable.append('socket')
try:
    import urllib.request
except Exception:
    unavailable.append('urllib')
try:
    import httpx
except Exception:
    unavailable.append('httpx')
try:
    import pip
except Exception:
    unavailable.append('pip')
try:
    import plugin
except Exception:
    unavailable.append('plugin')
assert len(unavailable) == 6
Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})
"""

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        assert [tool.name for tool in info.function_tools] == ["run_code"]
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    result = run_test_wiki(
        source,
        revision,
        skill,
        tmp_path / "staging",
        tmp_path / "published",
        FunctionModel(model),
    )

    assert isinstance(result, Complete)
    assert not host_marker.exists()
    assert not plugin_marker.exists()


def test_repository_instructions_are_only_readable_source_data(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    sentinel = "UNTRUSTED_SOURCE_POLICY_OVERRIDE"
    files = {
        "AGENTS.md": sentinel,
        "CLAUDE.md": sentinel,
        "SKILL.md": sentinel,
        ".codex-plugin/plugin.json": '{"instructions": "' + sentinel + '"}',
        "prompt.txt": sentinel,
    }
    for relative, content in files.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "untrusted instructions"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    skill = make_producer_skill(tmp_path / "skill")
    code = (
        "from pathlib import Path\n"
        f"paths = {list(files)!r}\n"
        f"assert all({sentinel!r} in Path('/source', path).read_text() for path in paths)\n"
        f"Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})\n"
    )

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        code_ran = any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        )
        if code_ran:
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        supplied = repr(messages) + repr(info.function_tools) + repr(info.instructions)
        assert sentinel not in supplied
        assert [tool.name for tool in info.function_tools] == ["run_code"]
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    result = run_test_wiki(
        source,
        revision,
        skill,
        tmp_path / "staging",
        tmp_path / "published",
        FunctionModel(model),
    )

    assert isinstance(result, Complete)
    assert sentinel not in (tmp_path / "published/index.md").read_text(encoding="utf-8")


def test_credentials_never_enter_the_agent_sandbox_artifacts_or_traces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    secrets = ("credential-sentinel-value", "header-sentinel-value")
    monkeypatch.setenv("OPENAI_API_KEY", secrets[0])
    monkeypatch.setenv("HTTP_AUTHORIZATION", secrets[1])
    initial_request = ""
    code = f"""from pathlib import Path
import os
environment = []
for name in ['OPENAI_API_KEY', 'HTTP_AUTHORIZATION']:
    try:
        environment.append(os.getenv(name))
    except Exception:
        environment.append(None)
assert environment == [None, None]
Path('/wiki/index.md').write_text({SIMPLE_WIKI_PAGE!r})
"""

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal initial_request
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        initial_request = (
            repr(messages)
            + repr(info.function_tools)
            + repr(info.output_tools)
            + repr(info.instructions)
        )
        assert not any(secret in initial_request for secret in secrets)
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    Agent.instrument_all(InstrumentationSettings(tracer_provider=provider, include_content=True))
    try:
        result = run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            tmp_path / "published",
            FunctionModel(model),
        )
    finally:
        Agent.instrument_all(False)
        provider.force_flush()

    observable = (initial_request + repr(result)).encode()
    for root in (source, skill.path, tmp_path / "staging", tmp_path / "published"):
        observable += b"".join(
            path.read_bytes()
            for path in root.rglob("*")
            if path.is_file() and not path.is_symlink()
        )
    assert not any(secret.encode() in observable for secret in secrets)
    assert exporter.get_finished_spans() == ()


def test_model_setting_secrets_are_withheld_from_application_errors(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    secret = "private-extra-header-value"

    def fail(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"provider rejected header {secret}")

    with pytest.raises(RuntimeError, match="diagnostics withheld") as caught:
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=FunctionModel(fail),
                        settings={"extra_headers": {"X-Tenant": secret}},
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )

    assert secret not in str(caught.value)


def test_wiki_run_rejects_nested_staging_without_creating_it(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = source / "staging"
    source.mkdir()
    skill_version = make_producer_skill(skill)

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for invalid mounts")

    with pytest.raises(ValueError, match="must not overlap"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision="source-rev"),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=staging,
                    publication=tmp_path / "published",
                )
            )
        )

    assert not staging.exists()


@pytest.mark.parametrize("symlink_parent", [False, True])
def test_wiki_run_rejects_symlinked_staging_before_model_work(
    tmp_path: Path, symlink_parent: bool
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    outside = tmp_path / "outside"
    outside.mkdir()
    if symlink_parent:
        parent = tmp_path / "staging-parent"
        parent.symlink_to(outside, target_is_directory=True)
        staging = parent / "nested"
    else:
        staging = tmp_path / "staging"
        staging.symlink_to(outside, target_is_directory=True)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for a symlinked staging path")

    with pytest.raises(ValueError, match="Staging Wiki path must not contain symlinks"):
        run_test_wiki(
            source,
            revision,
            skill,
            staging,
            tmp_path / "published",
            FunctionModel(model),
        )

    assert not model_called
    assert list(outside.iterdir()) == []


def test_wiki_run_rejects_staging_parent_symlink_race_before_model_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    parent = tmp_path / "staging-parent"
    parent.mkdir()
    moved_parent = tmp_path / "owned-staging-parent"
    outside = tmp_path / "outside"
    outside.mkdir()
    real_mkdir = os.mkdir
    swapped = False

    def swap_staging_parent(
        path: os.PathLike[str] | str,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal swapped
        if path == "nested" and dir_fd is not None and not swapped:
            parent.rename(moved_parent)
            parent.symlink_to(outside, target_is_directory=True)
            swapped = True
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_staging_parent)

    with pytest.raises(ValueError, match="Staging Wiki path changed during creation"):
        run_test_wiki(
            source,
            revision,
            skill,
            parent / "nested",
            tmp_path / "published",
            FunctionModel(
                lambda *_: (_ for _ in ()).throw(
                    AssertionError("model must not run after a staging path race")
                )
            ),
        )

    assert swapped
    assert list(outside.iterdir()) == []
    assert (moved_parent / "nested").is_dir()


def test_wiki_run_rejects_a_publication_parent_symlink_into_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    source_revision = make_repository(source, "source\n")
    skill_version = make_producer_skill(skill)
    publication_parent = tmp_path / "publication-parent"
    publication_parent.symlink_to(source, target_is_directory=True)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for overlapping publication")

    with pytest.raises(ValueError, match="must not overlap"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=publication_parent / "published",
                )
            )
        )

    assert not model_called
    assert not (source / "published").exists()
    assert not (source / ".published.releases").exists()


def test_wiki_run_rejects_a_symlinked_release_root_before_model_work(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / ".published.releases").symlink_to(outside, target_is_directory=True)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an unsafe release root")

    with pytest.raises(ValueError, match="release directory"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )

    assert not model_called
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("dirty", [False, True], ids=["non-git", "dirty"])
def test_wiki_run_rejects_invalid_checkout_before_model_work(
    tmp_path: Path, *, dirty: bool
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    if dirty:
        revision = make_repository(source, "committed\n")
        (source / "README.md").write_text("dirty\n", encoding="utf-8")
    else:
        source.mkdir()
        revision = "0" * 40
    skill_version = make_producer_skill(skill)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an invalid checkout")

    with pytest.raises(ValueError):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=staging,
                    publication=tmp_path / "published",
                )
            )
        )

    assert not model_called


def test_wiki_run_rejects_an_oversized_source_blob_before_reading_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "too large\n")
    skill = make_producer_skill(tmp_path / "skill")
    real_git_read_bytes = __import__(
        "okf_wiki.wiki_run", fromlist=["git_read_bytes"]
    ).git_read_bytes

    def reject_blob_read(repository: Path, *arguments: str) -> bytes:
        if arguments[:2] == ("cat-file", "blob"):
            raise AssertionError("oversized source blob must not be read")
        return real_git_read_bytes(repository, *arguments)

    monkeypatch.setattr("okf_wiki.wiki_run.git_read_bytes", reject_blob_read)

    with pytest.raises(ValueError, match="source file exceeds.*limit"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=FunctionModel(
                            lambda *_: (_ for _ in ()).throw(
                                AssertionError("model must not run for an oversized snapshot")
                            )
                        )
                    ),
                    limits=WikiRunLimits(source_file_bytes_limit=5),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )


@pytest.mark.parametrize(
    ("limits", "message", "add_file"),
    [
        ({"source_files_limit": 1}, "file count", True),
        ({"source_total_bytes_limit": 5}, "total byte", False),
    ],
)
def test_wiki_run_rejects_source_count_and_total_ceilings_before_blob_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    limits: dict[str, int],
    message: str,
    add_file: bool,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "too large\n")
    if add_file:
        (source / "extra.txt").write_text("extra\n", encoding="utf-8")
        subprocess.run(["git", "add", "extra.txt"], cwd=source, check=True)
        subprocess.run(["git", "commit", "-qm", "extra"], cwd=source, check=True)
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    skill = make_producer_skill(tmp_path / "skill")
    real_git_read_bytes = __import__(
        "okf_wiki.wiki_run", fromlist=["git_read_bytes"]
    ).git_read_bytes

    def reject_blob_read(repository: Path, *arguments: str) -> bytes:
        if arguments[:2] == ("cat-file", "blob"):
            raise AssertionError("snapshot ceiling must be checked before blob reads")
        return real_git_read_bytes(repository, *arguments)

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for an oversized snapshot")

    monkeypatch.setattr("okf_wiki.wiki_run.git_read_bytes", reject_blob_read)

    with pytest.raises(ValueError, match=message):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(**limits),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )


def test_wiki_run_rejects_executable_git_filter_without_running_it(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    revision = make_repository(source, "committed\n")
    (source / ".gitattributes").write_text("README.md filter=evil\n", encoding="utf-8")
    subprocess.run(["git", "add", ".gitattributes"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "select filter"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    marker = tmp_path / "filter-ran"
    filter_program = tmp_path / "filter.sh"
    filter_program.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n", encoding="utf-8")
    filter_program.chmod(0o755)
    subprocess.run(
        ["git", "config", "filter.evil.clean", str(filter_program)], cwd=source, check=True
    )
    readme = source / "README.md"
    stat = readme.stat()
    os.utime(readme, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    skill_version = make_producer_skill(skill)

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for unsafe Git configuration")

    with pytest.raises(ValueError, match="executable Git filters"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )

    assert not marker.exists()


def test_wiki_run_wall_clock_deadline_terminates_model_work(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    revision = make_repository(source, "committed\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)
    model_started = False

    async def slow_model(_: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal model_started
        model_started = True
        await asyncio.sleep(0.2)
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name,
                    {"status": "complete", "manifest": {"pages": ["index.md"]}},
                )
            ]
        )

    with pytest.raises(TimeoutError):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(slow_model)),
                    limits=WikiRunLimits(
                        request_timeout_seconds=5,
                        wall_clock_timeout_seconds=0.01,
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert model_started
    assert published.resolve() == old_release


def test_wiki_mount_write_quota_stops_output_and_preserves_the_publication(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)

    with pytest.raises(WikiRunResourceLimitError, match="quota"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=writing_model(
                            write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                        )
                    ),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                        wiki_write_bytes_limit=10,
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


def test_agent_usage_limit_is_an_explicit_resource_failure(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")

    with pytest.raises(WikiRunResourceLimitError, match="Agent usage quota"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=writing_model(
                            write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                        )
                    ),
                    limits=WikiRunLimits(
                        request_limit=1,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )


def test_wiki_entry_ceiling_counts_directories_and_preserves_the_publication(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)
    code = write_pages_code({"index.md": SIMPLE_WIKI_PAGE}) + "\nPath('/wiki/empty').mkdir()"

    with pytest.raises(WikiRunResourceLimitError, match="quota"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(model=writing_model(code, ["index.md"])),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                        wiki_entries_limit=1,
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release


@pytest.mark.parametrize(
    ("limit_name", "limit"),
    [("wiki_file_bytes_limit", 10), ("wiki_total_bytes_limit", 10)],
)
def test_wiki_byte_ceilings_preserve_the_publication(
    tmp_path: Path, limit_name: str, limit: int
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)

    with pytest.raises(WikiRunResourceLimitError, match="quota"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=writing_model(
                            write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                        )
                    ),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                        **{limit_name: limit},
                    ),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release


def test_model_failure_leaves_the_published_wiki_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    revision = make_repository(source, "committed\n")
    skill_version = make_producer_skill(skill)
    old_release = make_published_wiki(published)

    def failed_model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError("model failure")

    with pytest.raises(RuntimeError, match="model failure"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(failed_model)),
                    limits=WikiRunLimits(request_timeout_seconds=5),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release


def test_multi_repository_citations_require_a_repository_id(tmp_path: Path) -> None:
    application = tmp_path / "application"
    application_revision = make_repository(application, "application\n")
    documentation = tmp_path / "documentation"
    documentation_revision = make_repository(documentation, "documentation\n")
    page = "---\ntitle: Wiki\n---\n# Wiki\n\n[Source](repo:README.md#L1-L1)\n"

    with pytest.raises(UnexpectedModelBehavior, match="maximum output retries"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(
                        RepositorySnapshot(
                            id="app", path=application, revision=application_revision
                        ),
                        RepositorySnapshot(
                            id="docs", path=documentation, revision=documentation_revision
                        ),
                    ),
                    skill=ProducerSkillVersion.default(),
                    model=ModelProviderConfig(
                        model=writing_model(write_pages_code({"index.md": page}), ["index.md"])
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                )
            )
        )


@pytest.mark.parametrize(
    "key",
    [
        "api_key",
        "apiKey",
        "openaiApiKey",
        "authorizationHeader",
        "apiKeyValue",
        "accessKeyId",
        "providerCookie",
    ],
)
def test_wiki_run_yaml_rejects_secrets_without_echoing_them(tmp_path: Path, key: str) -> None:
    secret = "must-not-appear-in-errors"
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
operation: generate
model: openai:gpt-5-mini
{key}: {secret}
staging: ./staging
publication: ./published
repositories: []
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as captured:
        WikiRunRequest.from_yaml(config)

    assert secret not in str(captured.value)


def test_ignore_patterns_skip_non_file_tree_entries(tmp_path: Path) -> None:
    dependency = tmp_path / "dependency"
    make_repository(dependency, "dependency\n")

    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("source\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=source, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            str(dependency),
            "vendor/lib",
        ],
        cwd=source,
        check=True,
    )
    subprocess.run(["git", "commit", "-qm", "gitlink"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    target = tmp_path / "materialized"
    used_files, used_bytes = _materialize_repository_snapshot(
        source,
        revision,
        target,
        TEST_WIKI_LIMITS,
        ignore=("vendor/lib",),
        used_files=0,
        used_bytes=0,
    )

    assert (target / "README.md").read_text(encoding="utf-8") == "source\n"
    assert not (target / "vendor").exists()
    materialized_files = [path for path in target.rglob("*") if path.is_file()]
    assert used_files == len(materialized_files) == 2
    assert used_bytes == sum(path.stat().st_size for path in materialized_files)


def test_wiki_run_cli_exposes_wall_clock_deadline() -> None:
    arguments = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--skill",
            "skill",
            "--skill-digest",
            "0" * 64,
            "--staging",
            "staging",
            "--publication",
            "published",
            "--model",
            "test",
            "--wall-clock-timeout-seconds",
            "7",
            "--source-files-limit",
            "11",
            "--source-file-bytes-limit",
            "12",
            "--source-total-bytes-limit",
            "13",
            "--wiki-entries-limit",
            "14",
            "--wiki-file-bytes-limit",
            "15",
            "--wiki-total-bytes-limit",
            "16",
            "--wiki-write-bytes-limit",
            "17",
        ]
    )

    assert arguments.wall_clock_timeout_seconds == 7
    assert arguments.source_files_limit == 11
    assert arguments.source_file_bytes_limit == 12
    assert arguments.source_total_bytes_limit == 13
    assert arguments.wiki_entries_limit == 14
    assert arguments.wiki_file_bytes_limit == 15
    assert arguments.wiki_total_bytes_limit == 16
    assert arguments.wiki_write_bytes_limit == 17
    assert arguments.publication == Path("published")
    assert WikiRunLimits.model_fields.keys() <= vars(arguments).keys()


def test_cli_exposes_only_the_greenfield_product_commands() -> None:
    command = parser()
    subcommands = next(action for action in command._actions if action.dest == "command")

    assert subcommands.choices is not None
    assert tuple(subcommands.choices) == (
        "wiki-run",
        "wiki-retry",
        "tui",
        "wiki-eval",
        "skill-fork",
        "skill-inspect",
    )


def test_wiki_run_cli_routes_refresh_through_the_same_application_seam(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    captured: WikiRunRequest | None = None

    async def run(_: WikiRunApplication, request: WikiRunRequest) -> NeedsInput:
        nonlocal captured
        captured = request
        return NeedsInput(questions=["Which audience?"])

    monkeypatch.setattr(WikiRunApplication, "run", run)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--refresh",
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 0

    assert captured is not None
    assert captured.operation == "refresh"
    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "result": {
            "status": "needs_input",
            "questions": ["Which audience?"],
        },
    }


def test_wiki_run_cli_loads_config_dotenv_without_overriding_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    source = project / "source"
    revision = make_repository(source, "source\n")
    config = project / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
model: test
staging: ./staging
publication: ./published
repositories:
  - id: source
    path: ./source
    revision: {revision}
""",
        encoding="utf-8",
    )
    (project / ".env").write_text(
        "OPENAI_API_KEY=from-config\nOPENAI_BASE_URL=https://config.example/v1\n",
        encoding="utf-8",
    )
    caller = tmp_path / "caller"
    caller.mkdir()
    (caller / ".env").write_text("OPENAI_BASE_URL=https://caller.example/v1\n", encoding="utf-8")
    monkeypatch.chdir(caller)
    monkeypatch.setenv("OPENAI_API_KEY", "from-process")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    captured: dict[str, str | None] = {}

    async def run(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        captured.update(
            api_key=os.getenv("OPENAI_API_KEY"),
            base_url=os.getenv("OPENAI_BASE_URL"),
        )
        return NeedsInput(questions=["Done?"])

    monkeypatch.setattr(WikiRunApplication, "run", run)
    monkeypatch.setattr("sys.argv", ["okf-wiki", "wiki-run", "--config", str(config)])

    assert main() == 0
    assert captured == {
        "api_key": "from-process",
        "base_url": "https://config.example/v1",
    }


def test_wiki_run_cli_withholds_secret_bearing_provider_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "wiki-run-provider-secret"
    monkeypatch.setenv("OPENAI_API_KEY", secret)

    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise RuntimeError(f"provider Authorization: Bearer {secret}")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 1

    output = capsys.readouterr().out
    assert secret not in output
    assert json.loads(output) == {
        "error": {
            "message": "RuntimeError: provider diagnostics withheld",
            "type": "RuntimeError",
        },
        "ok": False,
    }


def test_wiki_run_cli_preserves_explicit_resource_limit_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise WikiRunResourceLimitError("Agent usage quota was exceeded")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 1
    assert json.loads(capsys.readouterr().out) == {
        "error": {
            "message": "Agent usage quota was exceeded",
            "type": "WikiRunResourceLimitError",
        },
        "ok": False,
    }


def test_skill_fork_cli_creates_an_owned_copy_of_the_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    destination = tmp_path / "my-skill"
    monkeypatch.setattr("sys.argv", ["okf-wiki", "skill-fork", str(destination)])

    assert main() == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload == {
        "ok": True,
        "skill_fork": {
            "digest": ProducerSkillVersion.default().digest,
            "path": str(destination),
        },
    }
    assert (
        ProducerSkillVersion.from_directory(destination).digest == payload["skill_fork"]["digest"]
    )


def test_skill_inspect_cli_reports_the_current_resolved_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), Path("my-skill"))
    guidance = fork.path / "references/generate.md"
    guidance.write_text(guidance.read_text(encoding="utf-8") + "\nAudience: operators\n")
    expected = fork.version()
    monkeypatch.setattr("sys.argv", ["okf-wiki", "skill-inspect", "my-skill"])

    assert main() == 0

    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "skill_version": {"digest": expected.digest, "path": str(expected.path)},
    }
