"""Operator Session multi-session persistence (ticket 07).

File-based SessionStore under a project-local directory (default
``.okf-wiki/sessions``). Stores Session metadata + message-history snapshots
only.

Why not pydantic-ai-harness ``StepPersistence``
----------------------------------------------
``StepPersistence`` is an Agent *capability* that records append-only step
events, provider-valid ``ModelMessage`` snapshots, and a tool-effect ledger
for a single agent investigation. Its ``continue_run`` path reloads that
agent's message history for ``Agent.run(message_history=...)``.

Operator Session continuity is different:

* Multiple named Sessions per project (list / create / resume).
* Session history is lightweight ``SessionMessage`` turns (operator goals,
  slash notes, Host job outcomes) — not a provider-valid ModelMessage log.
* Ticket 06 intentionally stubs the conversation Agent.iter loop; each goal
  starts a **new** bounded Wiki Run. There is no conversation Agent to attach
  ``StepPersistence`` to without inventing a second checkpoint protocol.
* Resume must restore multi-turn *Session* context and must **not** look like
  Wiki Run graph resume, Staging publication resume, or Manual Retry of a
  half-finished Semantic Workflow.

When a conversation Agent lands later, ``StepPersistence`` can attach to
*that* Agent's runs for message-snapshot continuity without replacing this
Session index/store. Using it as the multi-session product store today would
conflate Host/agent step resume with Operator Session list/resume.

This module is the product Session seam; it never mutates Staging or Published
Wiki and never resumes a Wiki Run graph.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .runtime import SessionMessage

SessionStatus = Literal["active", "idle", "closed"]

_SCHEMA_VERSION = 1
_SESSION_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")
_MAX_TITLE_LEN = 80


def default_sessions_dir(project_root: Path | None = None) -> Path:
    """Project-local sessions directory (does not create it)."""
    root = project_root if project_root is not None else Path.cwd()
    return root / ".okf-wiki" / "sessions"


def new_session_id() -> str:
    return uuid.uuid4().hex


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_dt(value: object) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("timestamp must be an ISO-8601 string")
    text = value.strip()
    # datetime.fromisoformat accepts "Z" on 3.11+; normalize for safety.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _dt_to_json(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _session_message(role: str, content: str) -> SessionMessage:
    # Local import avoids store ↔ runtime import cycle at module load.
    from .runtime import SessionMessage

    if role == "user":
        return SessionMessage(role="user", content=content)
    if role == "system":
        return SessionMessage(role="system", content=content)
    if role == "assistant":
        return SessionMessage(role="assistant", content=content)
    return SessionMessage(role="session", content=content)


def derive_title(
    messages: Sequence[SessionMessage],
    *,
    fallback: str = "untitled",
) -> str:
    """Pick a short title from the first user message, else fallback."""
    for message in messages:
        if message.role == "user" and message.content.strip():
            text = " ".join(message.content.strip().split())
            if len(text) > _MAX_TITLE_LEN:
                return text[: _MAX_TITLE_LEN - 1].rstrip() + "…"
            return text
    return fallback


@dataclass(slots=True, frozen=True)
class SessionSummary:
    """Minimal list-row metadata for a persisted Operator Session."""

    id: str
    created_at: datetime
    updated_at: datetime
    title: str | None
    status: SessionStatus


@dataclass(slots=True)
class SessionSnapshot:
    """Persistable Operator Session state (history + flags only).

    Explicitly excludes Wiki Run graph state, Staging contents, and any
    publication decision. Resuming a snapshot never publishes.
    """

    id: str
    created_at: datetime
    updated_at: datetime
    title: str | None = None
    status: SessionStatus = "active"
    yolo: bool = False
    messages: list[SessionMessage] = field(default_factory=list)
    last_run_id: str | None = None
    schema_version: int = _SCHEMA_VERSION

    def to_summary(self) -> SessionSummary:
        return SessionSummary(
            id=self.id,
            created_at=self.created_at,
            updated_at=self.updated_at,
            title=self.title,
            status=self.status,
        )

    def to_json_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "created_at": _dt_to_json(self.created_at),
            "updated_at": _dt_to_json(self.updated_at),
            "title": self.title,
            "status": self.status,
            "yolo": bool(self.yolo),
            "last_run_id": self.last_run_id,
            "messages": [{"role": m.role, "content": m.content} for m in self.messages],
        }

    @classmethod
    def from_json_dict(cls, data: object) -> SessionSnapshot:
        if not isinstance(data, dict):
            raise ValueError("session snapshot must be a JSON object")
        session_id = data.get("id")
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("session snapshot missing id")
        status_raw = data.get("status", "active")
        status: SessionStatus = "idle"
        if status_raw == "active":
            status = "active"
        elif status_raw == "idle":
            status = "idle"
        elif status_raw == "closed":
            status = "closed"
        messages_raw = data.get("messages") or []
        if not isinstance(messages_raw, list):
            raise ValueError("session messages must be a list")
        messages: list[SessionMessage] = []
        for item in messages_raw:
            if not isinstance(item, dict):
                continue
            role_obj = item.get("role", "session")
            content_obj = item.get("content", "")
            role = role_obj if isinstance(role_obj, str) else "session"
            content = content_obj if isinstance(content_obj, str) else str(content_obj)
            messages.append(_session_message(role, content))
        title_obj = data.get("title")
        title: str | None
        if title_obj is None:
            title = None
        elif isinstance(title_obj, str):
            title = title_obj
        else:
            title = str(title_obj)
        last_run_obj = data.get("last_run_id")
        last_run_id: str | None
        if last_run_obj is None:
            last_run_id = None
        elif isinstance(last_run_obj, str):
            last_run_id = last_run_obj
        else:
            last_run_id = str(last_run_obj)
        version = data.get("schema_version", _SCHEMA_VERSION)
        schema_version = _SCHEMA_VERSION
        if isinstance(version, int):
            schema_version = version
        elif isinstance(version, str):
            try:
                schema_version = int(version)
            except ValueError:
                schema_version = _SCHEMA_VERSION
        created_raw = data.get("created_at")
        updated_raw = data.get("updated_at")
        try:
            created_at = _parse_dt(created_raw if created_raw is not None else _utc_now())
        except ValueError:
            created_at = _utc_now()
        try:
            updated_at = _parse_dt(updated_raw if updated_raw is not None else created_at)
        except ValueError:
            updated_at = created_at
        return cls(
            id=session_id.strip(),
            created_at=created_at,
            updated_at=updated_at,
            title=title,
            status=status,
            yolo=bool(data.get("yolo", False)),
            messages=messages,
            last_run_id=last_run_id,
            schema_version=schema_version,
        )


class SessionNotFoundError(LookupError):
    """Raised when a Session id is not present in the store."""


class SessionStore:
    """Create / list / load / save Operator Sessions as JSON files.

    API surface for ticket 07:

    * :meth:`create_session`
    * :meth:`list_sessions`
    * :meth:`load_session` / :meth:`resume_session` (alias; history only)

    ``resume_session`` restores multi-turn Session history. It does **not**
    resume a half-finished Wiki Run graph and does **not** publish Staging.
    """

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def ensure_root(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root

    def _path_for(self, session_id: str) -> Path:
        if not _SESSION_ID_RE.match(session_id):
            raise ValueError(f"invalid session id: {session_id!r}")
        return self.root / f"{session_id}.json"

    def create_session(
        self,
        *,
        title: str | None = None,
        yolo: bool = False,
        session_id: str | None = None,
        status: SessionStatus = "active",
        messages: Sequence[SessionMessage] | None = None,
    ) -> SessionSnapshot:
        """Create and persist a new Session. Never touches Host project config."""
        self.ensure_root()
        sid = session_id or new_session_id()
        if not _SESSION_ID_RE.match(sid):
            raise ValueError(f"invalid session id: {sid!r}")
        path = self._path_for(sid)
        if path.exists():
            raise FileExistsError(f"session already exists: {sid}")
        now = _utc_now()
        msg_list = list(messages or [])
        resolved_title = (
            title if title is not None else (derive_title(msg_list) if msg_list else None)
        )
        snapshot = SessionSnapshot(
            id=sid,
            created_at=now,
            updated_at=now,
            title=resolved_title,
            status=status,
            yolo=bool(yolo),
            messages=msg_list,
        )
        self._write(snapshot)
        return snapshot

    def list_sessions(self) -> list[SessionSummary]:
        """List Sessions for the project, newest ``updated_at`` first."""
        if not self.root.is_dir():
            return []
        rows: list[SessionSummary] = []
        for path in self.root.glob("*.json"):
            try:
                snapshot = self._read_path(path)
            except OSError, ValueError, json.JSONDecodeError, KeyError:
                continue
            rows.append(snapshot.to_summary())
        rows.sort(key=lambda row: row.updated_at, reverse=True)
        return rows

    def load_session(self, session_id: str) -> SessionSnapshot:
        """Load a Session snapshot by id."""
        path = self._path_for(session_id)
        if not path.is_file():
            raise SessionNotFoundError(f"session not found: {session_id}")
        return self._read_path(path)

    def resume_session(self, session_id: str) -> SessionSnapshot:
        """Resume = load history snapshot only (no Wiki Run / publish side effects)."""
        return self.load_session(session_id)

    def save_session(self, snapshot: SessionSnapshot) -> SessionSnapshot:
        """Persist an updated snapshot (refreshes ``updated_at``)."""
        self.ensure_root()
        title = snapshot.title
        if title is None and snapshot.messages:
            title = derive_title(snapshot.messages)
        updated = SessionSnapshot(
            id=snapshot.id,
            created_at=snapshot.created_at,
            updated_at=_utc_now(),
            title=title,
            status=snapshot.status,
            yolo=bool(snapshot.yolo),
            messages=list(snapshot.messages),
            last_run_id=snapshot.last_run_id,
            schema_version=snapshot.schema_version,
        )
        self._write(updated)
        return updated

    def _read_path(self, path: Path) -> SessionSnapshot:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError(f"invalid session file: {path}")
        return SessionSnapshot.from_json_dict(data)

    def _write(self, snapshot: SessionSnapshot) -> None:
        path = self._path_for(snapshot.id)
        payload = json.dumps(snapshot.to_json_dict(), indent=2, sort_keys=True) + "\n"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(path)


def format_session_list(rows: list[SessionSummary]) -> str:
    """Human-readable list for slash ``/sessions`` and CLI."""
    if not rows:
        return "No Operator Sessions yet. Use /new to create one."
    lines = ["Operator Sessions (newest first):"]
    for row in rows:
        title = row.title or "(no title)"
        updated = _dt_to_json(row.updated_at)
        lines.append(f"  {row.id[:12]}  {row.status:6}  {updated}  {title}")
    lines.append("Resume with /resume <id> (history only; does not publish or resume Wiki Run).")
    return "\n".join(lines)


__all__ = [
    "SessionNotFoundError",
    "SessionSnapshot",
    "SessionStatus",
    "SessionStore",
    "SessionSummary",
    "default_sessions_dir",
    "derive_title",
    "format_session_list",
    "new_session_id",
]
