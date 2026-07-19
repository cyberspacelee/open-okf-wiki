"""Wiki refresh operation tests."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart, UnexpectedModelBehavior
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.cli import main
from okf_wiki.run import (
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
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    expected_published_repository,
    generated_test_wiki,
    make_producer_skill,
    make_repository,
    publication_state,
    publish_test_pages,
    run_test_wiki,
    write_pages_code,
    writing_model,
)


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
    before_state = publication_state(published)
    old_metadata = (published / ".okf-wiki.json").read_bytes()

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
    assert publication_state(published) != before_state
    assert (published / ".okf-wiki.json").read_bytes() != old_metadata
    assert published.is_dir() and not published.is_symlink()
    assert not (published / "legacy.md").exists()
    assert "[Flow](flow.md#flow)" in (published / "index.md").read_text(encoding="utf-8")
    metadata = json.loads((published / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["repositories"] == [expected_published_repository(source_revision)]
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
    before_state = publication_state(published)
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
    assert publication_state(published) != before_state
    assert published.is_dir() and not published.is_symlink()
    metadata = json.loads((published / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["repositories"] == [expected_published_repository(source_revision)]
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
    before_state = publication_state(published)
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
    assert publication_state(published) == before_state


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
                    auto_approve_publication=True,
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

        def fail_metadata(*_args: object, **_kwargs: object) -> None:
            raise OSError("refresh metadata failure")

        monkeypatch.setattr(
            "okf_wiki.run.publication.fs._write_publication_metadata", fail_metadata
        )
    else:
        real_rename = os.rename
        install_failed = False

        def fail_replacement(
            source_path: os.PathLike[str], destination_path: os.PathLike[str]
        ) -> None:
            nonlocal install_failed
            source = Path(source_path)
            target = Path(destination_path)
            under_releases = any(part.endswith(".releases") for part in source.parts)
            if not install_failed and target.name == published.name and under_releases:
                install_failed = True
                raise OSError("refresh replacement failure")
            real_rename(source_path, destination_path)

        monkeypatch.setattr(os, "rename", fail_replacement)

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


def test_refresh_rejects_legacy_symlink_published_wiki_before_model_work(
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
        raise AssertionError("model must not run for legacy symlink refresh")

    with pytest.raises(ValueError, match="symbolic link|legacy|real-directory"):
        run_test_wiki(
            source,
            revision,
            skill,
            tmp_path / "staging",
            published,
            FunctionModel(model),
            operation="refresh",
        )

    assert not model_called


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
