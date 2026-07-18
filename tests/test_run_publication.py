"""Publication swap, lock, and atomic publish tests."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    RepositorySnapshot,
    WikiManifest,
    WikiChangeSummary,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    expected_published_repository,
    make_producer_skill,
    make_published_wiki,
    make_repository,
    publish_test_pages,
    run_test_wiki,
)


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
                auto_approve_publication=True,
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
    assert published.is_dir() and not published.is_symlink()
    assert (published / "index.md").is_file()
    assert (published / "architecture.md").is_file()
    assert "# Example Wiki" in (published / "index.md").read_text(encoding="utf-8")
    assert "old publication" not in (published / "index.md").read_text(encoding="utf-8")
    # Prior tree was moved aside and removed after successful rename publish.
    assert old_release == published
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
            expected_published_repository(source_revision),
        ],
        "skill_digest": skill_version.digest,
    }
    assert datetime.fromisoformat(metadata["generated_at"]).tzinfo == UTC


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

        def fail_metadata(*_args: object, **_kwargs: object) -> None:
            raise OSError("metadata failure")

        monkeypatch.setattr("okf_wiki.run_publication._write_publication_metadata", fail_metadata)
    else:
        real_rename = os.rename
        install_failed = False

        def fail_replacement(source_path: os.PathLike[str], target_path: os.PathLike[str]) -> None:
            nonlocal install_failed
            source = Path(source_path)
            target = Path(target_path)
            # Fail only the install rename of the new release into the stable path; allow restore.
            under_releases = any(part.endswith(".releases") for part in source.parts)
            if not install_failed and target.name == published.name and under_releases:
                install_failed = True
                raise OSError("replacement failure")
            real_rename(source_path, target_path)

        monkeypatch.setattr(os, "rename", fail_replacement)

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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


@pytest.mark.parametrize("collision", ["final_release", "aside"])
def test_publication_collision_never_removes_a_competing_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, collision: str
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)
    releases = published.parent / ".published.releases"

    class FixedUUID:
        hex = "fixed"

    monkeypatch.setattr("okf_wiki.run_publication.uuid.uuid4", lambda: FixedUUID())
    if collision == "final_release":
        competing = releases / "fixed"
        competing.mkdir(parents=True)
        sentinel = competing / "sentinel"
    else:
        competing = tmp_path / ".published.aside.fixed"
        competing.mkdir()
        sentinel = competing / "sentinel"
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
    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


def test_publication_release_root_symlink_race_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    old_release = make_published_wiki(published)
    releases = published.parent / ".published.releases"
    moved_releases = tmp_path / "owned-releases"
    outside = tmp_path / "outside"
    outside.mkdir()
    real_mkdir = os.mkdir
    swapped = False

    class FixedUUID:
        hex = "fixed-release-race"

    monkeypatch.setattr("okf_wiki.run_publication.uuid.uuid4", lambda: FixedUUID())

    def swap_release_root(
        path: os.PathLike[str] | str,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal swapped
        target = Path(path)
        if target.name == FixedUUID.hex and not swapped:
            releases.rename(moved_releases)
            releases.symlink_to(outside, target_is_directory=True)
            swapped = True
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_release_root)

    with pytest.raises(ValueError, match="release directory"):
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
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


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

    monkeypatch.setattr("okf_wiki.run_publication.uuid.uuid4", lambda: FixedUUID())

    def swap_publication_parent(
        path: os.PathLike[str] | str,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal swapped
        target = Path(path)
        if target.name == FixedUUID.hex and not swapped:
            # Swap after the release directory exists under the real parent.
            parent.rename(moved_parent)
            parent.symlink_to(outside, target_is_directory=True)
            swapped = True
            # Creating under the symlinked parent would write outside; fail closed instead.
            raise FileNotFoundError(path)
        real_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap_publication_parent)

    with pytest.raises((ValueError, OSError, FileNotFoundError)):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            parent / "published",
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert swapped
    # Do not write a competing tree through the swapped parent symlink.
    assert not any(outside.rglob("*"))


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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    assert swapped


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

    with pytest.raises(
        ValueError, match="must not (overlap|contain a symbolic link|contain symlink)"
    ):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=skill_version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=publication_parent / "published",
                    auto_approve_publication=True,
                )
            )
        )

    assert not model_called
    assert not (source / "published").exists()
    assert not (source / ".published.releases").exists()


def test_concurrent_wiki_runs_fail_closed_on_publication_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    make_published_wiki(published)
    lock = published.parent / ".published.publish.lock"
    lock.write_text("pid=0\n", encoding="utf-8")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run while publication is locked")

    with pytest.raises(ValueError, match="locked by another Wiki Run"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            FunctionModel(model),
        )

    assert not model_called
    assert lock.is_file()
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


def test_publication_swap_restores_previous_tree_after_install_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    make_published_wiki(published)
    real_rename = os.rename
    failed = False

    def fail_install(source_path: os.PathLike[str], target_path: os.PathLike[str]) -> None:
        nonlocal failed
        source = Path(source_path)
        target = Path(target_path)
        under_releases = any(part.endswith(".releases") for part in source.parts)
        if not failed and target.name == published.name and under_releases:
            failed = True
            raise OSError("install failure")
        real_rename(source_path, target_path)

    monkeypatch.setattr(os, "rename", fail_install)

    with pytest.raises(OSError, match="install failure"):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert failed
    assert published.is_dir() and not published.is_symlink()
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"
    asides = list(published.parent.glob(".published.aside.*"))
    assert asides == []


def test_publication_swap_leaves_recoverable_paths_when_restore_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    make_published_wiki(published)
    real_rename = os.rename

    def fail_install_and_restore(
        source_path: os.PathLike[str], target_path: os.PathLike[str]
    ) -> None:
        target = Path(target_path)
        if target.name == published.name:
            raise OSError("swap blocked")
        real_rename(source_path, target_path)

    monkeypatch.setattr(os, "rename", fail_install_and_restore)

    with pytest.raises(ValueError, match="could not be restored|Recoverable paths"):
        publish_test_pages(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            {"index.md": SIMPLE_WIKI_PAGE},
        )

    assert not published.exists()
    asides = list(published.parent.glob(".published.aside.*"))
    assert len(asides) == 1
    assert (asides[0] / "index.md").read_text(encoding="utf-8") == "old publication\n"
    # Validated release remains under releases until cleaned by a later successful run.
    releases = published.parent / ".published.releases"
    assert any(path.is_dir() for path in releases.iterdir())


def test_successful_publish_releases_publication_lock(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    published = tmp_path / "published"
    publish_test_pages(
        source,
        revision,
        skill,
        tmp_path / "staging",
        published,
        {"index.md": SIMPLE_WIKI_PAGE},
    )
    lock = published.parent / ".published.publish.lock"
    assert not lock.exists()
    assert published.is_dir() and not published.is_symlink()
