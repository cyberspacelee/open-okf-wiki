"""Line-oriented Python TUI for Wiki Run observation and operator actions."""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from rich.console import Console
from rich.text import Text

from .security import environment_secrets, redact_secrets
from .wiki_run import (
    Complete,
    NeedsInput,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
    WikiRunResult,
    load_run_record,
)


@dataclass(slots=True)
class TuiState:
    """Projection of Host events for a line-oriented status display."""

    run_id: str | None = None
    nodes: dict[str, str] = field(default_factory=dict)
    last_plan_total: int | None = None
    last_tool: str | None = None
    provider_wait: float | None = None
    receipts: int = 0
    compactions: int = 0
    terminal: str | None = None
    lines: list[str] = field(default_factory=list)

    def observe(self, event: WikiRunEvent) -> str:
        self.run_id = event.run_id
        payload = event.payload
        node = event.node_id
        if event.type in {
            "child_dispatched",
            "child_started",
            "child_finished",
            "child_rejected",
        }:
            status = str(payload.get("status") or event.type.removeprefix("child_"))
            self.nodes[node] = status
            line = f"node {node}: {status}"
        elif event.type == "plan_updated":
            total = payload.get("total")
            self.last_plan_total = int(total) if isinstance(total, (int, float)) else None
            line = f"plan updated total={self.last_plan_total}"
        elif event.type == "receipt_published":
            self.receipts += 1
            line = f"receipt published node={node} status={payload.get('status')}"
        elif event.type in {"compaction_warning", "compaction_completed"}:
            self.compactions += 1
            line = f"compaction {event.type.removeprefix('compaction_')}"
        elif event.type == "provider_retry_scheduled":
            wait = payload.get("wait_seconds")
            self.provider_wait = float(wait) if isinstance(wait, (int, float)) else None
            line = (
                f"provider retry attempt={payload.get('attempt')} "
                f"wait={self.provider_wait}s kind={payload.get('kind')}"
            )
        elif event.type == "provider_retry_exhausted":
            line = "provider retry exhausted"
        elif event.type in {
            "validation_started",
            "validation_succeeded",
            "publication_started",
            "publication_succeeded",
            "run_succeeded",
            "run_failed",
            "run_cancelled",
            "needs_input",
        }:
            self.terminal = event.type
            line = event.type.replace("_", " ")
        else:
            line = event.type.replace("_", " ")
        rendered = redact_secrets(line, environment_secrets())
        self.lines.append(rendered)
        return rendered


def require_tty(stream: TextIO = sys.stdin) -> None:
    if not hasattr(stream, "isatty") or not stream.isatty():
        raise RuntimeError(
            "okf-wiki tui requires an interactive TTY; use `okf-wiki wiki-run` for JSON automation"
        )


def render_event_line(console: Console, line: str) -> None:
    console.print(Text(line))


async def run_tui(
    request: WikiRunRequest,
    *,
    console: Console | None = None,
    input_fn: Callable[[str], str] | None = None,
    confirm_fn: Callable[[str], bool] | None = None,
    check_tty: bool = True,
) -> WikiRunResult:
    """Run one Wiki Run through the application seam with a line-oriented observer."""
    if check_tty:
        require_tty()
    out = console or Console(stderr=False)
    state = TuiState()
    secrets = environment_secrets()

    def observer(event: WikiRunEvent) -> None:
        line = state.observe(event)
        render_event_line(out, line)

    application = WikiRunApplication(observer=observer)
    task = asyncio.create_task(application.run(request))
    try:
        result = await task
    except asyncio.CancelledError:
        out.print(Text("run cancelled"))
        raise
    except KeyboardInterrupt:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        out.print(Text("run cancelled"))
        raise

    if isinstance(result, Complete):
        out.print(Text(f"complete pages={len(result.manifest.pages)}"))
        return result
    if isinstance(result, NeedsInput):
        out.print(Text("needs input"))
        answers: dict[str, str] = {}
        ask = input_fn or (lambda prompt: input(prompt))
        for index, question in enumerate(result.questions, start=1):
            safe_question = redact_secrets(question, secrets)
            answer = ask(f"Q{index}: {safe_question}\n> ")
            answers[f"{state.run_id or 'run'}:{index}"] = answer.strip()
        out.print(
            Text(
                f"recorded {len(answers)} answers; start a fresh Wiki Run with "
                "WikiRunRequest(explicit_answers=...)"
            )
        )
        return result
    return result


def offer_manual_retry(
    *,
    publication: Path,
    staging: Path,
    console: Console | None = None,
    confirm_fn: Callable[[str], bool] | None = None,
    model: str | None = None,
) -> WikiRunRequest | None:
    """Offer Manual Retry from the newest failed/cancelled record near publication."""
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


def project_events(events: list[WikiRunEvent]) -> list[str]:
    """Deterministic projection used by tests (no terminal required)."""
    state = TuiState()
    return [state.observe(event) for event in events]


def summarize_nodes(events: list[WikiRunEvent]) -> Mapping[str, str]:
    state = TuiState()
    for event in events:
        state.observe(event)
    return dict(state.nodes)
