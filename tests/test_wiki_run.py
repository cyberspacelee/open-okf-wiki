"""Core Wiki Run lifecycle, events, and records."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.host import (
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
    publication_state,
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
                auto_approve_publication=True,
            )
        )
    )

    assert isinstance(result, Complete)
    event_types = [event.type for event in events]
    assert event_types[0:5] == [
        "run_created",
        "snapshots_frozen",
        "skill_frozen",
        "validation_started",
        "validation_succeeded",
    ]
    assert "review_started" in event_types
    assert "review_succeeded" in event_types
    assert event_types[-3:] == [
        "publication_started",
        "publication_succeeded",
        "run_succeeded",
    ]
    assert len({event.run_id for event in events}) == 1
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    assert "root" in {event.node_id for event in events}
    assert "publish-reviewer" in {event.node_id for event in events}
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

    monkeypatch.setattr("okf_wiki.host.records.write_run_record", fail_record)
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
                auto_approve_publication=True,
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
                    auto_approve_publication=True,
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
                auto_approve_publication=True,
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
                    auto_approve_publication=True,
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
                auto_approve_publication=True,
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
                    auto_approve_publication=True,
                )
            )
        )

    assert published.is_dir() and not published.is_symlink()
    assert published == old_release


def test_validated_run_awaits_publication_without_auto_approve(tmp_path: Path) -> None:
    """Without YOLO / auto-approve, Host validation must not publish."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    staging = tmp_path / "staging"
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
                staging=staging,
                publication=publication,
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert result.summary.publication_changed is True
    assert not publication.exists()
    assert (staging / "index.md").is_file()
    [record] = run_records(publication)
    assert record["status"] == "awaiting_publication"
    assert record["publication"]["status"] == "awaiting_publication"
    assert record["publication"]["changed"] is False
    event_types = [event.type for event in events]
    assert event_types[0:5] == [
        "run_created",
        "snapshots_frozen",
        "skill_frozen",
        "validation_started",
        "validation_succeeded",
    ]
    assert "review_started" in event_types
    assert "review_succeeded" in event_types
    assert event_types[-1] == "awaiting_publication"
    assert "publication_started" not in set(event_types)
    assert "publication_succeeded" not in set(event_types)
    assert record["publication"]["reviewer"]["status"] == "complete"


def test_yolo_auto_approve_publishes_after_validation(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"

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
                publication=publication,
                auto_approve_publication=True,
            )
        )
    )

    assert isinstance(result, Complete)
    assert (publication / "index.md").is_file()
    [record] = run_records(publication)
    assert record["status"] == "complete"
    assert record["publication"]["status"] == "published"
    assert record["publication"]["changed"] is True
    assert record["publication"]["reviewer"]["status"] == "complete"


