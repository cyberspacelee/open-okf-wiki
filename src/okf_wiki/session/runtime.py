"""Operator Session runtime: multi-turn shell over bounded Wiki Runs.

The Session is the interactive product object (ADR 0018). A Wiki Run remains a
bounded Host job with frozen inputs; the Session starts Runs, projects Host
events into simplified cards, resolves deferred publication approval (HITL or
YOLO), and closes Needs Input by starting a **new** Wiki Run with
``explicit_answers``.

Multi-turn natural-language "ask" is currently stubbed: operator goals are
recorded in Session message history and a fresh Wiki Run is started from the
base request (optionally carrying answers). A full conversation Agent.iter
loop may attach later without changing the Host seam.

Multi-session list/resume (ticket 07) uses :class:`SessionStore` for history
snapshots only — never Wiki Run graph or Staging publication resume.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults

from ..diagnostics import (
    collect_credential_report,
    format_credential_report,
    preflight_provider_credentials,
)
from ..diagnostics.doctor import CredentialStatus
from ..publication_gate import (
    PublicationApprovalHandler,
    build_approve_results,
    build_deny_results,
)
from ..security import environment_secrets, redact_secrets, safe_error_message
from ..wiki_run import (
    NeedsInput,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
    WikiRunResult,
)
from .cards import SessionCard, project_event

if TYPE_CHECKING:
    from .store import SessionSnapshot, SessionStore

MessageRole = Literal["user", "system", "assistant", "session"]


@dataclass(slots=True, frozen=True)
class SessionMessage:
    """One turn of Session conversation history (not a Wiki Run transcript)."""

    role: MessageRole
    content: str


@dataclass(slots=True)
class SlashCommandResult:
    """Outcome of a slash command (no Wiki Run started)."""

    name: str
    message: str
    quit: bool = False
    yolo: bool | None = None
    doctor_report: list[CredentialStatus] | None = None
    # Multi-session slash side effects (ticket 07).
    session_switched: bool = False
    session_id: str | None = None


@dataclass(slots=True)
class WikiRunTurnResult:
    """Result of one Wiki Run started from the Session."""

    result: WikiRunResult
    request: WikiRunRequest
    cards: list[SessionCard]
    run_id: str | None
    yolo: bool


InputFn = Callable[[str], str]
CardSink = Callable[[SessionCard], None]


def interactive_publication_handler(
    *,
    input_fn: InputFn,
    defects_formatter: Callable[[Mapping[str, object] | None], str] | None = None,
) -> PublicationApprovalHandler:
    """Build a HITL approval handler that prompts the operator on stdin."""

    def format_defects(defects: Mapping[str, object] | None) -> str:
        if defects_formatter is not None:
            return defects_formatter(defects)
        if not defects:
            return "No reviewer defects summary."
        secrets = environment_secrets()
        lines: list[str] = []
        status = defects.get("status")
        if status is not None:
            lines.append(f"reviewer status: {status}")
        summary = defects.get("summary")
        if isinstance(summary, str) and summary.strip():
            lines.append(f"summary: {redact_secrets(summary.strip(), secrets)}")
        count = defects.get("defect_count")
        if count is not None:
            lines.append(f"defect_count: {count}")
        findings = defects.get("findings")
        if isinstance(findings, Sequence) and not isinstance(findings, (str, bytes)):
            for index, finding in enumerate(list(findings)[:8], start=1):
                text = redact_secrets(str(finding), secrets)
                lines.append(f"  {index}. {text}")
        return "\n".join(lines) if lines else "No reviewer defects summary."

    def handler(requests: DeferredToolRequests) -> DeferredToolResults:
        defects: Mapping[str, object] | None = None
        if requests.approvals:
            args = requests.approvals[0].args
            if isinstance(args, dict):
                raw = args.get("defects")
                if isinstance(raw, Mapping):
                    defects = raw
        panel = (
            "=== Publish gate ===\n"
            f"{format_defects(defects)}\n"
            "Approve publication to the Published Wiki?\n"
            "[y] approve  [n] deny (Staging kept, Published unchanged)"
        )
        answer = input_fn(f"{panel}\n> ").strip().lower()
        if answer in {"y", "yes", "approve", "a"}:
            return build_approve_results(requests)
        return build_deny_results(requests)

    return handler


@dataclass(slots=True)
class OperatorSession:
    """In-process Operator Session: history, cards, YOLO, Wiki Run jobs.

    Inject ``publication_approval_handler`` for tests; interactive adapters pass
    :func:`interactive_publication_handler`. When ``yolo`` is True, the Host
    auto-approves deferred publication (validation and Reviewer still run).

    Optional ``store`` enables multi-session create/list/resume (ticket 07).
    Persist/resume restore message history only — never auto-publish or resume
    a half-finished Wiki Run graph.
    """

    base_request: WikiRunRequest
    yolo: bool = False
    mode: Literal["build", "ask"] = "build"
    publication_approval_handler: PublicationApprovalHandler | None = None
    on_card: CardSink | None = None
    store: SessionStore | None = None
    session_id: str | None = None
    title: str | None = None
    status: Literal["active", "idle", "closed"] = "active"
    created_at: datetime | None = None
    message_history: list[SessionMessage] = field(default_factory=list)
    cards: list[SessionCard] = field(default_factory=list)
    last_run_id: str | None = None
    last_result: WikiRunResult | None = None
    last_request: WikiRunRequest | None = None
    last_run_status: str | None = None
    last_usage: dict[str, object] | None = None

    def set_yolo(self, enabled: bool) -> None:
        self.yolo = bool(enabled)
        state = "on" if self.yolo else "off"
        self._note("system", f"YOLO auto-approve publication: {state}")

    def set_mode(self, mode: Literal["build", "ask"]) -> None:
        if mode not in {"build", "ask"}:
            raise ValueError("mode must be 'build' or 'ask'")
        self.mode = mode
        self._note("system", f"Session mode: {mode}")

    def yolo_indicator(self) -> str:
        return "YOLO" if self.yolo else "HITL"

    def mode_indicator(self) -> str:
        return self.mode

    def preflight(self) -> None:
        """Fail fast on missing credentials before expensive Session work."""
        preflight_provider_credentials(self.base_request.model.model)

    def doctor(self) -> list[CredentialStatus]:
        return collect_credential_report()

    def doctor_text(self) -> str:
        return format_credential_report(self.doctor())

    def append_user(self, text: str) -> None:
        self._note("user", text)

    def _note(self, role: MessageRole, content: str) -> None:
        safe = redact_secrets(content, environment_secrets())
        self.message_history.append(SessionMessage(role=role, content=safe))

    def to_snapshot(self) -> SessionSnapshot:
        """Build a persistable history snapshot (no Wiki Run / Staging state)."""
        from .store import SessionSnapshot, derive_title, new_session_id

        now = datetime.now(UTC)
        sid = self.session_id or new_session_id()
        created = self.created_at or now
        title = self.title
        if title is None and self.message_history:
            title = derive_title(self.message_history)
        return SessionSnapshot(
            id=sid,
            created_at=created,
            updated_at=now,
            title=title,
            status=self.status,
            yolo=bool(self.yolo),
            messages=list(self.message_history),
            last_run_id=self.last_run_id,
        )

    def apply_snapshot(self, snapshot: SessionSnapshot) -> None:
        """Restore multi-turn history from a store snapshot.

        Does not start a Wiki Run, does not publish Staging, and does not
        resume a Semantic Workflow / graph. Cards and last Host result are
        cleared so resume is conversation context only.
        """
        self.session_id = snapshot.id
        self.created_at = snapshot.created_at
        self.title = snapshot.title
        self.status = snapshot.status
        self.yolo = bool(snapshot.yolo)
        self.message_history = list(snapshot.messages)
        self.last_run_id = snapshot.last_run_id
        # In-process Host job view is not part of resume.
        self.cards = []
        self.last_result = None
        self.last_request = None

    def persist(self) -> SessionSnapshot:
        """Save current Session history via the configured store."""
        if self.store is None:
            raise RuntimeError("OperatorSession.persist requires a SessionStore")
        snapshot = self.to_snapshot()
        path = self.store.root / f"{snapshot.id}.json"
        if path.is_file():
            try:
                existing = self.store.load_session(snapshot.id)
                snapshot.created_at = existing.created_at
            except Exception:
                pass
            saved = self.store.save_session(snapshot)
        else:
            saved = self.store.create_session(
                session_id=snapshot.id,
                title=snapshot.title,
                yolo=snapshot.yolo,
                status=snapshot.status,
                messages=snapshot.messages,
            )
        self.session_id = saved.id
        self.created_at = saved.created_at
        self.title = saved.title
        self.status = saved.status
        return saved

    def start_new_session(self, *, title: str | None = None) -> SessionSnapshot:
        """Start a new Session without destroying project Host config.

        Persists the current Session if a store is configured and the current
        Session has history or an id, then clears in-process history for a
        fresh Session. Host ``base_request`` (wiki-run.yaml paths) is unchanged.
        """
        from .store import SessionSnapshot, new_session_id

        if self.store is not None and (self.session_id or self.message_history):
            try:
                self.status = "idle"
                self.persist()
            except Exception:
                # Best-effort save of previous session; still allow /new.
                pass

        self.session_id = None
        self.created_at = datetime.now(UTC)
        self.title = title
        self.status = "active"
        self.message_history = []
        self.cards = []
        self.last_run_id = None
        self.last_result = None
        self.last_request = None
        # YOLO flag is a Session preference; reset to base request default.
        self.yolo = bool(self.base_request.auto_approve_publication)

        if self.store is not None:
            snapshot = self.store.create_session(
                title=title,
                yolo=self.yolo,
                status="active",
            )
            self.apply_snapshot(snapshot)
            return snapshot

        sid = new_session_id()
        self.session_id = sid
        return SessionSnapshot(
            id=sid,
            created_at=self.created_at or datetime.now(UTC),
            updated_at=datetime.now(UTC),
            title=title,
            status="active",
            yolo=self.yolo,
        )

    def resume_from_store(self, session_id: str) -> SessionSnapshot:
        """Load Session history by id. Never publishes or resumes a Wiki Run."""
        if self.store is None:
            raise RuntimeError("resume_from_store requires a SessionStore")
        # Best-effort save of the active Session before switching.
        if self.session_id and self.session_id != session_id and self.message_history:
            try:
                self.status = "idle"
                self.persist()
            except Exception:
                pass
        snapshot = self.store.resume_session(session_id)
        self.apply_snapshot(snapshot)
        self.status = "active"
        self._note(
            "session",
            f"resumed Session {snapshot.id[:12]} (history only; Wiki Run not resumed)",
        )
        return snapshot

    def observe(self, event: WikiRunEvent) -> SessionCard:
        card = project_event(event)
        self.cards.append(card)
        self.last_run_id = event.run_id
        if self.on_card is not None:
            self.on_card(card)
        return card

    def request_for_run(
        self,
        *,
        explicit_answers: Mapping[str, str] | None = None,
        request: WikiRunRequest | None = None,
    ) -> WikiRunRequest:
        """Build the next Wiki Run request from Session state.

        Always produces a **new** run identity at Host time. Merges
        ``explicit_answers`` into the request for Needs Input follow-ups.
        YOLO on the Session forces ``auto_approve_publication=True``.
        """
        base = request if request is not None else self.base_request
        updates: dict[str, object] = {}
        # Session YOLO is authoritative for interactive runs (slash /yolo toggles it).
        if base.auto_approve_publication != self.yolo:
            updates["auto_approve_publication"] = self.yolo
        if explicit_answers:
            merged = dict(base.explicit_answers)
            merged.update({str(k): str(v) for k, v in explicit_answers.items()})
            updates["explicit_answers"] = merged
        if updates:
            return base.model_copy(update=updates)
        return base

    def collect_needs_input_answers(
        self,
        needs_input: NeedsInput,
        *,
        input_fn: InputFn,
        run_id: str | None = None,
    ) -> dict[str, str]:
        """Prompt for each Needs Input question; return answer map for a new Run."""
        secrets = environment_secrets()
        answers: dict[str, str] = {}
        prefix = run_id or self.last_run_id or "run"
        for index, question in enumerate(needs_input.questions, start=1):
            safe_question = redact_secrets(question, secrets)
            answer = input_fn(f"Q{index}: {safe_question}\n> ")
            answers[f"{prefix}:{index}"] = answer.strip()
        self._note(
            "session",
            f"collected {len(answers)} Needs Input answer(s) for a new Wiki Run",
        )
        return answers

    async def run_wiki(
        self,
        *,
        request: WikiRunRequest | None = None,
        explicit_answers: Mapping[str, str] | None = None,
        publication_approval_handler: PublicationApprovalHandler | None = None,
    ) -> WikiRunTurnResult:
        """Start one Wiki Run as a Session job; project events into cards."""
        run_request = self.request_for_run(
            explicit_answers=explicit_answers,
            request=request,
        )
        self.last_request = run_request
        turn_cards: list[SessionCard] = []

        def observer(event: WikiRunEvent) -> None:
            card = self.observe(event)
            turn_cards.append(card)

        handler = (
            publication_approval_handler
            if publication_approval_handler is not None
            else self.publication_approval_handler
        )
        # When YOLO is on, Host auto_approve skips the handler (gate precedence).
        application = WikiRunApplication(
            observer=observer,
            publication_approval_handler=None if run_request.auto_approve_publication else handler,
        )
        result = await application.run(run_request)
        self.last_result = result
        self.last_run_id = application.last_run_id or self.last_run_id
        self.last_run_status = getattr(application, "last_run_status", None)
        status = self.last_run_status or getattr(result, "status", type(result).__name__)
        self._note("assistant", f"Wiki Run finished: {status}")
        # Best-effort Session history persist after each Host job (not graph resume).
        if self.store is not None:
            try:
                if self.title is None and self.message_history:
                    from .store import derive_title

                    self.title = derive_title(self.message_history)
                self.persist()
            except Exception:
                pass
        return WikiRunTurnResult(
            result=result,
            request=run_request,
            cards=turn_cards,
            run_id=self.last_run_id,
            yolo=bool(run_request.auto_approve_publication),
        )

    def note_ask(self, question: str) -> str:
        """Record an ask-mode turn without starting a Wiki Run or publishing.

        Full conversation ``Agent.iter`` remains future work; ask mode keeps
        Operator Session multi-turn history without Host publication side effects.
        """
        self.append_user(question)
        reply = (
            "ask mode: recorded your question in Session history. "
            "No Wiki Run started and Published Wiki is unchanged. "
            "Switch to /mode build to generate or refresh the Wiki."
        )
        self._note("assistant", reply)
        if self.store is not None:
            try:
                self.persist()
            except Exception:
                pass
        return reply

    async def continue_after_needs_input(
        self,
        prior: WikiRunTurnResult,
        answers: Mapping[str, str],
        *,
        publication_approval_handler: PublicationApprovalHandler | None = None,
    ) -> WikiRunTurnResult:
        """Start a **new** Wiki Run carrying explicit answers (does not resume)."""
        if not isinstance(prior.result, NeedsInput):
            raise ValueError("continue_after_needs_input requires a NeedsInput prior result")
        if not answers:
            raise ValueError("continue_after_needs_input requires at least one answer")
        self._note(
            "session",
            "starting new Wiki Run with explicit_answers (Manual Needs Input close)",
        )
        return await self.run_wiki(
            request=prior.request,
            explicit_answers=answers,
            publication_approval_handler=publication_approval_handler,
        )

    def handle_slash(self, line: str) -> SlashCommandResult | None:
        """Parse and apply a slash command. Returns None when line is not slash."""
        text = line.strip()
        if not text.startswith("/"):
            return None
        parts = text[1:].split(maxsplit=1)
        if not parts:
            return SlashCommandResult(name="", message="Empty slash command. Try /help.")
        name = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""

        if name in {"quit", "exit", "q"}:
            return SlashCommandResult(name=name, message="Exiting Operator Session.", quit=True)

        if name == "yolo":
            if arg in {"on", "1", "true", "yes"}:
                self.set_yolo(True)
            elif arg in {"off", "0", "false", "no"}:
                self.set_yolo(False)
            elif arg == "":
                self.set_yolo(not self.yolo)
            else:
                return SlashCommandResult(
                    name="yolo",
                    message="Usage: /yolo [on|off] — toggles auto-approve publication only.",
                    yolo=self.yolo,
                )
            state = "on" if self.yolo else "off"
            return SlashCommandResult(
                name="yolo",
                message=f"YOLO auto-approve publication: {state}",
                yolo=self.yolo,
            )

        if name == "doctor":
            report = self.doctor()
            return SlashCommandResult(
                name="doctor",
                message=format_credential_report(report),
                doctor_report=report,
            )

        if name == "mode":
            if arg in {"build", "b"}:
                self.set_mode("build")
            elif arg in {"ask", "a"}:
                self.set_mode("ask")
            elif arg == "":
                return SlashCommandResult(
                    name="mode",
                    message=f"Session mode: {self.mode} (build starts Wiki Runs; ask records only)",
                )
            else:
                return SlashCommandResult(
                    name="mode",
                    message="Usage: /mode build|ask — build runs Wiki jobs; ask only records history.",
                )
            return SlashCommandResult(
                name="mode",
                message=f"Session mode: {self.mode}",
            )

        if name == "usage":
            if self.last_run_id is None and self.last_run_status is None:
                return SlashCommandResult(
                    name="usage",
                    message="No Wiki Run in this Session yet.",
                )
            bits = [
                f"last_run_id={self.last_run_id or '(none)'}",
                f"last_run_status={self.last_run_status or '(unknown)'}",
                f"mode={self.mode}",
                f"yolo={self.yolo}",
            ]
            return SlashCommandResult(name="usage", message=" · ".join(bits))

        if name == "sessions":
            if self.store is None:
                return SlashCommandResult(
                    name="sessions",
                    message="Session store not configured; multi-session list unavailable.",
                )
            from .store import format_session_list

            # Ensure current Session is visible when it has an id.
            if self.session_id is not None or self.message_history:
                try:
                    self.persist()
                except Exception:
                    pass
            rows = self.store.list_sessions()
            return SlashCommandResult(name="sessions", message=format_session_list(rows))

        if name == "new":
            snapshot = self.start_new_session(title=arg or None)
            return SlashCommandResult(
                name="new",
                message=(
                    f"Started new Operator Session {snapshot.id[:12]} "
                    f"[{self.yolo_indicator()}]. Project Host config unchanged."
                ),
                session_switched=True,
                session_id=snapshot.id,
                yolo=self.yolo,
            )

        if name == "resume":
            if not arg:
                return SlashCommandResult(
                    name="resume",
                    message="Usage: /resume <session-id> — restores history only; does not publish.",
                )
            if self.store is None:
                return SlashCommandResult(
                    name="resume",
                    message="Session store not configured; cannot resume.",
                )
            # Accept full id or unique prefix from /sessions listing.
            target = arg.strip().lower()
            resolved = target
            if len(target) < 32:
                matches = [
                    row.id for row in self.store.list_sessions() if row.id.startswith(target)
                ]
                if len(matches) == 1:
                    resolved = matches[0]
                elif len(matches) == 0:
                    return SlashCommandResult(
                        name="resume",
                        message=f"No Session matches id prefix {target!r}. Use /sessions.",
                    )
                else:
                    return SlashCommandResult(
                        name="resume",
                        message=f"Ambiguous Session prefix {target!r}; provide more characters.",
                    )
            try:
                snapshot = self.resume_from_store(resolved)
            except Exception as error:
                return SlashCommandResult(
                    name="resume",
                    message=(
                        f"Could not resume Session: "
                        f"{type(error).__name__}: {safe_error_message(error) if isinstance(error, Exception) else error}"
                    ),
                )
            hist = len(snapshot.messages)
            return SlashCommandResult(
                name="resume",
                message=(
                    f"Resumed Session {snapshot.id[:12]} "
                    f"({hist} message(s), title={snapshot.title or '(none)'}). "
                    "History restored; Wiki Run graph and Staging publication were not resumed."
                ),
                session_switched=True,
                session_id=snapshot.id,
                yolo=self.yolo,
            )

        if name in {"help", "?"}:
            return SlashCommandResult(
                name="help",
                message=(
                    "Operator Session commands:\n"
                    "  /yolo [on|off]  Toggle publication auto-approve (YOLO)\n"
                    "  /mode build|ask Build starts Wiki Runs; ask records history only\n"
                    "  /usage          Last Wiki Run id/status in this Session\n"
                    "  /doctor         Credential presence (set/unset, redacted)\n"
                    "  /sessions       List Operator Sessions for this project\n"
                    "  /new            Start a new Session (Host config unchanged)\n"
                    "  /resume <id>    Resume Session history (does not publish)\n"
                    "  /quit           Exit the Session\n"
                    "  /help           This help\n"
                    "In build mode, type a goal to start a Wiki Run from config.\n"
                    "In ask mode, messages are recorded without Host publication.\n"
                    "Needs Input answers start a new Wiki Run with explicit_answers.\n"
                    "Publication requires approve/deny unless YOLO is on."
                ),
            )

        return SlashCommandResult(
            name=name,
            message=f"Unknown command /{name}. Try /help.",
        )


__all__ = [
    "InputFn",
    "OperatorSession",
    "SessionMessage",
    "SlashCommandResult",
    "WikiRunTurnResult",
    "interactive_publication_handler",
]
