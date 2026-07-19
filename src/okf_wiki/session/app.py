"""Fullscreen Operator Session TUI built on Textual.

Layout: Header · scrollable chat · composer (hint strip + input) · Footer.
The composer sits in normal vertical flow above the Footer so the input never
overlaps keybinding labels (no ``dock: bottom`` on ``Input``).

Slash commands support Tab / Shift+Tab completion and inline ghost suggestions.
Host progress cards and pydantic-ai stream fragments mount into the chat view
via Session ``on_card`` / ``on_stream``. Presentation only — Session API and
Wiki Run Host remain the product seams.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TextIO

from rich.console import Console
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.suggester import Suggester
from textual.widgets import Footer, Header, Input, Markdown, Static

from ..host import NeedsInput, WikiRunRequest, WikiRunResult
from .cards import SessionCard
from .runtime import (
    InputFn,
    OperatorSession,
    apply_slash_completion,
    format_run_error,
    interactive_publication_handler,
    list_slash_completions,
    slash_suggestion_strings,
)
from .store import SessionStore, default_sessions_dir
from .stream import StreamFragment
from .tty import require_tty

_DEFAULT_PLACEHOLDER = "goal, /run, or /help — Tab completes"
_ANSWER_PLACEHOLDER = "answer + Enter…"
_IDLE_HINT = "Tab complete · /help · Ctrl+Q quit"
_BUSY_HINT = "Wiki Run in progress — wait, or answer a gate prompt when shown"


class SlashCommandSuggester(Suggester):
    """Ghost-text suggestions for Operator Session slash commands."""

    def __init__(self, app: OperatorSessionApp | None = None) -> None:
        super().__init__(case_sensitive=False)
        self._app = app
        self._suggestions = list(slash_suggestion_strings())

    def bind_app(self, app: OperatorSessionApp) -> None:
        self._app = app

    def _session_ids(self) -> list[str]:
        if self._app is None:
            return []
        return self._app.session_ids_for_complete()

    async def get_suggestion(self, value: str) -> str | None:
        if not value.startswith("/"):
            return None
        matches = list_slash_completions(value, session_ids=self._session_ids())
        if matches:
            return matches[0]
        for suggestion in self._suggestions:
            if suggestion.casefold().startswith(value.casefold()) and len(suggestion) > len(value):
                return suggestion
        return None


class SessionInput(Input):
    """Bottom composer input with Tab slash completion (does not steal focus)."""

    # Extend Input bindings; priority Tab completes instead of App focus-next.
    BINDINGS = [
        *Input.BINDINGS,
        Binding("tab", "complete_command", "Complete", show=True, priority=True),
        Binding(
            "shift+tab",
            "complete_command_prev",
            "Prev complete",
            show=False,
            priority=True,
        ),
    ]

    def action_complete_command(self) -> None:
        self._apply_completion(reverse=False)

    def action_complete_command_prev(self) -> None:
        self._apply_completion(reverse=True)

    def _session_ids(self) -> list[str]:
        app = self.app
        if isinstance(app, OperatorSessionApp):
            return app.session_ids_for_complete()
        return []

    def _apply_completion(self, *, reverse: bool) -> None:
        replacement = apply_slash_completion(
            self.value,
            reverse=reverse,
            session_ids=self._session_ids(),
        )
        if replacement is None:
            return
        self.value = replacement
        self.cursor_position = len(replacement)


class UserPrompt(Markdown):
    """Operator message bubble (Textual mother.py Prompt pattern)."""


class AssistantReply(Markdown):
    """Streaming assistant / model text (Textual mother.py Response pattern)."""

    BORDER_TITLE = "Assistant"


class StatusCard(Static):
    """Host L1 card or single-line system/status line."""


class SystemNotice(Static):
    """Multi-line slash panel (/sessions, /help, switch banners)."""


class HintBar(Static):
    """One-line context under the chat: matches, mode, or busy state."""


class OperatorSessionApp(App[WikiRunResult | None]):
    """Fullscreen Operator Session: chat + composer + live cards/stream."""

    TITLE = "okf-wiki"
    SUB_TITLE = "Operator Session"
    AUTO_FOCUS = "#session-input"
    CSS = """
    Screen {
        layout: vertical;
    }

    #chat-view {
        height: 1fr;
        padding: 0 1;
    }

    UserPrompt {
        background: $primary 10%;
        color: $text;
        margin: 1 0 0 0;
        margin-right: 8;
        padding: 1 2 0 2;
    }

    AssistantReply {
        border: wide $success;
        background: $success 10%;
        color: $text;
        margin: 1 0 0 0;
        margin-left: 8;
        padding: 1 2 0 2;
    }

    StatusCard {
        color: $text-muted;
        margin: 0 0;
        padding: 0 1;
        height: auto;
    }

    SystemNotice {
        height: auto;
        margin: 1 0;
        padding: 1 2;
        background: $boost;
        border: solid $primary 40%;
        color: $text;
    }

    #composer {
        height: auto;
        background: $surface;
        border-top: solid $primary 40%;
        padding: 0 1 1 1;
    }

    #hint-bar {
        height: 1;
        color: $text-muted;
        text-style: dim;
        padding: 0 1;
        margin: 0 0;
    }

    #hint-bar.-busy {
        color: $warning;
        text-style: none;
    }

    #hint-bar.-matches {
        color: $accent;
        text-style: none;
    }

    #session-input {
        width: 100%;
        margin: 0;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit_session", "Quit", show=True, priority=True),
        Binding("ctrl+q", "quit_session", "Quit", show=True, priority=True),
    ]

    def __init__(
        self,
        request: WikiRunRequest,
        *,
        yolo: bool = False,
        auto_start: bool = False,
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
        self._awaiting_answer = False
        self._prompt_future: asyncio.Future[str] | None = None
        self._active_reply: AssistantReply | None = None
        self._active_stream = None
        self._stream_buffer = ""
        self._slash_suggester = SlashCommandSuggester()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="chat-view"):
            yield StatusCard(
                "Operator Session — type a goal or /run to start a Wiki Run. "
                "Slash commands: Tab completes, /help lists all."
            )
        with Vertical(id="composer"):
            yield HintBar(_IDLE_HINT, id="hint-bar")
            yield SessionInput(
                placeholder=_DEFAULT_PLACEHOLDER,
                id="session-input",
                suggester=self._slash_suggester,
            )
        yield Footer()

    def on_mount(self) -> None:
        self._slash_suggester.bind_app(self)
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
            self._mount_status(f"preflight: {format_run_error(error)}")
            raise

        if self._resume_session_id:
            snapshot = self._session.resume_from_store(self._resume_session_id)
            self._mount_status(
                f"Resumed Operator Session {snapshot.id[:12]} "
                f"[{self._session.yolo_indicator()}] — history only, no auto-publish."
            )
            self._mount_history_messages()
        else:
            try:
                created = self._session.start_new_session()
                self._mount_status(
                    f"Operator Session {created.id[:12]} ready "
                    f"[{self._session.yolo_indicator()}]. "
                    "No Wiki Run yet — type a goal or /run. "
                    "/sessions lists Sessions; /sessions 1 switches."
                )
            except Exception:
                self._mount_status(
                    f"Operator Session ready [{self._session.yolo_indicator()}]. "
                    "No Wiki Run yet — type a goal or /run."
                )

        chat = self.query_one("#chat-view", VerticalScroll)
        chat.anchor()
        self._refresh_subtitle()
        self._refresh_hint_bar()

        if self._auto_start:
            self.run_wiki_turn(label=None)

    def session_ids_for_complete(self) -> list[str]:
        """Newest-first Session ids for Tab completion of /switch and /sessions."""
        session = self._session
        if session is None or session.store is None:
            return []
        try:
            return [row.id for row in session.store.list_sessions()]
        except Exception:
            return []

    def _refresh_subtitle(self) -> None:
        if self._session is None:
            return
        sid = (self._session.session_id or "")[:12]
        self.sub_title = (
            f"{sid} · {self._session.mode_indicator()} · {self._session.yolo_indicator()}"
        )

    def _session_context_hint(self) -> str:
        """Mode/yolo context for the idle hint strip."""
        session = self._session
        if session is None:
            return _IDLE_HINT
        return f"{session.mode_indicator()} · {session.yolo_indicator()} · {_IDLE_HINT}"

    def _refresh_hint_bar(self, input_value: str | None = None) -> None:
        bar = self.query_one("#hint-bar", HintBar)
        bar.remove_class("-busy")
        bar.remove_class("-matches")

        if self._awaiting_answer:
            bar.update("Waiting for answer — type response and press Enter")
            bar.add_class("-busy")
            return
        if self._busy:
            bar.update(_BUSY_HINT)
            bar.add_class("-busy")
            return

        value = input_value
        if value is None:
            try:
                value = self.query_one("#session-input", SessionInput).value
            except Exception:
                value = ""

        if value.startswith("/"):
            matches = list_slash_completions(value, session_ids=self.session_ids_for_complete())
            if matches:
                preview = "  ".join(m.rstrip() for m in matches[:6])
                more = f"  (+{len(matches) - 6})" if len(matches) > 6 else ""
                bar.update(f"Tab: {preview}{more}")
                bar.add_class("-matches")
                return
            if value.strip() == "/":
                bar.update("Tab: type a command — /run /yolo /mode /help /quit …")
                bar.add_class("-matches")
                return
            bar.update("No matching slash command — try /help")
            return

        bar.update(self._session_context_hint())

    def _history_widgets(self) -> list[UserPrompt | AssistantReply | StatusCard | SystemNotice]:
        """Build chat widgets from the active Session history (no Host cards)."""
        session = self._session
        if session is None:
            return []
        widgets: list[UserPrompt | AssistantReply | StatusCard | SystemNotice] = []
        for message in session.message_history:
            if message.role == "user":
                widgets.append(UserPrompt(message.content))
            elif message.role == "assistant":
                widgets.append(AssistantReply(message.content))
            else:
                widgets.append(StatusCard(f"{message.role}: {message.content}"))
        return widgets

    def _mount_history_messages(self) -> None:
        """Render Session message history into the chat view (no Host cards)."""
        chat = self.query_one("#chat-view", VerticalScroll)
        for widget in self._history_widgets():
            chat.mount(widget)
        chat.scroll_end(animate=False)

    async def _reload_session_view(self, banner: str) -> None:
        """Hard-clear the chat pane and show only the active Session."""
        await self._close_active_reply()
        chat = self.query_one("#chat-view", VerticalScroll)
        # Explicit wipe so prior Host cards / stream bubbles cannot linger.
        await chat.remove_children()
        chat.scroll_home(animate=False)
        widgets: list[UserPrompt | AssistantReply | StatusCard | SystemNotice] = [
            SystemNotice(banner),
            *self._history_widgets(),
        ]
        await chat.mount(*widgets)
        self._refresh_subtitle()
        self._refresh_hint_bar()
        # Empty Session: stay at top (clear-screen feel). Otherwise show latest.
        if self._session is None or not self._session.message_history:
            chat.scroll_home(animate=False)
        else:
            chat.scroll_end(animate=False)
        chat.refresh(layout=True)

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
        self._awaiting_answer = True
        self._mount_status(prompt.rstrip())
        inp = self.query_one("#session-input", SessionInput)
        inp.placeholder = _ANSWER_PLACEHOLDER
        inp.focus()
        self._refresh_hint_bar()
        try:
            return await future
        finally:
            if self._prompt_future is future:
                self._prompt_future = None
            self._awaiting_answer = False
            inp.placeholder = _DEFAULT_PLACEHOLDER
            self._refresh_hint_bar()

    def _mount_status(self, text: str) -> None:
        chat = self.query_one("#chat-view", VerticalScroll)
        chat.mount(StatusCard(text))
        chat.scroll_end(animate=False)

    def _mount_notice(self, text: str) -> None:
        """Multi-line system panel (session list, help, switch banners)."""
        chat = self.query_one("#chat-view", VerticalScroll)
        chat.mount(SystemNotice(text))
        chat.scroll_end(animate=False)

    def _mount_slash_message(self, text: str) -> None:
        if "\n" in text:
            self._mount_notice(text)
        else:
            self._mount_status(text)

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

    @on(Input.Changed, "#session-input")
    def on_input_changed(self, event: Input.Changed) -> None:
        self._refresh_hint_bar(event.value)

    @on(Input.Submitted, "#session-input")
    async def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value
        event.input.clear()
        self._refresh_hint_bar("")

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

        # Refuse Session switches while a Wiki Run is in flight (state already busy).
        first = stripped.split(maxsplit=1)[0].lower()
        if first in {"/new", "/resume", "/switch", "/sessions"} and self._busy:
            # Bare /sessions (list only) is still OK while busy; switching is not.
            parts = stripped.split(maxsplit=1)
            switching = first in {"/new", "/resume", "/switch"} or (
                first == "/sessions" and len(parts) > 1
            )
            if switching:
                self._mount_status("cannot switch Session while a Wiki Run is active")
                return

        slash = session.handle_slash(stripped)
        if slash is not None:
            if slash.quit:
                self._mount_status(slash.message)
                self.action_quit_session()
                return
            if slash.session_switched:
                await self._reload_session_view(slash.message)
                return
            self._mount_slash_message(slash.message)
            self._refresh_subtitle()
            self._refresh_hint_bar()
            if slash.start_run:
                self.run_wiki_turn(label=None)
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
        self._refresh_hint_bar()
        try:
            await self._close_active_reply()
            if label:
                self._mount_status(f"starting Wiki Run: {label!r}")
            else:
                self._mount_status("starting Wiki Run from Session config")

            async def collect_answers(needs: NeedsInput, run_id: str | None) -> dict[str, str]:
                self._mount_status(
                    "needs input — answers start a new Wiki Run (prior run not resumed)"
                )
                return await session.collect_needs_input_answers_async(
                    needs,
                    async_input_fn=self.prompt_async,
                    run_id=run_id,
                )

            turn = await session.run_turn(
                label=label,
                collect_answers=collect_answers,
            )
            self._last_result = turn.result

            status = getattr(turn.result, "status", type(turn.result).__name__)
            self._mount_status(f"run finished status={status} yolo={turn.yolo}")
            self._refresh_subtitle()
        except Exception as error:
            self._mount_status(f"run error: {format_run_error(error)}")
            raise
        finally:
            await self._close_active_reply()
            self._busy = False
            self._refresh_hint_bar()


async def run_operator_session_app(
    request: WikiRunRequest,
    *,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = False,
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
    "HintBar",
    "OperatorSessionApp",
    "SessionInput",
    "SlashCommandSuggester",
    "StatusCard",
    "SystemNotice",
    "UserPrompt",
    "run_operator_session_app",
]
