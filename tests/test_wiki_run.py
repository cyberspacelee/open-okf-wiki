import asyncio
import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart, UnexpectedModelBehavior
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.cli import parser
from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    NeedsInput,
    ProducerSkillRevision,
    RepositorySnapshot,
    WikiManifest,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)


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


def test_complete_wiki_run_validates_and_atomically_publishes_pages(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "# Example\n\nSource fact.\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                repository=RepositorySnapshot(path=source, revision=source_revision),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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

    assert result == Complete(manifest=WikiManifest(pages=["index.md", "architecture.md"]))
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
        "skill_digest": "e162ae46ef20a93f248df5e46ee590a2d6c6dbdc6bd69cc9d0c06ef2417b0769",
        "source_revision": source_revision,
    }
    assert datetime.fromisoformat(metadata["generated_at"]).tzinfo == UTC


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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")

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
                repository=RepositorySnapshot(path=source, revision=source_revision),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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

    assert result == Complete(manifest=WikiManifest(pages=["index.md"]))


def test_complete_validation_retry_lets_the_same_agent_fix_staging(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                repository=RepositorySnapshot(path=source, revision=source_revision),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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

    assert result == Complete(manifest=WikiManifest(pages=["index.md"]))
    assert "# Fixed Wiki" in (published / "index.md").read_text(encoding="utf-8")


def test_needs_input_leaves_the_published_wiki_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                repository=RepositorySnapshot(path=source, revision=source_revision),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                    repository=RepositorySnapshot(path=source, revision=source_revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
            if Path(target_path) == published:
                raise OSError("replacement failure")
            real_replace(source_path, target_path)

        monkeypatch.setattr(os, "replace", fail_replacement)

    with pytest.raises(OSError, match=f"{fault} failure"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision=source_revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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


def test_publication_copy_revalidates_a_page_swapped_for_a_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    published = tmp_path / "published"
    source_revision = make_repository(source, "source\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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

    real_copytree = shutil.copytree

    def swap_then_copy(
        source_path: os.PathLike[str] | str,
        destination_path: os.PathLike[str] | str,
        symlinks: bool = False,
    ) -> Path:
        if Path(source_path) == staging:
            staged_page = staging / "index.md"
            staged_page.unlink()
            staged_page.symlink_to(outside)
        return Path(real_copytree(source_path, destination_path, symlinks=symlinks))

    monkeypatch.setattr(shutil, "copytree", swap_then_copy)

    with pytest.raises(ValueError, match="Copied Wiki validation failed.*Symlink"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision=source_revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    if case == "citation_encoded_separator":
        (source / "README%2Fcopy.md").write_text("encoded separator\n", encoding="utf-8")
    elif case == "citation_query":
        (source / "README.md?draft").write_text("query-shaped path\n", encoding="utf-8")
    if case in {"citation_encoded_separator", "citation_query"}:
        subprocess.run(["git", "add", "."], cwd=source, check=True)
        subprocess.run(["git", "commit", "-qm", "adversarial source path"], cwd=source, check=True)
        source_revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                    repository=RepositorySnapshot(path=source, revision=source_revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    skill.mkdir()
    source_text = "# Example repository\n\nThe source marker is SOURCE-FIRST.\n"
    skill_text = "# Producer Skill\n\nUse the skill marker SKILL-FIRST.\n"
    source_revision = make_repository(source, source_text)
    (skill / "SKILL.md").write_text(skill_text, encoding="utf-8")
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
                repository=RepositorySnapshot(path=source, revision=source_revision),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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

    assert result == Complete(manifest=WikiManifest(pages=["index.md"]))
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
    assert metadata["skill_digest"] == (
        "c361865c20afff251deab01c2021fdda3a09d438f153c84fc50db2004d4d59fd"
    )


def test_wiki_run_rejects_nested_staging_without_creating_it(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = source / "staging"
    source.mkdir()
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for invalid mounts")

    with pytest.raises(ValueError, match="must not overlap"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision="source-rev"),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=staging,
                    publication=tmp_path / "published",
                )
            )
        )

    assert not staging.exists()


def test_wiki_run_rejects_a_publication_parent_symlink_into_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    source_revision = make_repository(source, "source\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                    repository=RepositorySnapshot(path=source, revision=source_revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an invalid checkout")

    with pytest.raises(ValueError):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision=revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=staging,
                    publication=tmp_path / "published",
                )
            )
        )

    assert not model_called


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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for unsafe Git configuration")

    with pytest.raises(ValueError, match="executable Git filters"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision=revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
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
                    repository=RepositorySnapshot(path=source, revision=revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
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


def test_model_failure_leaves_the_published_wiki_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    published = tmp_path / "published"
    revision = make_repository(source, "committed\n")
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")
    old_release = make_published_wiki(published)

    def failed_model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise RuntimeError("model failure")

    with pytest.raises(RuntimeError, match="model failure"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision=revision),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
                    model=ModelProviderConfig(model=FunctionModel(failed_model)),
                    limits=WikiRunLimits(request_timeout_seconds=5),
                    staging=tmp_path / "staging",
                    publication=published,
                )
            )
        )

    assert published.resolve() == old_release


def test_wiki_run_cli_exposes_wall_clock_deadline() -> None:
    arguments = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--skill",
            "skill",
            "--skill-revision",
            "skill-rev",
            "--staging",
            "staging",
            "--publication",
            "published",
            "--model",
            "test",
            "--wall-clock-timeout-seconds",
            "7",
        ]
    )

    assert arguments.wall_clock_timeout_seconds == 7
    assert arguments.publication == "published"
