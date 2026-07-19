"""Fullscreen Operator Session TUI (Textual) — composition and stream projection.

Do not assert terminal color escapes. Prefer Pilot for widget structure.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    PartDeltaEvent,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPart,
)

from okf_wiki.session.app import (
    HintBar,
    OperatorSessionApp,
    SessionInput,
    StatusCard,
    SystemNotice,
)
from okf_wiki.session.runtime import (
    apply_slash_completion,
    format_slash_help,
    list_slash_completions,
)
from okf_wiki.session.store import SessionStore
from okf_wiki.session.stream import project_stream_event
from okf_wiki.run import ModelProviderConfig, RepositorySnapshot, WikiRunRequest
from textual.widgets import Footer

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_repository,
    write_pages_code,
    writing_model,
)


def _base_request(tmp_path: Path, *, auto_approve: bool = True) -> WikiRunRequest:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    return WikiRunRequest(
        repositories=(RepositorySnapshot(path=source, revision=revision),),
        skill=skill,
        model=ModelProviderConfig(
            model=writing_model(write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"])
        ),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / "staging",
        publication=tmp_path / "published",
        auto_approve_publication=auto_approve,
    )


# --- Stream projection (framework events → UI fragments) --------------------


def test_project_stream_text_delta_redacts_and_keeps_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-stream")
    frag = project_stream_event(
        PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="hello sk-secret-stream"))
    )
    assert frag is not None
    assert frag.kind == "text"
    assert "hello" in frag.text
    assert "sk-secret-stream" not in frag.text


def test_project_stream_skips_thinking_deltas() -> None:
    frag = project_stream_event(
        PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="secret chain of thought"))
    )
    assert frag is None


def test_project_stream_tool_call_is_name_only() -> None:
    frag = project_stream_event(
        FunctionToolCallEvent(
            part=ToolCallPart(
                tool_name="run_code",
                args={"code": "print('nope')"},
                tool_call_id="t1",
            )
        )
    )
    assert frag is not None
    assert frag.kind == "tool"
    assert "run_code" in frag.text
    assert "print" not in frag.text


# --- Slash completion (pure helpers) ----------------------------------------


def test_list_slash_completions_prefix_and_args() -> None:
    assert "/help" in list_slash_completions("/he")
    assert list_slash_completions("/help") == ["/help"]
    assert list_slash_completions("goal") == []
    mode = list_slash_completions("/mode ")
    assert "/mode build" in mode and "/mode ask" in mode
    assert list_slash_completions("/mode b") == ["/mode build"]
    yolo = list_slash_completions("/yolo ")
    assert "/yolo on" in yolo and "/yolo off" in yolo
    # Session refs: numbers + short ids (newest-first index order).
    ids = ["aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb", "ccccccccccccccccdddddddddddddddd"]
    switch = list_slash_completions("/switch ", session_ids=ids)
    assert "/switch 1" in switch and "/switch 2" in switch
    assert any(ids[0][:12] in item for item in switch)
    sessions = list_slash_completions("/sessions 2", session_ids=ids)
    assert "/sessions 2" in sessions


def test_apply_slash_completion_unique_common_and_cycle() -> None:
    assert apply_slash_completion("/he") == "/help"
    # Exact command with fixed args expands to trailing space.
    assert apply_slash_completion("/mode") == "/mode "
    # Multiple matches: longest common prefix, then cycle.
    many = list_slash_completions("/")
    assert len(many) > 1
    first = apply_slash_completion("/")
    assert first is not None
    assert first.startswith("/")
    # Cycling from a full match advances.
    cycled = apply_slash_completion(many[0])
    assert cycled in many
    assert apply_slash_completion(many[0], reverse=True) in many


def test_format_slash_help_lists_commands() -> None:
    text = format_slash_help().lower()
    for token in ("/run", "/yolo", "/mode", "/help", "/quit", "does not auto-start", "tab"):
        assert token in text


# --- Textual app structure --------------------------------------------------


def test_operator_session_app_composes_chat_composer_and_footer(tmp_path: Path) -> None:
    request = _base_request(tmp_path, auto_approve=True)
    app = OperatorSessionApp(
        request,
        yolo=True,
        auto_start=False,
        max_turns=0,
        sessions_dir=tmp_path / "sessions",
    )

    async def scenario() -> None:
        async with app.run_test():
            assert app.query_one("#chat-view") is not None
            assert app.query_one("#composer") is not None
            assert app.query_one("#hint-bar", HintBar) is not None
            assert app.query_one("#session-input", SessionInput) is not None
            assert app.query_one(Footer) is not None
            # Input must not dock bottom (that stacks over Footer labels).
            inp = app.query_one("#session-input", SessionInput)
            assert str(inp.styles.dock) in {"", "none"}
            cards = list(app.query(StatusCard))
            assert len(cards) >= 1

    asyncio.run(scenario())


def test_operator_session_app_slash_help(tmp_path: Path) -> None:
    request = _base_request(tmp_path, auto_approve=True)
    app = OperatorSessionApp(
        request,
        yolo=True,
        auto_start=False,
        sessions_dir=tmp_path / "sessions",
    )

    async def scenario() -> None:
        async with app.run_test() as pilot:
            await pilot.click("#session-input")
            await pilot.press(*list("/help"))
            await pilot.press("enter")
            await pilot.pause()
            status_text = "\n".join(str(widget.render()) for widget in app.query(StatusCard))
            lowered = status_text.lower()
            assert any(
                token in lowered
                for token in ("help", "/yolo", "usage", "slash", "session", "doctor", "quit")
            )

    asyncio.run(scenario())


def test_operator_session_app_tab_completes_slash_command(tmp_path: Path) -> None:
    request = _base_request(tmp_path, auto_approve=True)
    app = OperatorSessionApp(
        request,
        yolo=True,
        auto_start=False,
        max_turns=0,
        sessions_dir=tmp_path / "sessions",
    )

    async def scenario() -> None:
        async with app.run_test() as pilot:
            inp = app.query_one("#session-input", SessionInput)
            await pilot.click("#session-input")
            await pilot.press(*list("/he"))
            await pilot.press("tab")
            await pilot.pause()
            assert inp.value == "/help"
            hint = str(app.query_one("#hint-bar", HintBar).render()).lower()
            assert "help" in hint or "tab" in hint

    asyncio.run(scenario())


def test_operator_session_app_hint_bar_shows_matches_while_typing(tmp_path: Path) -> None:
    request = _base_request(tmp_path, auto_approve=True)
    app = OperatorSessionApp(
        request,
        yolo=True,
        auto_start=False,
        max_turns=0,
        sessions_dir=tmp_path / "sessions",
    )

    async def scenario() -> None:
        async with app.run_test() as pilot:
            await pilot.click("#session-input")
            await pilot.press(*list("/mo"))
            await pilot.pause()
            hint = str(app.query_one("#hint-bar", HintBar).render()).lower()
            assert "mode" in hint

    asyncio.run(scenario())


def test_operator_session_app_switch_clears_chat_and_sessions_by_index(
    tmp_path: Path,
) -> None:
    """/new and /sessions N clear run progress cards and reload the target Session."""
    request = _base_request(tmp_path, auto_approve=True)
    sessions_dir = tmp_path / "sessions"
    app = OperatorSessionApp(
        request,
        yolo=True,
        auto_start=False,
        sessions_dir=sessions_dir,
    )

    async def scenario() -> None:
        async with app.run_test() as pilot:
            chat = app.query_one("#chat-view")
            # Seed a run progress card that must vanish on Session switch.
            chat.mount(StatusCard("stale host card from prior run"))
            await pilot.pause()
            assert any("stale host card" in str(w.render()) for w in app.query(StatusCard))

            await pilot.click("#session-input")
            # Create a second Session so index switching is meaningful.
            await pilot.press(*list("/new"))
            await pilot.press("enter")
            await pilot.pause()

            # Stale card from the previous Session view must be gone.
            stale = [w for w in app.query(StatusCard) if "stale host card" in str(w.render())]
            assert stale == []
            notices = list(app.query(SystemNotice))
            assert notices, "switch/new banner should use SystemNotice"
            assert any("new session" in str(n.render()).lower() for n in notices)

            # List Sessions as a multi-line panel.
            await pilot.press(*list("/sessions"))
            await pilot.press("enter")
            await pilot.pause()
            panel_text = "\n".join(str(n.render()) for n in app.query(SystemNotice))
            assert "operator sessions" in panel_text.lower()

            # Switch back to the first Session by list index (oldest = 2).
            store = SessionStore(sessions_dir)
            rows = store.list_sessions()
            assert len(rows) >= 2
            await pilot.press(*list("/sessions 2"))
            await pilot.press("enter")
            await pilot.pause()
            assert app._session is not None
            assert app._session.session_id == rows[1].id
            # Chat rebuilt: switch banner after hard clear.
            assert list(app.query(SystemNotice)), "switch banner present after clear"

    asyncio.run(scenario())
