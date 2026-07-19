"""Simplified L1 analysis cards projected from Wiki Run events.

The Operator Session UI never dumps chain-of-thought or raw provider bodies.
Cards are secret-redacted, short labels suitable for the Textual fullscreen
Session app and the line-oriented test/shell adapter.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from ..run.security import environment_secrets, redact_secrets
from ..run import WikiRunEvent

CardKind = Literal[
    "lifecycle",
    "plan",
    "node",
    "receipt",
    "tool",
    "compaction",
    "retry",
    "review",
    "validation",
    "publication",
    "gate",
    "terminal",
    "system",
    "other",
]


@dataclass(slots=True, frozen=True)
class SessionCard:
    """One simplified operator-facing card (view model unit)."""

    kind: CardKind
    text: str
    event_type: str | None = None
    node_id: str | None = None
    payload: dict[str, object] = field(default_factory=dict)


# Event types that close a Wiki Run from the operator's point of view.
_TERMINAL_TYPES = frozenset(
    {
        "run_succeeded",
        "run_failed",
        "run_cancelled",
        "needs_input",
        "awaiting_publication",
        "publication_declined",
    }
)

_VALIDATION_TYPES = frozenset(
    {
        "validation_started",
        "validation_succeeded",
        "validation_failed",
    }
)

_PUBLICATION_TYPES = frozenset(
    {
        "publication_started",
        "publication_succeeded",
        "publication_failed",
        "awaiting_publication",
        "publication_declined",
    }
)

_REVIEW_TYPES = frozenset(
    {
        "review_started",
        "review_succeeded",
        "review_failed",
    }
)

_CHILD_TYPES = frozenset(
    {
        "child_dispatched",
        "child_started",
        "child_finished",
        "child_rejected",
    }
)


def _kind_for_event(event_type: str) -> CardKind:
    if event_type in _TERMINAL_TYPES:
        return "terminal"
    if event_type in _VALIDATION_TYPES:
        return "validation"
    if event_type in _PUBLICATION_TYPES:
        return "publication"
    if event_type in _REVIEW_TYPES:
        return "review"
    if event_type in _CHILD_TYPES:
        return "node"
    if event_type == "plan_updated":
        return "plan"
    if event_type == "receipt_published":
        return "receipt"
    if event_type in {"compaction_warning", "compaction_completed"}:
        return "compaction"
    if event_type in {"provider_retry_scheduled", "provider_retry_exhausted"}:
        return "retry"
    if event_type in {"run_created", "snapshots_frozen", "skill_frozen"}:
        return "lifecycle"
    if event_type in {"visualization_written", "visualization_failed"}:
        return "system"
    return "other"


def _format_line(event: WikiRunEvent) -> str:
    """Human-readable one-line label (same spirit as ``tui.TuiState.observe``)."""
    payload = event.payload
    node = event.node_id
    event_type = event.type

    if event_type in _CHILD_TYPES:
        status = str(payload.get("status") or event_type.removeprefix("child_"))
        queue = payload.get("queue_seconds")
        if event_type == "child_started" and isinstance(queue, (int, float)) and queue >= 0.05:
            return f"node {node}: {status} queue={float(queue):.2f}s"
        return f"node {node}: {status}"

    if event_type == "plan_updated":
        total = payload.get("total")
        total_int = int(total) if isinstance(total, (int, float)) else None
        return f"plan updated total={total_int}"

    if event_type == "receipt_published":
        return f"receipt published node={node} status={payload.get('status')}"

    if event_type in {"compaction_warning", "compaction_completed"}:
        return f"compaction {event_type.removeprefix('compaction_')}"

    if event_type == "provider_retry_scheduled":
        wait = payload.get("wait_seconds")
        wait_f = float(wait) if isinstance(wait, (int, float)) else None
        return (
            f"provider retry attempt={payload.get('attempt')} "
            f"wait={wait_f}s kind={payload.get('kind')}"
        )

    if event_type == "provider_retry_exhausted":
        return "provider retry exhausted"

    if event_type == "visualization_written":
        index = payload.get("index") or payload.get("output") or ""
        return f"visualization written {index}"

    if event_type == "visualization_failed":
        return f"visualization failed reason={payload.get('reason_code')}"

    if event_type in {"run_failed", "run_cancelled"}:
        error_type = payload.get("error_type")
        if isinstance(error_type, str) and error_type:
            return f"{event_type.replace('_', ' ')} error_type={error_type}"
        return event_type.replace("_", " ")

    if event_type == "awaiting_publication":
        return "awaiting publication (approve/deny)"

    if event_type == "publication_declined":
        return "publication declined"

    return event_type.replace("_", " ")


def _secret_tuple(secrets: frozenset[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    if secrets is None:
        return environment_secrets()
    if isinstance(secrets, tuple):
        return secrets
    return tuple(secrets)


def project_event(
    event: WikiRunEvent,
    *,
    secrets: frozenset[str] | tuple[str, ...] | None = None,
) -> SessionCard:
    """Project one run event into a secret-safe Session card."""
    secret_tuple = _secret_tuple(secrets)
    line = redact_secrets(_format_line(event), secret_tuple)
    # Payload is already run-sanitized; still redact any residual secret-like text.
    safe_payload: dict[str, object] = {}
    for key, value in event.payload.items():
        if isinstance(value, str):
            safe_payload[key] = redact_secrets(value, secret_tuple)
        else:
            safe_payload[key] = value
    return SessionCard(
        kind=_kind_for_event(event.type),
        text=line,
        event_type=event.type,
        node_id=event.node_id,
        payload=safe_payload,
    )


def project_events(
    events: Iterable[WikiRunEvent],
    *,
    secrets: frozenset[str] | tuple[str, ...] | None = None,
) -> list[SessionCard]:
    """Deterministic batch projection (tests / offline adapters)."""
    secret_tuple = _secret_tuple(secrets)
    return [project_event(event, secrets=secret_tuple) for event in events]


def card_texts(cards: Iterable[SessionCard]) -> list[str]:
    """Extract display lines from cards (compat with older TUI string lists)."""
    return [card.text for card in cards]


def summarize_nodes(events: Iterable[WikiRunEvent]) -> dict[str, str]:
    """Last-known node status from a run event sequence."""
    nodes: dict[str, str] = {}
    for event in events:
        if event.type in _CHILD_TYPES:
            status = str(event.payload.get("status") or event.type.removeprefix("child_"))
            nodes[event.node_id] = status
    return nodes


__all__ = [
    "CardKind",
    "SessionCard",
    "card_texts",
    "project_event",
    "project_events",
    "summarize_nodes",
]
