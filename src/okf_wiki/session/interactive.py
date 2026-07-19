"""TTY adapter for the Operator Session API.

Default product path is the fullscreen Textual app (:mod:`okf_wiki.session.app`),
following Textual's official chat layout (scroll + bottom input + streaming
Markdown). A line-oriented Rich shell remains available when an injectable
``input_fn`` is supplied (tests / headless scripting).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TextIO

from rich.console import Console
from rich.text import Text

from ..run import NeedsInput, WikiRunRequest, WikiRunResult
from .runtime import (
    InputFn,
    OperatorSession,
    format_run_error,
    interactive_publication_handler,
)
from .store import SessionStore, default_sessions_dir
from .tty import require_tty


def _default_input(prompt: str) -> str:
    return input(prompt)


async def run_operator_session(
    request: WikiRunRequest,
    *,
    console: Console | None = None,
    input_fn: InputFn | None = None,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = False,
    max_turns: int | None = None,
    stdin: TextIO | None = None,
    store: SessionStore | None = None,
    sessions_dir: Path | None = None,
    resume_session_id: str | None = None,
    line_mode: bool = False,
) -> WikiRunResult | None:
    """Run the interactive Operator Session.

    Parameters
    ----------
    request:
        Base Wiki Run request (usually from ``wiki-run.yaml``).
    yolo:
        Initial YOLO (auto-approve publication) flag; also toggleable via ``/yolo``.
    auto_start:
        When True, start one Wiki Run immediately on entry (legacy/tests only).
        Default is False: wait for a goal line or ``/run``.
    max_turns:
        Optional cap on user turns (tests). ``None`` means unlimited until
        ``/quit`` or EOF.
    store / sessions_dir:
        Multi-session persistence (ticket 07). Defaults to
        ``.okf-wiki/sessions`` under the current working directory.
    resume_session_id:
        When set, load that Session's history on entry (does not publish).
    line_mode:
        Force the legacy line-oriented shell. Also selected automatically when
        ``input_fn`` is provided (test injectables).
    """
    use_line = line_mode or input_fn is not None
    if not use_line:
        from .app import run_operator_session_app

        return await run_operator_session_app(
            request,
            console=console,
            check_tty=check_tty,
            yolo=yolo,
            auto_start=auto_start,
            max_turns=max_turns,
            stdin=stdin,
            store=store,
            sessions_dir=sessions_dir,
            resume_session_id=resume_session_id,
            input_fn=input_fn,
        )

    return await _run_line_session(
        request,
        console=console,
        input_fn=input_fn,
        check_tty=check_tty,
        yolo=yolo,
        auto_start=auto_start,
        max_turns=max_turns,
        stdin=stdin,
        store=store,
        sessions_dir=sessions_dir,
        resume_session_id=resume_session_id,
    )


async def _run_line_session(
    request: WikiRunRequest,
    *,
    console: Console | None = None,
    input_fn: InputFn | None = None,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = False,
    max_turns: int | None = None,
    stdin: TextIO | None = None,
    store: SessionStore | None = None,
    sessions_dir: Path | None = None,
    resume_session_id: str | None = None,
) -> WikiRunResult | None:
    """Legacy line-oriented shell (Rich print + ``input()``)."""
    if check_tty:
        require_tty(stdin) if stdin is not None else require_tty()

    out = console or Console(stderr=False)
    ask: InputFn = input_fn or _default_input

    def print_line(text: str) -> None:
        out.print(Text(text))

    session_store = store
    if session_store is None:
        session_store = SessionStore(sessions_dir or default_sessions_dir())

    session = OperatorSession(
        base_request=request,
        yolo=yolo or request.auto_approve_publication,
        on_card=lambda card: print_line(card.text),
        on_stream=lambda frag: (
            print_line(frag.text) if frag.kind != "text" else print_line(frag.text)
        ),
        store=session_store,
    )
    session.publication_approval_handler = interactive_publication_handler(input_fn=ask)
    session.preflight()

    if resume_session_id:
        snapshot = session.resume_from_store(resume_session_id)
        print_line(
            f"Resumed Operator Session {snapshot.id[:12]} "
            f"[{session.yolo_indicator()}] — history only, no auto-publish. "
            "Type a goal, or /help. /quit to exit."
        )
    else:
        try:
            created = session.start_new_session()
            print_line(
                f"Operator Session {created.id[:12]} ready [{session.yolo_indicator()}]. "
                "No Wiki Run yet — type a goal or /run. "
                "/sessions /new /switch <id> /help /quit."
            )
        except Exception:
            print_line(
                f"Operator Session ready [{session.yolo_indicator()}]. "
                "No Wiki Run yet — type a goal or /run. /help /quit."
            )

    last_result: WikiRunResult | None = None
    turns = 0

    async def execute_run(*, label: str | None = None) -> WikiRunResult:
        nonlocal last_result
        if label:
            print_line(f"starting Wiki Run: {label!r}")
        else:
            print_line("starting Wiki Run from Session config")

        def collect_answers(needs: NeedsInput, run_id: str | None) -> dict[str, str]:
            print_line("needs input — answers start a new Wiki Run (prior run not resumed)")
            return session.collect_needs_input_answers(
                needs,
                input_fn=ask,
                run_id=run_id,
            )

        turn = await session.run_turn(
            label=label,
            collect_answers=collect_answers,
        )
        last_result = turn.result
        status = getattr(turn.result, "status", type(turn.result).__name__)
        print_line(f"run finished status={status} yolo={turn.yolo}")
        return turn.result

    if auto_start:
        try:
            last_result = await execute_run()
        except Exception as error:
            print_line(f"run error: {format_run_error(error)}")
            raise

    while True:
        if max_turns is not None and turns >= max_turns:
            break
        try:
            line = ask("okf-wiki> ")
        except EOFError:
            print_line("EOF — exiting Operator Session")
            break
        turns += 1
        stripped = line.strip()
        if not stripped:
            continue

        slash = session.handle_slash(stripped)
        if slash is not None:
            if slash.session_switched:
                print_line("")
                print_line(slash.message)
                print_line("")
            else:
                print_line(slash.message)
            if slash.quit:
                break
            if slash.start_run:
                try:
                    last_result = await execute_run()
                except Exception as error:
                    print_line(f"run error: {format_run_error(error)}")
                    raise
            continue

        if session.mode == "ask":
            print_line(session.note_ask(stripped))
            continue
        try:
            last_result = await execute_run(label=stripped)
        except Exception as error:
            print_line(f"run error: {format_run_error(error)}")
            raise

    return last_result


def run_operator_session_sync(
    request: WikiRunRequest,
    *,
    console: Console | None = None,
    input_fn: InputFn | None = None,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = False,
    max_turns: int | None = None,
    stdin: TextIO | None = None,
    store: SessionStore | None = None,
    sessions_dir: Path | None = None,
    resume_session_id: str | None = None,
    line_mode: bool = False,
) -> WikiRunResult | None:
    """Sync entry for CLI ``asyncio.run`` wrappers."""
    return asyncio.run(
        run_operator_session(
            request,
            console=console,
            input_fn=input_fn,
            check_tty=check_tty,
            yolo=yolo,
            auto_start=auto_start,
            max_turns=max_turns,
            stdin=stdin,
            store=store,
            sessions_dir=sessions_dir,
            resume_session_id=resume_session_id,
            line_mode=line_mode,
        )
    )


__all__ = [
    "run_operator_session",
    "run_operator_session_sync",
]
