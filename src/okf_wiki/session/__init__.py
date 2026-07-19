"""Operator Session: conversation shell over bounded Wiki Runs (ADR 0018).

Primary product seam for interactive use. Host Wiki Run application remains
the production/publication authority; this package owns Session history,
card projection, HITL/YOLO approval wiring, Needs Input → new Run, and
slash controls. Multi-session list/resume uses :class:`SessionStore`
(file-based; see ``store`` module for why not StepPersistence).
"""

from __future__ import annotations

from .cards import SessionCard, card_texts, project_event, project_events, summarize_nodes
from .interactive import run_operator_session, run_operator_session_sync
from .runtime import (
    CollectAnswersFn,
    OperatorSession,
    SessionMessage,
    SlashCommandResult,
    WikiRunTurnResult,
    format_run_error,
    interactive_publication_handler,
)
from .store import (
    SessionNotFoundError,
    SessionSnapshot,
    SessionStore,
    SessionSummary,
    default_sessions_dir,
    format_session_list,
    resolve_session_ref,
)
from .stream import StreamFragment, project_stream_event
from .tty import require_tty

__all__ = [
    "CollectAnswersFn",
    "OperatorSession",
    "SessionCard",
    "SessionMessage",
    "SessionNotFoundError",
    "SessionSnapshot",
    "SessionStore",
    "SessionSummary",
    "SlashCommandResult",
    "StreamFragment",
    "WikiRunTurnResult",
    "card_texts",
    "default_sessions_dir",
    "format_run_error",
    "format_session_list",
    "interactive_publication_handler",
    "resolve_session_ref",
    "project_event",
    "project_events",
    "project_stream_event",
    "require_tty",
    "run_operator_session",
    "run_operator_session_sync",
    "summarize_nodes",
]
