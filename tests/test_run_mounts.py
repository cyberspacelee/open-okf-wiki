"""Mount, path, and snapshot safety tests."""

from __future__ import annotations

import asyncio
import os
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart, UnexpectedModelBehavior
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.security import MAX_ANALYZABLE_FILE_BYTES
from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    RepositorySnapshot,
    WikiManifest,
    WikiChangeSummary,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunResourceLimitError,
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    make_producer_skill,
    make_published_wiki,
    make_repository,
    run_test_wiki,
    write_pages_code,
    writing_model,
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
                auto_approve_publication=True,
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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


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
                    auto_approve_publication=True,
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

    with pytest.raises(ValueError, match="Staging Wiki path must not contain a symbolic link"):
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
        target = Path(path)
        if target.name == "nested" and not swapped:
            parent.rename(moved_parent)
            parent.symlink_to(outside, target_is_directory=True)
            swapped = True
            # Refuse to materialize the child through the swapped symlink parent.
            raise FileNotFoundError(path)
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_staging_parent)

    with pytest.raises((ValueError, OSError, FileNotFoundError)):
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
    assert (moved_parent / "nested").exists() is False


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
                    auto_approve_publication=True,
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
                    auto_approve_publication=True,
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

    monkeypatch.setattr("okf_wiki.run_snapshots.git_read_bytes", reject_blob_read)

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
                    auto_approve_publication=True,
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

    monkeypatch.setattr("okf_wiki.run_snapshots.git_read_bytes", reject_blob_read)

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
                    auto_approve_publication=True,
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
                    auto_approve_publication=True,
                )
            )
        )

    assert not marker.exists()


def test_require_supported_runtime_accepts_non_linux_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Portable prepare no longer hard-rejects Windows for missing /proc or dir_fd."""
    from okf_wiki import run_mounts as mounts_module

    monkeypatch.setattr(mounts_module.sys, "platform", "win32")
    mounts_module._require_supported_runtime()  # does not raise for Windows alone


def test_require_supported_runtime_rejects_missing_portable_primitives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from okf_wiki import run_mounts as mounts_module

    monkeypatch.delattr(mounts_module.os, "rename", raising=False)
    with pytest.raises(ValueError, match="portable Host filesystem|rename"):
        mounts_module._require_supported_runtime()


def test_disallowed_path_component_detects_junction_and_allows_cloud_reparse() -> None:
    """Symlinks/junctions fail closed; OneDrive-style cloud reparse tags are allowed."""
    from okf_wiki import run_mounts as mounts_module

    plain = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0, st_reparse_tag=0)
    symlink = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_file_attributes=0, st_reparse_tag=0)
    untagged_reparse = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=0,
    )
    junction = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=mounts_module._IO_REPARSE_TAG_MOUNT_POINT,
    )
    cloud = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=mounts_module._IO_REPARSE_TAG_CLOUD,
    )
    cloud_family = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=mounts_module._IO_REPARSE_TAG_CLOUD_1
        if hasattr(mounts_module, "_IO_REPARSE_TAG_CLOUD_1")
        else 0x9000101A,
    )
    onedrive = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=mounts_module._IO_REPARSE_TAG_ONEDRIVE,
    )
    unknown = SimpleNamespace(
        st_mode=stat.S_IFDIR | 0o755,
        st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
        st_reparse_tag=0xA00000FF,
    )

    assert mounts_module._is_disallowed_path_component(plain) is False
    assert mounts_module._is_disallowed_path_component(symlink) is True
    assert mounts_module._is_disallowed_path_component(untagged_reparse) is True
    assert mounts_module._is_disallowed_path_component(junction) is True
    assert mounts_module._is_disallowed_path_component(cloud) is False
    assert mounts_module._is_disallowed_path_component(cloud_family) is False
    assert mounts_module._is_disallowed_path_component(onedrive) is False
    assert mounts_module._is_disallowed_path_component(unknown) is True
    assert "junction" in (mounts_module._disallowed_path_reason(junction) or "")
    assert mounts_module._disallowed_path_reason(cloud) is None


def test_prepare_rejects_host_junction_reparse_on_controlled_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Application seam: directory junctions fail before model work."""
    from okf_wiki import run_mounts as mounts_module

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    host = tmp_path / "host"
    host.mkdir()
    real_lstat = os.lstat

    host_key = os.path.normpath(os.fspath(host))

    def lstat_with_junction(
        path: os.PathLike[str] | str, *, dir_fd: int | None = None
    ) -> os.stat_result | SimpleNamespace:
        info = real_lstat(path, dir_fd=dir_fd)
        # Avoid Path.resolve() here — it re-enters os.lstat under the monkeypatch.
        if os.path.normpath(os.fspath(path)) == host_key:
            return SimpleNamespace(
                st_mode=info.st_mode,
                st_ino=info.st_ino,
                st_dev=info.st_dev,
                st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
                st_reparse_tag=mounts_module._IO_REPARSE_TAG_MOUNT_POINT,
            )
        return info

    monkeypatch.setattr(mounts_module.os, "lstat", lstat_with_junction)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run when Host path has a junction")

    with pytest.raises(ValueError, match="junction|reparse|symlink"):
        run_test_wiki(
            source,
            revision,
            skill,
            host / "staging",
            host / "published",
            FunctionModel(model),
        )

    assert not model_called