def test_in_process_approval_handler_publishes(tmp_path: Path) -> None:
    """Operator Session / tests can approve deferred publish via Host handler."""
    from okf_wiki.host.publication.gate import build_approve_results
    from pydantic_ai.tools import DeferredToolRequests

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    seen: list[DeferredToolRequests] = []

    def approve_all(requests: DeferredToolRequests):
        seen.append(requests)
        return build_approve_results(requests)

    result = asyncio.run(
        WikiRunApplication(publication_approval_handler=approve_all).run(
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
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert len(seen) == 1
    assert seen[0].approvals
    assert seen[0].approvals[0].tool_name == "publish_wiki"
    assert "defects" in (seen[0].approvals[0].args or {})
    assert (publication / "index.md").is_file()
    [record] = run_records(publication)
    assert record["status"] == "complete"
    assert record["publication"]["status"] == "published"
    assert record["publication"]["changed"] is True


def test_in_process_deny_keeps_staging_and_published_unchanged(tmp_path: Path) -> None:
    """Deny: no publish, Staging retained, Published byte-identical, declined status."""
    from okf_wiki.host.publication.gate import build_deny_results

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    staging = tmp_path / "staging"
    old_release = make_published_wiki(publication)
    before = publication_state(publication)
    events: list[WikiRunEvent] = []

    def deny_all(requests):
        return build_deny_results(requests)

    result = asyncio.run(
        WikiRunApplication(
            observer=events.append,
            publication_approval_handler=deny_all,
        ).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=staging,
                publication=publication,
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert result.summary.publication_changed is True
    # Staging from the run remains available for further Session work.
    assert (staging / "index.md").is_file()
    assert (staging / "index.md").read_text(encoding="utf-8") == SIMPLE_WIKI_PAGE
    # Published Wiki is byte-identical to its pre-run state (same inode + files).
    assert publication.is_dir() and not publication.is_symlink()
    assert publication == old_release
    assert publication_state(publication) == before
    assert (publication / "index.md").read_text(encoding="utf-8") == "old publication\n"
    [record] = run_records(publication)
    assert record["status"] == "publication_declined"
    assert record["publication"]["status"] == "publication_declined"
    assert record["publication"]["changed"] is False
    assert record["publication"]["reviewer"]["status"] == "complete"
    event_types = [event.type for event in events]
    assert event_types[0:5] == [
        "run_created",
        "snapshots_frozen",
        "skill_frozen",
        "validation_started",
        "validation_succeeded",
    ]
    assert "review_started" in event_types
    assert event_types[-1] == "publication_declined"
    assert "publication_started" not in set(event_types)
    assert "publication_succeeded" not in set(event_types)
    assert "run_succeeded" not in set(event_types)


def test_in_process_deny_with_false_approval_value(tmp_path: Path) -> None:
    """Bare ``False`` in deferred approvals is treated as deny (not await)."""
    from okf_wiki.host.publication.gate import build_deny_results

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    staging = tmp_path / "staging"

    def deny_false(requests):
        return build_deny_results(requests, as_bool=True)

    result = asyncio.run(
        WikiRunApplication(publication_approval_handler=deny_false).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=staging,
                publication=publication,
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert not publication.exists()
    assert (staging / "index.md").is_file()
    [record] = run_records(publication)
    assert record["status"] == "publication_declined"
    assert record["publication"]["status"] == "publication_declined"
    assert record["publication"]["changed"] is False


def test_validation_failure_never_reaches_publication_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Invalid Staging must not invoke the approval gate or publish."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    gate_calls = 0

    async def unexpected_gate(**_: object):
        nonlocal gate_calls
        gate_calls += 1
        raise AssertionError("publication gate must not run after validation failure")

    monkeypatch.setattr(
        "okf_wiki.host.publication.finalize.resolve_publication_approval", unexpected_gate
    )

    # Staged page omits required citation — output_validator retries then fails.
    bad_page = "---\ntitle: Wiki\n---\n# Wiki\n\nNo citation.\n"
    with pytest.raises(Exception):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=skill,
                    model=ModelProviderConfig(
                        model=writing_model(write_pages_code({"index.md": bad_page}), ["index.md"])
                    ),
                    limits=TEST_WIKI_LIMITS,
                    staging=tmp_path / "staging",
                    publication=publication,
                    auto_approve_publication=True,
                )
            )
        )

    assert gate_calls == 0
    assert not publication.exists() or not (publication / "index.md").exists()


def test_non_adaptive_path_runs_reviewer_before_publish_gate(tmp_path: Path) -> None:
    """Host-owned Wiki Reviewer runs on non-adaptive generate before HITL publish."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    events: list[WikiRunEvent] = []
    seen_defects: list[object] = []

    def await_with_defects(requests):
        args = requests.approvals[0].args or {}
        seen_defects.append(args.get("defects"))
        return None  # keep awaiting so gate is still required after review

    result = asyncio.run(
        WikiRunApplication(
            observer=events.append,
            publication_approval_handler=await_with_defects,
        ).run(
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
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert not publication.exists()
    event_types = [event.type for event in events]
    assert "review_started" in event_types
    assert "review_succeeded" in event_types
    assert event_types.index("review_started") > event_types.index("validation_succeeded")
    assert event_types[-1] == "awaiting_publication"
    assert len(seen_defects) == 1
    defects0 = seen_defects[0]
    assert defects0 is not None
    status = defects0.get("status") if isinstance(defects0, dict) else None
    count = defects0.get("defect_count") if isinstance(defects0, dict) else None
    assert status == "complete"
    assert count == 0
    [record] = run_records(publication)
    assert record["status"] == "awaiting_publication"
    assert record["publication"]["reviewer"]["status"] == "complete"


def test_disable_reviewer_skips_agent_not_validation(tmp_path: Path) -> None:
    """adaptive_enable_reviewer=false skips Reviewer but Host validation still runs."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    events: list[WikiRunEvent] = []
    gate_defects: list[object] = []

    def capture(requests):
        args = requests.approvals[0].args or {}
        gate_defects.append(args.get("defects"))
        return requests.build_results(approve_all=True)

    result = asyncio.run(
        WikiRunApplication(
            observer=events.append,
            publication_approval_handler=capture,
        ).run(
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
                    adaptive_enable_reviewer=False,
                ),
                staging=tmp_path / "staging",
                publication=publication,
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert (publication / "index.md").is_file()
    event_types = [event.type for event in events]
    assert "validation_started" in event_types
    assert "validation_succeeded" in event_types
    assert "review_started" not in event_types
    assert "review_succeeded" not in event_types
    assert gate_defects == [None]
    [record] = run_records(publication)
    assert record["status"] == "complete"
    assert "reviewer" not in record["publication"]


def test_gate_still_requires_approval_after_successful_review(tmp_path: Path) -> None:
    """Review does not auto-publish; HITL gate still applies after defects are attached."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"

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
                publication=publication,
                auto_approve_publication=False,
            )
        )
    )

    assert isinstance(result, Complete)
    assert not publication.exists()
    [record] = run_records(publication)
    assert record["status"] == "awaiting_publication"
    assert record["publication"]["reviewer"]["status"] == "complete"


def test_optional_reviewer_model_is_wired_into_host_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Optional reviewer_model is prepared and used for Host pre-publish review."""
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    producer = writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
    reviewer = writing_model("raise RuntimeError('reviewer must not write pages')", ["index.md"])
    seen_models: list[object] = []

    async def capture_review(**kwargs: object):
        seen_models.append(kwargs.get("model"))
        from okf_wiki.host.adaptive import ReviewDefectsSummary

        return ReviewDefectsSummary(
            status="complete",
            summary="captured",
            findings=("one issue",),
            defect_count=1,
        )

    monkeypatch.setattr("okf_wiki.host.adaptive.reviewer.run_host_wiki_reviewer", capture_review)

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(model=producer),
                reviewer_model=ModelProviderConfig(model=reviewer),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
                auto_approve_publication=True,
            )
        )
    )

    assert isinstance(result, Complete)
    assert (publication / "index.md").is_file()
    assert len(seen_models) == 1
    # prepare_model_with_provider_retry may wrap; identity is still the reviewer FunctionModel.
    assert seen_models[0] is not None
    [record] = run_records(publication)
    assert record["publication"]["reviewer"]["defect_count"] == 1
    assert record["publication"]["reviewer"]["findings"] == ["one issue"]
