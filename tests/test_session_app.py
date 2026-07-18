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

from okf_wiki.session.app import OperatorSessionApp, StatusCard
from okf_wiki.session.stream import project_stream_event
from okf_wiki.wiki_run import ModelProviderConfig, RepositorySnapshot, WikiRunRequest

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


# --- Textual app structure --------------------------------------------------


def test_operator_session_app_composes_chat_and_input(tmp_path: Path) -> None:
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
            assert app.query_one("#session-input") is not None
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
