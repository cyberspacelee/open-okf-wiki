"""Core Wiki Run lifecycle, events, and records."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    NeedsInput,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunEvent,
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    TEST_WIKI_LIMITS,
    analysis_workspace_paths,
    make_producer_skill,
    make_published_wiki,
    make_repository,
    run_records,
    write_pages_code,
    writing_model,
)


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

    monkeypatch.setattr("okf_wiki.run_records._write_run_record", fail_record)
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
    assert events[-1].payload.get("error_type") in {
        "ValueError",
        "HostValidationError",
        "ConfigError",
    }


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
    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
    assert (published / "index.md").read_text(encoding="utf-8") == "old publication\n"


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

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release
