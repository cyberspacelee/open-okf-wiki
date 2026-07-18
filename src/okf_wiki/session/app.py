"""Fullscreen Operator Session TUI built on Textual.

Layout and streaming follow Textual's official LLM chat example (``mother.py`` /
Anatomy of a Textual User Interface): scrollable message view, bottom ``Input``,
``Markdown`` responses with ``Markdown.get_stream`` for token updates.

Host progress cards and pydantic-ai stream fragments (via Session
``on_card`` / ``on_stream``) mount into the same chat view. The Session API and
Wiki Run Host remain the product seams; this module is presentation only.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TextIO

from rich.console import Console
from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Input, Markdown, Static

from ..security import safe_error_message
from ..wiki_run import NeedsInput, WikiRunRequest, WikiRunResult
from .cards import SessionCard
from .runtime import InputFn, OperatorSession, interactive_publication_handler
from .store import SessionStore, default_sessions_dir
from .stream import StreamFragment
from .tty import require_tty


class UserPrompt(Markdown):
    """Operator message bubble (Textual mother.py Prompt pattern)."""


class AssistantReply(Markdown):
    """Streaming assistant / model text (Textual mother.py Response pattern)."""

    BORDER_TITLE = "Assistant"


class StatusCard(Static):
    """Host L1 card or system/status line."""


class OperatorSessionApp(App[WikiRunResult | None]):
    """Fullscreen Operator Session: chat view + bottom input + live cards/stream."""

    TITLE = "okf-wiki"
    SUB_TITLE = "Operator Session"
    AUTO_FOCUS = "Input"
    CSS = """
    UserPrompt {
        background: $primary 10%;
        color: $text;
        margin: 1 1 0 1;
        margin-right: 8;
        padding: 1 2 0 2;
    }
    AssistantReply {
        border: wide $success;
        background: $success 10%;
        color: $text;
        margin: 1 1 0 1;
        margin-left: 8;
        padding: 1 2 0 2;
    }
    StatusCard {
        color: $text-muted;
        margin: 0 1;
        padding: 0 1;
    }
    #chat-view {
        height: 1fr;
    }
    Input {
        dock: bottom;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit_session", "Quit"),
        ("ctrl+q", "quit_session", "Quit"),
    ]

    def __init__(
        self,
        request: WikiRunRequest,
        *,
        yolo: bool = False,
        auto_start: bool = True,
        max_turns: int | None = None,
        store: SessionStore | None = None,
        sessions_dir: Path | None = None,
        resume_session_id: str | None = None,
        input_fn: InputFn | None = None,
    ) -> None:
        super().__init__()
        self._request = request
        self._yolo = yolo or request.auto_approve_publication
        self._auto_start = auto_start
        self._max_turns = max_turns
        self._turns = 0
        self._store = store
        self._sessions_dir = sessions_dir
        self._resume_session_id = resume_session_id
        self._injected_input_fn = input_fn
        self._session: OperatorSession | None = None
        self._last_result: WikiRunResult | None = None
        self._busy = False
        self._prompt_future: asyncio.Future[str] | None = None
        self._active_reply: AssistantReply | None = None
        self._active_stream = None
        self._stream_buffer = ""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="chat-view"):
            yield StatusCard("Operator Session — type a goal, or /help. Ctrl+Q to quit.")
        yield Input(placeholder="goal, slash command, or answer…", id="session-input")
        yield Footer()

    def on_mount(self) -> None:
        session_store = self._store
        if session_store is None:
            session_store = SessionStore(self._sessions_dir or default_sessions_dir())

        def on_card(card: SessionCard) -> None:
            self.call_later(self._mount_card, card)

        def on_stream(fragment: StreamFragment) -> None:
            self.call_later(self._handle_stream_fragment, fragment)

        self._session = OperatorSession(
            base_request=self._request,
            yolo=self._yolo,
            on_card=on_card,
            on_stream=on_stream,
            store=session_store,
        )
        self._session.publication_approval_handler = interactive_publication_handler(
            async_input_fn=self.prompt_async if self._injected_input_fn is None else None,
            input_fn=self._injected_input_fn,
        )
        try:
            self._session.preflight()
        except Exception as error:
            self._mount_status(f"preflight: {_format_run_error(error)}")
            raise

        if self._resume_session_id:
            snapshot = self._session.resume_from_store(self._resume_session_id)
            self._mount_status(
                f"Resumed Operator Session {snapshot.id[:12]} "
                f"[{self._session.yolo_indicator()}] — history only, no auto-publish."
            )
            for message in self._session.message_history:
                if message.role == "user":
                    self._mount_user(message.content)
                elif message.role in {"assistant", "system", "session"}:
                    self._mount_status(f"{message.role}: {message.content}")
        else:
            try:
                created = self._session.start_new_session()
                self._mount_status(
                    f"Operator Session {created.id[:12]} ready "
                    f"[{self._session.yolo_indicator()}]. "
                    "Type a goal, or /help. /sessions /new /resume /quit."
                )
            except Exception:
                self._mount_status(
                    f"Operator Session ready [{self._session.yolo_indicator()}]. "
                    "Type a goal, or /help. /quit to exit."
                )

        chat = self.query_one("#chat-view", VerticalScroll)
        chat.anchor()
        self._refresh_subtitle()

        if self._auto_start:
            self.run_wiki_turn(label=None)

    def _refresh_subtitle(self) -> None:
        if self._session is None:
            return
        sid = (self._session.session_id or "")[:12]
        self.sub_title = (
            f"{sid} · {self._session.mode_indicator()} · {self._session.yolo_indicator()}"
        )

    async def prompt_async(self, prompt: str) -> str:
        """Show a prompt in the chat view and wait for the bottom Input."""
        if self._injected_input_fn is not None:
            return self._injected_input_fn(prompt)
        if self._prompt_future is not None and not self._prompt_future.done():
            # Replace an abandoned pending prompt.
            self._prompt_future.cancel()
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        self._prompt_future = future
        self._mount_status(prompt.rstrip())
        inp = self.query_one("#session-input", Input)
        inp.placeholder = "answer + Enter…"
        inp.focus()
        try:
            return await future
        finally:
            if self._prompt_future is future:
                self._prompt_future = None
            inp.placeholder = "goal, slash command, or answer…"

    def _mount_status(self, text: str) -> None:
        chat = self.query_one("#chat-view", VerticalScroll)
        chat.mount(StatusCard(text))
        chat.scroll_end(animate=False)

    def _mount_user(self, text: str) -> None:
        chat = self.query_one("#chat-view", VerticalScroll)
        chat.mount(UserPrompt(text))
        chat.scroll_end(animate=False)

    def _mount_card(self, card: SessionCard) -> None:
        self._mount_status(card.text)

    def _handle_stream_fragment(self, fragment: StreamFragment) -> None:
        if fragment.kind == "text":
            self._append_text_delta(fragment.text)
            return
        self._mount_status(fragment.text)

    def _append_text_delta(self, delta: str) -> None:
        """Append model text using Markdown.get_stream (Textual streaming Markdown)."""
        self.run_worker(self._write_text_delta(delta), exclusive=False, group="stream-write")

    async def _write_text_delta(self, delta: str) -> None:
        reply = self._active_reply
        if reply is None:
            chat = self.query_one("#chat-view", VerticalScroll)
            reply = AssistantReply()
            await chat.mount(reply)
            reply.anchor()
            self._active_reply = reply
            self._stream_buffer = ""
            if hasattr(Markdown, "get_stream"):
                self._active_stream = Markdown.get_stream(reply)
            else:
                self._active_stream = None

        stream = self._active_stream
        if stream is not None:
            await stream.write(delta)
        else:
            self._stream_buffer += delta
            await reply.update(self._stream_buffer)

    async def _close_active_reply(self) -> None:
        stream = self._active_stream
        self._active_stream = None
        self._active_reply = None
        self._stream_buffer = ""
        if stream is not None:
            try:
                await stream.stop()
            except Exception:
                pass

    def action_quit_session(self) -> None:
        self.exit(self._last_result)

    @on(Input.Submitted, "#session-input")
    async def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value
        event.input.clear()

        if self._prompt_future is not None and not self._prompt_future.done():
            self._prompt_future.set_result(value)
            return

        if self._busy:
            self._mount_status("busy — wait for the current Wiki Run or answer a gate prompt")
            return

        stripped = value.strip()
        if not stripped:
            return

        if self._max_turns is not None and self._turns >= self._max_turns:
            self._mount_status("max turns reached — exiting")
            self.action_quit_session()
            return
        self._turns += 1

        session = self._session
        if session is None:
            return

        slash = session.handle_slash(stripped)
        if slash is not None:
            self._mount_status(slash.message)
            self._refresh_subtitle()
            if slash.quit:
                self.action_quit_session()
            return

        self._mount_user(stripped)
        if session.mode == "ask":
            reply_text = session.note_ask(stripped)
            chat = self.query_one("#chat-view", VerticalScroll)
            reply = AssistantReply(reply_text)
            await chat.mount(reply)
            chat.scroll_end(animate=False)
            return

        self.run_wiki_turn(label=stripped)

    @work(exclusive=True, group="wiki-run")
    async def run_wiki_turn(self, label: str | None) -> None:
        """Start one Wiki Run from the Session; stream cards + model events live."""
        session = self._session
        if session is None:
            return
        self._busy = True
        try:
            await self._close_active_reply()
            if label:
                session.append_user(label)
                self._mount_status(f"starting Wiki Run: {label!r}")
            else:
                self._mount_status("starting Wiki Run from Session config")

            turn = await session.run_wiki()
            self._last_result = turn.result

            while isinstance(turn.result, NeedsInput):
                self._mount_status(
                    "needs input — answers start a new Wiki Run (prior run not resumed)"
                )
                answers = await session.collect_needs_input_answers_async(
                    turn.result,
                    async_input_fn=self.prompt_async,
                    run_id=turn.run_id,
                )
                turn = await session.continue_after_needs_input(turn, answers)
                self._last_result = turn.result

            status = getattr(turn.result, "status", type(turn.result).__name__)
            self._mount_status(f"run finished status={status} yolo={turn.yolo}")
            self._refresh_subtitle()
        except Exception as error:
            self._mount_status(f"run error: {_format_run_error(error)}")
            raise
        finally:
            await self._close_active_reply()
            self._busy = False


def _format_run_error(error: BaseException) -> str:
    if isinstance(error, Exception):
        detail = safe_error_message(error)
        return f"{type(error).__name__}: {detail}"
    return f"{type(error).__name__}: {error}"


async def run_operator_session_app(
    request: WikiRunRequest,
    *,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = True,
    max_turns: int | None = None,
    stdin: TextIO | None = None,
    store: SessionStore | None = None,
    sessions_dir: Path | None = None,
    resume_session_id: str | None = None,
    input_fn: InputFn | None = None,
    console: Console | None = None,
) -> WikiRunResult | None:
    """Run the fullscreen Textual Operator Session (TTY required by default)."""
    del console  # Textual owns the terminal; kept for API parity with line shell.
    if check_tty:
        require_tty(stdin) if stdin is not None else require_tty()

    app = OperatorSessionApp(
        request,
        yolo=yolo,
        auto_start=auto_start,
        max_turns=max_turns,
        store=store,
        sessions_dir=sessions_dir,
        resume_session_id=resume_session_id,
        input_fn=input_fn,
    )
    return await app.run_async()


__all__ = [
    "AssistantReply",
    "OperatorSessionApp",
    "StatusCard",
    "UserPrompt",
    "run_operator_session_app",
]
