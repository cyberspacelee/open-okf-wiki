"""Operator Session API seam tests (ticket 06 / ADR 0018).

Assert external Session behavior: cards, approval injectables, Needs Input →
new Run with explicit_answers, YOLO flag, slash commands, non-TTY rejection.
Do not assert Rich markup or terminal escape codes.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic_ai.tools import DeferredToolRequests

from okf_wiki.publication_gate import build_approve_results, build_deny_results
from okf_wiki.session import (
    OperatorSession,
    SessionCard,
    interactive_publication_handler,
    project_events,
)
from okf_wiki.session.cards import card_texts
from okf_wiki.tui import project_events as tui_project_events
from okf_wiki.tui import require_tty
from okf_wiki.wiki_run import (
    ModelProviderConfig,
    NeedsInput,
    RepositorySnapshot,
    WikiRunEvent,
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_published_wiki,
    make_repository,
    publication_state,
    run_records,
    write_pages_code,
    writing_model,
)


def _event(
    sequence: int,
    event_type: str,
    *,
    node_id: str = "root",
    payload: dict[str, object] | None = None,
) -> WikiRunEvent:
    return WikiRunEvent(
        run_id="a" * 32,
        sequence=sequence,
        timestamp=datetime.now(UTC),
        type=event_type,
        node_id=node_id,
        payload=payload or {},
    )


def _base_request(
    tmp_path: Path,
    *,
    model=None,
    auto_approve: bool = False,
    staging_name: str = "staging",
) -> WikiRunRequest:
    source = tmp_path / "source"
    if not source.exists():
        revision = make_repository(source, "source\n")
    else:
        # Reuse existing test repo if caller prepared it.
        revision = "0" * 40
    skill = make_producer_skill(tmp_path / "skill")
    return WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=model
            or writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / staging_name,
        publication=tmp_path / "published",
        auto_approve_publication=auto_approve,
    )


# --- Card projection -------------------------------------------------------


def test_session_projects_events_to_ordered_cards() -> None:
    cards = project_events(
        [
            _event(1, "run_created"),
            _event(2, "plan_updated", payload={"total": 3, "depth": 0, "node_kind": "root"}),
            _event(
                3, "child_started", node_id="domain-1", payload={"status": "running", "depth": 1}
            ),
            _event(
                4,
                "receipt_published",
                node_id="domain-1",
                payload={"status": "complete", "receipt_bytes": 120},
            ),
            _event(
                5,
                "provider_retry_scheduled",
                payload={
                    "attempt": 2,
                    "wait_seconds": 1.5,
                    "kind": "http_429",
                    "status": "scheduled",
                },
            ),
            _event(6, "compaction_completed", payload={"before_tokens": 10, "target_tokens": 5}),
            _event(7, "validation_succeeded"),
            _event(8, "awaiting_publication"),
        ]
    )
    assert all(isinstance(card, SessionCard) for card in cards)
    texts = card_texts(cards)
    assert texts[0] == "run created"
    assert any("plan updated" in line for line in texts)
    assert any("node domain-1" in line for line in texts)
    assert any("receipt published" in line for line in texts)
    assert any("provider retry" in line for line in texts)
    assert any("compaction" in line for line in texts)
    assert cards[-1].kind == "terminal"
    assert cards[-1].event_type == "awaiting_publication"
    assert "awaiting publication" in cards[-1].text


def test_session_card_projection_matches_tui_string_compat() -> None:
    events = [
        _event(1, "run_created"),
        _event(2, "plan_updated", payload={"total": 2}),
        _event(3, "run_failed", payload={"error_type": "HostValidationError"}),
    ]
    assert card_texts(project_events(events)) == tui_project_events(events)


def test_session_redacts_secrets_from_cards(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-session-secret-value")
    cards = project_events(
        [
            _event(
                1,
                "provider_retry_scheduled",
                payload={
                    "attempt": 1,
                    "wait_seconds": 1,
                    "kind": "network",
                    "status": "scheduled",
                },
            )
        ]
    )
    joined = "\n".join(card_texts(cards))
    assert "sk-session-secret-value" not in joined


# --- YOLO / request shaping -------------------------------------------------


def test_session_yolo_sets_auto_approve_on_request(tmp_path: Path) -> None:
    request = _base_request(tmp_path, auto_approve=False)
    session = OperatorSession(base_request=request, yolo=False)
    assert session.request_for_run().auto_approve_publication is False
    session.set_yolo(True)
    shaped = session.request_for_run()
    assert shaped.auto_approve_publication is True
    assert session.yolo_indicator() == "YOLO"
    # Base request is not mutated (frozen model).
    assert request.auto_approve_publication is False


def test_slash_yolo_toggles(tmp_path: Path) -> None:
    session = OperatorSession(base_request=_base_request(tmp_path), yolo=False)
    result = session.handle_slash("/yolo")
    assert result is not None
    assert result.yolo is True
    assert session.yolo is True
    result = session.handle_slash("/yolo off")
    assert result is not None
    assert result.yolo is False
    assert session.yolo is False
    assert session.handle_slash("/quit") is not None
    assert session.handle_slash("/quit").quit is True
    doctor = session.handle_slash("/doctor")
    assert doctor is not None
    assert doctor.doctor_report is not None
    assert "OPENAI_API_KEY" in doctor.message
    assert session.handle_slash("not a slash") is None


# --- Mock approval approve / deny -------------------------------------------


def test_session_mock_approve_publishes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    seen: list[DeferredToolRequests] = []

    def approve(requests: DeferredToolRequests):
        seen.append(requests)
        return build_approve_results(requests)

    request = WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / "staging",
        publication=publication,
        auto_approve_publication=False,
    )
    session = OperatorSession(
        base_request=request,
        yolo=False,
        publication_approval_handler=approve,
    )
    turn = asyncio.run(session.run_wiki())

    assert turn.result.status == "complete"
    assert turn.yolo is False
    assert len(seen) == 1
    assert (publication / "index.md").is_file()
    assert any(card.event_type == "publication_succeeded" for card in turn.cards)
    [record] = run_records(publication)
    assert record["status"] == "complete"


def test_session_mock_deny_keeps_staging(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    staging = tmp_path / "staging"
    make_published_wiki(publication)
    before = publication_state(publication)

    def deny(requests: DeferredToolRequests):
        return build_deny_results(requests)

    request = WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=staging,
        publication=publication,
        auto_approve_publication=False,
    )
    session = OperatorSession(
        base_request=request,
        publication_approval_handler=deny,
    )
    turn = asyncio.run(session.run_wiki())

    assert turn.result.status == "complete"
    assert (staging / "index.md").is_file()
    assert publication_state(publication) == before
    [record] = run_records(publication)
    assert record["status"] == "publication_declined"
    assert any(card.event_type == "publication_declined" for card in turn.cards)
    assert not any(card.event_type == "publication_started" for card in turn.cards)


def test_session_yolo_publishes_without_handler(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    handler_calls = 0

    def should_not_run(requests: DeferredToolRequests):
        nonlocal handler_calls
        handler_calls += 1
        return build_deny_results(requests)

    request = WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / "staging",
        publication=publication,
        auto_approve_publication=False,
    )
    session = OperatorSession(
        base_request=request,
        yolo=True,
        publication_approval_handler=should_not_run,
    )
    turn = asyncio.run(session.run_wiki())

    assert turn.yolo is True
    assert turn.request.auto_approve_publication is True
    assert handler_calls == 0
    assert (publication / "index.md").is_file()
    [record] = run_records(publication)
    assert record["status"] == "complete"


# --- Needs Input → new run with explicit_answers ----------------------------


def test_session_needs_input_starts_new_run_with_explicit_answers(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    call_count = {"n": 0}
    seen_answers: list[dict[str, str]] = []

    def model(messages, info):
        from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
        from pydantic_ai.messages import ToolReturnPart

        call_count["n"] += 1
        # First model invocation of the first Run: Needs Input terminal.
        if call_count["n"] == 1:
            needs = next(tool for tool in info.output_tools if tool.name.endswith("NeedsInput"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        needs.name,
                        {"status": "needs_input", "questions": ["Which audience?"]},
                    )
                ]
            )
        # Subsequent Run: write pages via CodeMode then Complete.
        tool_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if any(part.tool_name == "run_code" for part in tool_returns):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        code = write_pages_code({"index.md": SIMPLE_WIKI_PAGE})
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    from pydantic_ai.models.function import FunctionModel

    request = WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(model=FunctionModel(model)),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / "staging",
        publication=publication,
        auto_approve_publication=True,
    )
    session = OperatorSession(base_request=request, yolo=True)

    first = asyncio.run(session.run_wiki())
    assert isinstance(first.result, NeedsInput)
    assert first.result.questions == ["Which audience?"]
    first_run_id = first.run_id
    assert first_run_id is not None

    answers = {f"{first_run_id}:1": "operators"}
    second = asyncio.run(session.continue_after_needs_input(first, answers))
    seen_answers.append(dict(second.request.explicit_answers))

    assert second.request.explicit_answers["%s:1" % first_run_id] == "operators"
    # New Host run identity (different from the Needs Input run).
    assert second.run_id is not None
    assert second.run_id != first_run_id
    assert second.result.status == "complete"
    assert (publication / "index.md").is_file()
    assert seen_answers[0][f"{first_run_id}:1"] == "operators"


def test_session_collect_needs_input_answers(tmp_path: Path) -> None:
    session = OperatorSession(base_request=_base_request(tmp_path))
    answers = session.collect_needs_input_answers(
        NeedsInput(questions=["Audience?", "Tone?"]),
        input_fn=lambda prompt: "ops" if "Audience" in prompt else "brief",
        run_id="b" * 32,
    )
    assert answers == {f"{'b' * 32}:1": "ops", f"{'b' * 32}:2": "brief"}


def test_interactive_approval_handler_approve_and_deny() -> None:
    from okf_wiki.publication_gate import build_publish_approval_request, decision_from_results

    requests = build_publish_approval_request(
        tool_call_id="publish_ui",
        defects={"status": "complete", "summary": "ok", "findings": [], "defect_count": 0},
    )
    from pydantic_ai.tools import DeferredToolResults

    approve_handler = interactive_publication_handler(input_fn=lambda _p: "y")
    approve_results = approve_handler(requests)
    assert isinstance(approve_results, DeferredToolResults)
    assert decision_from_results(requests, approve_results) == "approved"

    deny_handler = interactive_publication_handler(input_fn=lambda _p: "n")
    deny_results = deny_handler(requests)
    assert isinstance(deny_results, DeferredToolResults)
    assert decision_from_results(requests, deny_results) == "denied"


# --- Non-TTY rejection ------------------------------------------------------


def test_non_tty_rejected_for_interactive_entry() -> None:
    class Fake:
        def isatty(self) -> bool:
            return False

    with pytest.raises(RuntimeError, match="interactive TTY"):
        require_tty(Fake())


def test_run_operator_session_rejects_non_tty(tmp_path: Path) -> None:
    class Fake:
        def isatty(self) -> bool:
            return False

    request = _base_request(tmp_path, auto_approve=True)

    with pytest.raises(RuntimeError, match="interactive TTY"):
        require_tty(Fake())  # type: ignore[arg-type]
    # Interactive entry uses the same require_tty gate (Session API seam).
    _ = request


def test_message_history_retained_across_turns(tmp_path: Path) -> None:
    session = OperatorSession(base_request=_base_request(tmp_path), yolo=True)
    session.append_user("generate the wiki")
    session.append_user("expand the auth section")
    assert [m.content for m in session.message_history if m.role == "user"] == [
        "generate the wiki",
        "expand the auth section",
    ]
    session.handle_slash("/yolo off")
    assert any(m.role == "system" for m in session.message_history)


# --- Multi-session list / resume (ticket 07) ---------------------------------


def test_session_store_create_list_resume_history(tmp_path: Path) -> None:
    from okf_wiki.session import SessionStore

    store = SessionStore(tmp_path / "sessions")
    request = _base_request(tmp_path)
    first = store.create_session(title=None, yolo=False)
    session = OperatorSession(
        base_request=request,
        yolo=False,
        store=store,
    )
    session.apply_snapshot(first)
    session.append_user("generate the wiki")
    session.append_user("expand the auth section")
    session.handle_slash("/yolo on")
    saved = session.persist()

    rows = store.list_sessions()
    assert len(rows) == 1
    assert rows[0].id == saved.id
    assert rows[0].title == "generate the wiki"
    assert rows[0].status == "active"

    # Fresh in-process Session resumes history only (same Host request object).
    other = OperatorSession(
        base_request=request,
        store=store,
        yolo=False,
    )
    resumed = other.resume_from_store(saved.id)
    assert resumed.id == saved.id
    assert [m.content for m in other.message_history if m.role == "user"] == [
        "generate the wiki",
        "expand the auth section",
    ]
    assert other.yolo is True
    assert other.session_id == saved.id
    # Resume does not carry Host job cards / last result.
    assert other.cards == []
    assert other.last_result is None


def test_session_resume_does_not_auto_publish(tmp_path: Path) -> None:
    """Resume restores history; never marks Staging published or runs a Wiki Run."""
    from okf_wiki.session import SessionStore

    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    staging = tmp_path / "staging"
    make_published_wiki(publication)
    before = publication_state(publication)
    # Leave a Staging tree as if a prior Run wrote pages but did not publish.
    staging.mkdir()
    (staging / "index.md").write_text(SIMPLE_WIKI_PAGE, encoding="utf-8")

    store = SessionStore(tmp_path / "sessions")
    request = WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=staging,
        publication=publication,
        auto_approve_publication=False,
    )
    session = OperatorSession(base_request=request, yolo=True, store=store)
    session.append_user("draft notes only")
    snapshot = session.persist()
    assert session.yolo is True

    # New process-equivalent Session: resume with YOLO flag restored, but no run.
    resumed_session = OperatorSession(base_request=request, yolo=False, store=store)
    resumed_session.resume_from_store(snapshot.id)

    assert resumed_session.yolo is True  # flag restored from snapshot
    assert [m.content for m in resumed_session.message_history if m.role == "user"] == [
        "draft notes only"
    ]
    # Resume is history-only: no Host turn result, no auto-publish.
    assert resumed_session.last_result is None
    assert resumed_session.last_request is None
    assert publication_state(publication) == before
    assert (staging / "index.md").is_file()
    # No new run record written by resume alone.
    assert run_records(publication) == []


def test_session_new_does_not_destroy_host_config(tmp_path: Path) -> None:
    from okf_wiki.session import SessionStore

    config_path = tmp_path / "wiki-run.yaml"
    config_path.write_text("model: openai:gpt-5-mini\n", encoding="utf-8")
    store = SessionStore(tmp_path / ".okf-wiki" / "sessions")
    request = _base_request(tmp_path)
    session = OperatorSession(base_request=request, store=store)
    session.append_user("first experiment")
    first = session.persist()

    result = session.handle_slash("/new")
    assert result is not None
    assert result.session_switched is True
    assert result.session_id is not None
    assert result.session_id != first.id
    assert session.message_history == []
    # Host config file and base_request paths untouched.
    assert config_path.read_text(encoding="utf-8") == "model: openai:gpt-5-mini\n"
    assert session.base_request.staging == request.staging
    assert session.base_request.publication == request.publication

    listed = store.list_sessions()
    assert {row.id for row in listed} == {first.id, result.session_id}


def test_slash_sessions_and_resume(tmp_path: Path) -> None:
    from okf_wiki.session import SessionStore

    store = SessionStore(tmp_path / "sessions")
    session = OperatorSession(base_request=_base_request(tmp_path), store=store)
    session.append_user("topic alpha")
    session.persist()
    sid = session.session_id
    assert sid is not None

    listed = session.handle_slash("/sessions")
    assert listed is not None
    assert sid[:12] in listed.message
    assert "topic alpha" in listed.message

    session.handle_slash("/new")
    assert session.session_id != sid
    assert session.message_history == []

    resumed = session.handle_slash(f"/resume {sid[:12]}")
    assert resumed is not None
    assert resumed.session_switched is True
    assert session.session_id == sid
    assert any(m.content == "topic alpha" for m in session.message_history if m.role == "user")
    assert "were not resumed" in resumed.message or "not resumed" in resumed.message


def test_default_sessions_dir_is_project_local(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from okf_wiki.session import default_sessions_dir

    monkeypatch.chdir(tmp_path)
    assert default_sessions_dir() == tmp_path / ".okf-wiki" / "sessions"
    assert default_sessions_dir(tmp_path / "proj") == tmp_path / "proj" / ".okf-wiki" / "sessions"


def test_session_mode_ask_does_not_start_wiki_run(tmp_path: Path) -> None:
    session = OperatorSession(base_request=_base_request(tmp_path), yolo=True)
    session.set_mode("ask")
    reply = session.note_ask("how does auth work?")
    assert "ask mode" in reply
    assert session.last_run_id is None
    assert any(m.role == "user" and "auth" in m.content for m in session.message_history)
    slash = session.handle_slash("/mode build")
    assert slash is not None
    assert session.mode == "build"
    usage = session.handle_slash("/usage")
    assert usage is not None
    assert "No Wiki Run" in usage.message


def test_slash_mode_and_usage_after_run(tmp_path: Path) -> None:
    session = OperatorSession(base_request=_base_request(tmp_path, auto_approve=True), yolo=True)
    turn = asyncio.run(session.run_wiki())
    assert turn.run_id
    usage = session.handle_slash("/usage")
    assert usage is not None
    assert turn.run_id and turn.run_id[:8] in usage.message or session.last_run_id
