"""Resource limit and quota tests."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.run import (
    ModelProviderConfig,
    RepositorySnapshot,
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
    write_pages_code,
    writing_model,
)


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
                    auto_approve_publication=True,
                )
            )
        )

    assert model_started
    assert published.is_dir() and not published.is_symlink()
    assert published == old_release


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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
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
                    auto_approve_publication=True,
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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release


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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