def test_prepare_allows_cloud_reparse_ancestor_on_controlled_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OneDrive-style cloud reparse ancestors must not block staging creation."""
    from okf_wiki import run_mounts as mounts_module

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    host = tmp_path / "host"
    host.mkdir()
    real_lstat = os.lstat
    host_key = os.path.normpath(os.fspath(host))

    def lstat_with_cloud(
        path: os.PathLike[str] | str, *, dir_fd: int | None = None
    ) -> os.stat_result | SimpleNamespace:
        info = real_lstat(path, dir_fd=dir_fd)
        if os.path.normpath(os.fspath(path)) == host_key:
            return SimpleNamespace(
                st_mode=info.st_mode,
                st_ino=info.st_ino,
                st_dev=info.st_dev,
                st_file_attributes=mounts_module._FILE_ATTRIBUTE_REPARSE_POINT,
                st_reparse_tag=mounts_module._IO_REPARSE_TAG_CLOUD,
            )
        return info

    monkeypatch.setattr(mounts_module.os, "lstat", lstat_with_cloud)

    result = run_test_wiki(
        source,
        revision,
        skill,
        host / "staging",
        host / "published",
        writing_model(
            write_pages_code({"index.md": SIMPLE_WIKI_PAGE}),
            ["index.md"],
        ),
    )
    assert isinstance(result, Complete)
    assert (host / "published" / "index.md").is_file()


def test_create_directory_path_rejects_symlink_component(tmp_path: Path) -> None:
    from okf_wiki import run_mounts as mounts_module

    root = tmp_path / "root"
    root.mkdir()
    link = tmp_path / "link-parent"
    link.symlink_to(root, target_is_directory=True)
    with pytest.raises(ValueError, match="symbolic link"):
        mounts_module._create_directory_path(link / "child", "Staging Wiki")


def test_prepare_rejects_cross_volume_publication_and_releases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same-volume check fails closed when releases root is on a different st_dev."""
    from okf_wiki import run_mounts as mounts_module

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    releases = tmp_path / ".published.releases"
    releases.mkdir()
    real_lstat = os.lstat

    releases_key = os.path.normpath(os.fspath(releases))

    def volume_skew_lstat(
        path: os.PathLike[str] | str, *, dir_fd: int | None = None
    ) -> os.stat_result | SimpleNamespace:
        info = real_lstat(path, dir_fd=dir_fd)
        # Avoid Path.resolve() — it re-enters os.lstat under the monkeypatch.
        if os.path.normpath(os.fspath(path)) == releases_key:
            return SimpleNamespace(
                st_mode=info.st_mode,
                st_ino=info.st_ino,
                st_dev=info.st_dev + 99_001,
                st_file_attributes=getattr(info, "st_file_attributes", 0) or 0,
            )
        return info

    monkeypatch.setattr(mounts_module.os, "lstat", volume_skew_lstat)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for cross-volume publication layout")

    with pytest.raises(ValueError, match="same volume"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            FunctionModel(model),
        )

    assert not model_called


def test_prepare_rejects_legacy_symlink_published_wiki_before_model_work(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    release = tmp_path / ".published.releases" / "old"
    release.mkdir(parents=True)
    (release / "index.md").write_text("legacy\n", encoding="utf-8")
    published.symlink_to(os.path.relpath(release, published.parent), target_is_directory=True)
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for legacy symlink publication")

    with pytest.raises(ValueError, match="symbolic link|legacy"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            FunctionModel(model),
        )

    assert not model_called
    assert published.is_symlink()
    assert (release / "index.md").read_text(encoding="utf-8") == "legacy\n"
