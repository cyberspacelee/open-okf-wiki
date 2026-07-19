"""Operator Session runtime: multi-turn shell over bounded Wiki Runs.

The Session is the interactive product object (ADR 0018). A Wiki Run remains a
bounded Wiki Run with frozen inputs; the Session starts Runs, projects run
events into simplified cards, resolves deferred publication approval (HITL or
YOLO), and closes Needs Input by starting a **new** Wiki Run with
``explicit_answers``.

Multi-turn natural-language "ask" is currently stubbed: operator goals are
recorded in Session message history and a fresh Wiki Run is started from the
base request (optionally carrying answers). A full conversation Agent.iter
loop may attach later without changing the Run Boundary seam.

Multi-session list/resume (ticket 07) uses :class:`SessionStore` for history
snapshots only — never Wiki Run graph or Staging publication resume.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
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
from ..run.publication.gate import (
    PublicationApprovalHandler,
    build_approve_results,
    build_deny_results,
)
from ..run.security import environment_secrets, redact_secrets, safe_error_message
from ..run import (
    NeedsInput,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
    WikiRunResult,
)
from .cards import SessionCard, project_event
from .stream import StreamFragment, StreamSink, make_event_stream_handler

if TYPE_CHECKING:
    from .store import SessionSnapshot, SessionStore

MessageRole = Literal["user", "system", "assistant", "session"]

# Sync or async collector: (needs_input, run_id) → answer map for a new Wiki Run.
CollectAnswersFn = Callable[
    [NeedsInput, str | None],
    Mapping[str, str] | Awaitable[Mapping[str, str]],
]


def format_run_error(error: BaseException) -> str:
    """Redacted one-line error for Session adapters (TUI / line shell)."""
    if isinstance(error, Exception):
        detail = safe_error_message(error)
        return f"{type(error).__name__}: {detail}"
    return f"{type(error).__name__}: {error}"


@dataclass(slots=True, frozen=True)
class SessionMessage:
    """One turn of Session conversation history (not a Wiki Run transcript)."""

    role: MessageRole
    content: str


@dataclass(slots=True)
class SlashCommandResult:
    """Outcome of a slash command (presentation adapter may start a Wiki Run)."""

    name: str
    message: str
    quit: bool = False
    yolo: bool | None = None
    doctor_report: list[CredentialStatus] | None = None
    # Multi-session slash side effects (ticket 07).
    session_switched: bool = False
    session_id: str | None = None
    # When True, the TUI/shell should start a Wiki Run from Session config.
    start_run: bool = False


@dataclass(slots=True, frozen=True)
class SlashCommandSpec:
    """One Operator Session slash command (primary name + optional aliases/args)."""

    name: str
    summary: str
    aliases: tuple[str, ...] = ()
    args: tuple[str, ...] = ()
    # Free-form / dynamic argument (Session id, list index, optional title).
    takes_ref: bool = False


# Canonical slash catalog — keep /help text and TUI Tab completion in sync.
SLASH_COMMANDS: tuple[SlashCommandSpec, ...] = (
    SlashCommandSpec(
        "run",
        "Start a Wiki Run from Session config",
        aliases=("start", "generate", "refresh"),
    ),
    SlashCommandSpec(
        "yolo",
        "Toggle publication auto-approve (YOLO)",
        args=("on", "off"),
    ),
    SlashCommandSpec(
        "mode",
        "build starts Wiki Runs; ask records history only",
        args=("build", "ask"),
    ),
    SlashCommandSpec("usage", "Last Wiki Run id/status in this Session"),
    SlashCommandSpec("doctor", "Credential presence (set/unset, redacted)"),
    SlashCommandSpec(
        "sessions",
        "List Sessions, or switch with /sessions <n|id>",
        takes_ref=True,
    ),
    SlashCommandSpec("new", "Start a new empty Session (run config unchanged)", takes_ref=True),
    SlashCommandSpec(
        "switch",
        "Switch Session by list number or id (alias: /resume)",
        aliases=("resume",),
        takes_ref=True,
    ),
    SlashCommandSpec("quit", "Exit the Session", aliases=("exit", "q")),
    SlashCommandSpec("help", "Show slash command help", aliases=("?",)),
)


def slash_command_names() -> tuple[str, ...]:
    """Primary names plus aliases, for suggesters and tests."""
    names: list[str] = []
    for spec in SLASH_COMMANDS:
        names.append(spec.name)
        names.extend(spec.aliases)
    return tuple(names)


def slash_suggestion_strings() -> tuple[str, ...]:
    """Full command strings (with leading ``/``) for inline Input suggestions."""
    items: list[str] = []
    for spec in SLASH_COMMANDS:
        names = (spec.name, *spec.aliases)
        for name in names:
            if spec.args:
                for arg in spec.args:
                    items.append(f"/{name} {arg}")
                items.append(f"/{name} ")
            items.append(f"/{name}")
    # Prefer shorter exact commands first so prefix match feels natural.
    return tuple(sorted(set(items), key=lambda s: (len(s), s)))


def list_slash_completions(
    value: str,
    *,
    session_ids: Sequence[str] = (),
) -> list[str]:
    """Return slash completions for the current input line (leading ``/`` only).

    Completes the command name, fixed args (``/mode``, ``/yolo``), and Session
    refs for ``/switch`` / ``/resume`` / ``/sessions`` when ``session_ids`` is
    provided (newest-first order; indices match ``/sessions``).
    """
    text = value
    if not text.startswith("/"):
        return []
    body = text[1:]
    if " " in body:
        name, _, arg_prefix = body.partition(" ")
        name_l = name.lower()
        spec = _slash_spec_for_name(name_l)
        if spec is None:
            return []
        if spec.args:
            arg_key = arg_prefix.casefold()
            return [f"/{name} {arg}" for arg in spec.args if arg.casefold().startswith(arg_key)]
        if spec.takes_ref and name_l in {"switch", "resume", "sessions"}:
            return _session_ref_completions(name, arg_prefix, session_ids)
        return []

    prefix = body.casefold()
    matches: list[str] = []
    for spec in SLASH_COMMANDS:
        for name in (spec.name, *spec.aliases):
            if name.casefold().startswith(prefix):
                # Trailing space when the command expects an argument next.
                if (spec.args or spec.takes_ref) and prefix == name.casefold():
                    matches.append(f"/{name} ")
                else:
                    matches.append(f"/{name}")
    # Unique, stable order (primary catalog order, then alias order).
    seen: set[str] = set()
    ordered: list[str] = []
    for item in matches:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered


def apply_slash_completion(
    value: str,
    *,
    reverse: bool = False,
    session_ids: Sequence[str] = (),
) -> str | None:
    """Return the next Tab-completion replacement for ``value``, or None."""
    matches = list_slash_completions(value, session_ids=session_ids)
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    # Longest common prefix when it advances the line (bash-style).
    common = _common_prefix(matches)
    if len(common) > len(value):
        return common
    # Otherwise cycle through full matches.
    try:
        idx = matches.index(value)
    except ValueError:
        idx = -1
    if reverse:
        return matches[(idx - 1) % len(matches)]
    return matches[(idx + 1) % len(matches)]


def format_slash_help() -> str:
    """Human-readable /help body (shared by Session shell adapters)."""
    lines = ["Operator Session commands:"]
    for spec in SLASH_COMMANDS:
        label = f"/{spec.name}"
        if spec.args:
            label = f"/{spec.name} {'|'.join(spec.args)}"
        elif spec.name in {"sessions", "switch"}:
            label = f"/{spec.name} [n|id]"
        alias_note = ""
        if spec.aliases:
            shown = ", ".join(f"/{a}" for a in spec.aliases if a not in {"?", "q", "exit"})
            if shown:
                alias_note = f" (alias: {shown})"
        lines.append(f"  {label:<20} {spec.summary}{alias_note}")
    lines.extend(
        [
            "Entry does not auto-start a Wiki Run.",
            "Switching Session clears the chat pane and reloads that Session's history only.",
            "In build mode, type a goal or /run to start a Wiki Run from config.",
            "In ask mode, messages are recorded without run publication.",
            "Needs Input answers start a new Wiki Run with explicit_answers.",
            "Publication requires approve/deny unless YOLO is on.",
            "TUI: Tab completes slash commands and Session numbers/ids; Shift+Tab cycles.",
        ]
    )
    return "\n".join(lines)


def _session_ref_completions(
    command: str,
    arg_prefix: str,
    session_ids: Sequence[str],
) -> list[str]:
    """Completions for /switch|/resume|/sessions args: list index or id prefix."""
    if not session_ids:
        return []
    key = arg_prefix.strip().casefold()
    matches: list[str] = []
    seen: set[str] = set()
    for index, session_id in enumerate(session_ids, start=1):
        short = session_id[:12]
        # Prefer the list number (matches /sessions output) then short id.
        for token in (str(index), short):
            if key and not token.casefold().startswith(key):
                continue
            item = f"/{command} {token}"
            if item not in seen:
                seen.add(item)
                matches.append(item)
    return matches


def _slash_spec_for_name(name: str) -> SlashCommandSpec | None:
    key = name.casefold()
    for spec in SLASH_COMMANDS:
        if spec.name == key or key in spec.aliases:
            return spec
    return None


def _common_prefix(items: Sequence[str]) -> str:
    if not items:
        return ""
    prefix = items[0]
    for item in items[1:]:
        while not item.startswith(prefix):
            prefix = prefix[:-1]
            if not prefix:
                return ""
    return prefix


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


def _format_publication_defects(
    defects: Mapping[str, object] | None,
    *,
    defects_formatter: Callable[[Mapping[str, object] | None], str] | None = None,
) -> str:
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


def _publication_panel(
    requests: DeferredToolRequests,
    *,
    defects_formatter: Callable[[Mapping[str, object] | None], str] | None = None,
) -> str:
    defects: Mapping[str, object] | None = None
    if requests.approvals:
        args = requests.approvals[0].args
        if isinstance(args, dict):
            raw = args.get("defects")
            if isinstance(raw, Mapping):
                defects = raw
    return (
        "=== Publish gate ===\n"
        f"{_format_publication_defects(defects, defects_formatter=defects_formatter)}\n"
        "Approve publication to the Published Wiki?\n"
        "[y] approve  [n] deny (Staging kept, Published unchanged)"
    )


def interactive_publication_handler(
    *,
    input_fn: InputFn | None = None,
    async_input_fn: Callable[[str], Awaitable[str]] | None = None,
    defects_formatter: Callable[[Mapping[str, object] | None], str] | None = None,
) -> PublicationApprovalHandler:
    """Build a HITL approval handler that prompts the operator.

    Prefer ``async_input_fn`` for the fullscreen Textual app (non-blocking UI).
    ``input_fn`` covers the line-oriented shell and unit tests.
    """
    if async_input_fn is not None:

        async def async_handler(requests: DeferredToolRequests) -> DeferredToolResults:
            panel = _publication_panel(requests, defects_formatter=defects_formatter)
            answer = (await async_input_fn(f"{panel}\n> ")).strip().lower()
            if answer in {"y", "yes", "approve", "a"}:
                return build_approve_results(requests)
            return build_deny_results(requests)

        return async_handler

    if input_fn is None:
        raise TypeError("interactive_publication_handler requires input_fn or async_input_fn")

    def handler(requests: DeferredToolRequests) -> DeferredToolResults:
        panel = _publication_panel(requests, defects_formatter=defects_formatter)
        answer = input_fn(f"{panel}\n> ").strip().lower()
        if answer in {"y", "yes", "approve", "a"}:
            return build_approve_results(requests)
        return build_deny_results(requests)

    return handler


@dataclass(slots=True)
class OperatorSession:
    """In-process Operator Session: history, cards, YOLO, Wiki Run jobs.

    Inject ``publication_approval_handler`` for tests; interactive adapters pass
    :func:`interactive_publication_handler`. When ``yolo`` is True, the Run Boundary
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
    on_stream: StreamSink | None = None
    store: SessionStore | None = None
    session_id: str | None = None
    title: str | None = None
    status: Literal["active", "idle", "closed"] = "active"
    created_at: datetime | None = None
    message_history: list[SessionMessage] = field(default_factory=list)
    cards: list[SessionCard] = field(default_factory=list)
    stream_fragments: list[StreamFragment] = field(default_factory=list)
    last_run_id: str | None = None
    last_result: WikiRunResult | None = None
    last_request: WikiRunRequest | None = None
    last_run_status: str | None = None

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
        resume a Semantic Workflow / graph. Cards and last run result are
        cleared so resume is conversation context only.
        """
        self.session_id = snapshot.id
        self.created_at = snapshot.created_at
        self.title = snapshot.title
        self.status = snapshot.status
        self.yolo = bool(snapshot.yolo)
        self.message_history = list(snapshot.messages)
        self.last_run_id = snapshot.last_run_id
        # In-process Wiki Run view is not part of resume.
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
        """Start a new Session without destroying project run config.

        Persists the current Session if a store is configured and the current
        Session has history or an id, then clears in-process history for a
        fresh Session. Session ``base_request`` (wiki-run.yaml paths) is unchanged.
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

    def observe_stream(self, fragment: StreamFragment) -> StreamFragment:
        """Record a projected model/tool stream fragment and fan out to the sink."""
        self.stream_fragments.append(fragment)
        if self.on_stream is not None:
            self.on_stream(fragment)
        return fragment

    def request_for_run(
        self,
        *,
        explicit_answers: Mapping[str, str] | None = None,
        request: WikiRunRequest | None = None,
    ) -> WikiRunRequest:
        """Build the next Wiki Run request from Session state.

        Always produces a **new** run identity at run start. Merges
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

    async def collect_needs_input_answers_async(
        self,
        needs_input: NeedsInput,
        *,
        async_input_fn: Callable[[str], Awaitable[str]],
        run_id: str | None = None,
    ) -> dict[str, str]:
        """Async Needs Input collection for the fullscreen TUI (non-blocking)."""
        secrets = environment_secrets()
        answers: dict[str, str] = {}
        prefix = run_id or self.last_run_id or "run"
        for index, question in enumerate(needs_input.questions, start=1):
            safe_question = redact_secrets(question, secrets)
            answer = await async_input_fn(f"Q{index}: {safe_question}\n> ")
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
        # When YOLO is on, run auto_approve skips the handler (gate precedence).
        # Stream handler only when a UI/test sink is attached (pydantic-ai events).
        stream_handler = make_event_stream_handler(
            self.observe_stream if self.on_stream is not None else None
        )
        application = WikiRunApplication(
            observer=observer,
            publication_approval_handler=None if run_request.auto_approve_publication else handler,
            event_stream_handler=stream_handler,
        )
        result = await application.run(run_request)
        self.last_result = result
        self.last_run_id = application.last_run_id or self.last_run_id
        self.last_run_status = getattr(application, "last_run_status", None)
        status = self.last_run_status or getattr(result, "status", type(result).__name__)
        self._note("assistant", f"Wiki Run finished: {status}")
        # Best-effort Session history persist after each Wiki Run (not graph resume).
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
        Operator Session multi-turn history without run publication side effects.
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

    async def _resolve_needs_input_answers(
        self,
        needs_input: NeedsInput,
        *,
        run_id: str | None,
        collect_answers: CollectAnswersFn | None,
        input_fn: InputFn | None,
        async_input_fn: Callable[[str], Awaitable[str]] | None,
    ) -> dict[str, str]:
        """Collect Needs Input answers via injectables (no UI)."""
        if collect_answers is not None:
            collected = collect_answers(needs_input, run_id)
            if isinstance(collected, Mapping):
                answers = collected
            else:
                answers = await collected
            return {str(k): str(v) for k, v in answers.items()}
        if async_input_fn is not None:
            return await self.collect_needs_input_answers_async(
                needs_input,
                async_input_fn=async_input_fn,
                run_id=run_id,
            )
        if input_fn is not None:
            return self.collect_needs_input_answers(
                needs_input,
                input_fn=input_fn,
                run_id=run_id,
            )
        raise TypeError(
            "run_turn requires collect_answers, input_fn, or async_input_fn "
            "when the Wiki Run returns NeedsInput"
        )

    async def run_turn(
        self,
        *,
        label: str | None = None,
        collect_answers: CollectAnswersFn | None = None,
        input_fn: InputFn | None = None,
        async_input_fn: Callable[[str], Awaitable[str]] | None = None,
        publication_approval_handler: PublicationApprovalHandler | None = None,
        request: WikiRunRequest | None = None,
        explicit_answers: Mapping[str, str] | None = None,
    ) -> WikiRunTurnResult:
        """Run one operator turn: optional goal label → Wiki Run → Needs Input loop.

        Pure product logic for both the Textual app and the line shell. Adapters
        inject I/O only (``collect_answers``, ``input_fn``, or ``async_input_fn``)
        and handle presentation of start/finish status themselves.

        Needs Input always starts a **new** Wiki Run with ``explicit_answers``
        (does not resume the prior graph). Publication HITL still goes through
        ``publication_approval_handler`` / Session YOLO precedence on each Run.
        """
        if label:
            self.append_user(label)

        turn = await self.run_wiki(
            request=request,
            explicit_answers=explicit_answers,
            publication_approval_handler=publication_approval_handler,
        )

        while isinstance(turn.result, NeedsInput):
            answers = await self._resolve_needs_input_answers(
                turn.result,
                run_id=turn.run_id,
                collect_answers=collect_answers,
                input_fn=input_fn,
                async_input_fn=async_input_fn,
            )
            turn = await self.continue_after_needs_input(
                turn,
                answers,
                publication_approval_handler=publication_approval_handler,
            )
        return turn

    def _switch_to_session_ref(self, ref: str, *, command_name: str) -> SlashCommandResult:
        """Switch to a Session by list index, full id, or unique prefix."""
        from .store import SessionNotFoundError, resolve_session_ref

        if self.store is None:
            return SlashCommandResult(
                name=command_name,
                message="Session store not configured; cannot switch Session.",
            )
        # Persist current so it appears in /sessions before we leave it.
        if self.session_id is not None or self.message_history:
            try:
                self.persist()
            except Exception:
                pass
        rows = self.store.list_sessions()
        try:
            resolved = resolve_session_ref(rows, ref)
        except SessionNotFoundError as error:
            return SlashCommandResult(name=command_name, message=str(error))
        except ValueError as error:
            return SlashCommandResult(name=command_name, message=str(error))

        if self.session_id is not None and resolved == self.session_id:
            return SlashCommandResult(
                name=command_name,
                message=f"Already on Session {resolved[:12]}.",
                session_id=resolved,
                yolo=self.yolo,
            )
        try:
            snapshot = self.resume_from_store(resolved)
        except Exception as error:
            return SlashCommandResult(
                name=command_name,
                message=(
                    f"Could not switch Session: "
                    f"{type(error).__name__}: "
                    f"{safe_error_message(error) if isinstance(error, Exception) else error}"
                ),
            )
        hist = len(snapshot.messages)
        return SlashCommandResult(
            name=command_name,
            message=(
                f"── Switched to Session {snapshot.id[:12]} ──\n"
                f"{hist} message(s), title={snapshot.title or '(none)'}.\n"
                "Chat cleared and history reloaded "
                "(Wiki Run graph / Staging publication were not resumed)."
            ),
            session_switched=True,
            session_id=snapshot.id,
            yolo=self.yolo,
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
            # /sessions <n|id> switches; bare /sessions lists.
            if arg:
                return self._switch_to_session_ref(arg, command_name="sessions")
            rows = self.store.list_sessions()
            return SlashCommandResult(
                name="sessions",
                message=format_session_list(rows, current_id=self.session_id),
            )

        if name == "new":
            snapshot = self.start_new_session(title=arg or None)
            return SlashCommandResult(
                name="new",
                message=(
                    f"── New Session {snapshot.id[:12]} ──\n"
                    f"[{self.yolo_indicator()}] Project run config unchanged.\n"
                    "Chat cleared — type a goal or /run."
                ),
                session_switched=True,
                session_id=snapshot.id,
                yolo=self.yolo,
            )

        if name in {"resume", "switch"}:
            if not arg:
                return SlashCommandResult(
                    name=name,
                    message=(
                        f"Usage: /{name} <n|id> — switch by /sessions list number or id "
                        "(history only). List with /sessions."
                    ),
                )
            return self._switch_to_session_ref(arg, command_name=name)

        if name in {"run", "start", "generate", "refresh"}:
            if self.mode == "ask":
                return SlashCommandResult(
                    name=name,
                    message=(
                        "Session is in ask mode — switch to /mode build before /run, "
                        "or type a goal only after /mode build."
                    ),
                )
            return SlashCommandResult(
                name=name,
                message="Starting Wiki Run from Session config…",
                start_run=True,
            )

        if name in {"help", "?"}:
            return SlashCommandResult(name="help", message=format_slash_help())

        return SlashCommandResult(
            name=name,
            message=f"Unknown command /{name}. Try /help.",
        )


__all__ = [
    "CollectAnswersFn",
    "InputFn",
    "OperatorSession",
    "SLASH_COMMANDS",
    "SessionMessage",
    "SlashCommandResult",
    "SlashCommandSpec",
    "WikiRunTurnResult",
    "apply_slash_completion",
    "format_run_error",
    "format_slash_help",
    "interactive_publication_handler",
    "list_slash_completions",
    "slash_command_names",
    "slash_suggestion_strings",
]
