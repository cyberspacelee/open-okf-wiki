"""Operator Session entry and legacy projection helpers.

Interactive product path is :mod:`okf_wiki.session` (ADR 0018): fullscreen
Textual app by default, with a line-oriented adapter for injectable tests.
This module keeps ``require_tty``, string projection helpers used by older
tests, and a thin ``run_tui`` wrapper around the Session API.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path

from rich.console import Console

from .session.cards import project_events as project_session_cards
from .session.runtime import OperatorSession
from .session.tty import require_tty
from .wiki_run import (
    WikiRunEvent,
    WikiRunRequest,
    WikiRunResult,
    load_run_record,
)


def project_events(events: list[WikiRunEvent]) -> list[str]:
    """Deterministic string projection used by tests (no terminal required)."""
    return [card.text for card in project_session_cards(events)]


def summarize_nodes(events: list[WikiRunEvent]) -> Mapping[str, str]:
    """Last-known node status from a Host event sequence."""
    nodes: dict[str, str] = {}
    for event in events:
        if event.type in {
            "child_dispatched",
            "child_started",
            "child_finished",
            "child_rejected",
        }:
            status = str(event.payload.get("status") or event.type.removeprefix("child_"))
            nodes[event.node_id] = status
    return nodes


async def run_tui(
    request: WikiRunRequest,
    *,
    console: Console | None = None,
    input_fn: Callable[[str], str] | None = None,
    confirm_fn: Callable[[str], bool] | None = None,
    check_tty: bool = True,
    yolo: bool = False,
    auto_start: bool = False,
    max_turns: int | None = None,
) -> WikiRunResult | None:
    """Run the Operator Session interactive shell (Session API).

    ``confirm_fn`` is accepted for API stability with older call sites but is
    unused; publication approve/deny uses ``input_fn`` via the Session gate.
    """
    del confirm_fn  # publication HITL uses input_fn through the Session handler
    # Local import keeps this module free of interactive→tui cycles at import time.
    from .session.interactive import run_operator_session

    return await run_operator_session(
        request,
        console=console,
        input_fn=input_fn,
        check_tty=check_tty,
        yolo=yolo or request.auto_approve_publication,
        auto_start=auto_start,
        max_turns=max_turns,
    )


def offer_manual_retry(
    *,
    publication: Path,
    staging: Path,
    console: Console | None = None,
    confirm_fn: Callable[[str], bool] | None = None,
    model: str | None = None,
) -> WikiRunRequest | None:
    """Offer Manual Retry from the newest failed/cancelled record near publication."""
    from rich.text import Text

    out = console or Console(stderr=False)
    records_dir = publication.parent / f".{publication.name}.runs"
    if not records_dir.is_dir():
        out.print(Text("no run records available for manual retry"))
        return None
    candidates = sorted(records_dir.glob("*.json"), key=lambda path: path.stat().st_mtime)
    if not candidates:
        out.print(Text("no run records available for manual retry"))
        return None
    record = load_run_record(candidates[-1])
    if record.status not in {"failed", "cancelled"}:
        out.print(Text(f"latest record status is {record.status}; not retryable"))
        return None
    confirm = confirm_fn or (lambda prompt: input(prompt).strip().lower() in {"y", "yes"})
    if not confirm(f"Start Manual Retry Run from {record.run_id} with frozen inputs? [y/N] "):
        return None
    return WikiRunRequest.from_run_record(
        record,
        staging=staging,
        publication=publication,
        model=model,
    )


__all__ = [
    "OperatorSession",
    "offer_manual_retry",
    "project_events",
    "require_tty",
    "run_tui",
    "summarize_nodes",
]
