"""Staged wiki validation and citation tests."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart, UnexpectedModelBehavior
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.host import (
    Complete,
    ModelProviderConfig,
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
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_published_wiki,
    make_repository,
    write_pages_code,
    writing_model,
)


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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


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
                    auto_approve_publication=True,
                )
            )
        )


def test_source_inventory_is_written_and_does_not_gate_citations(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    result = asyncio.run(
        WikiRunApplication().run(
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
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(result, Complete)
    # Citation to README still published successfully (inventory is not a gate).
    assert (tmp_path / "published" / "index.md").is_file()
