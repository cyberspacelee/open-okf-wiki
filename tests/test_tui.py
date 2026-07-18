from datetime import UTC, datetime

import pytest

from okf_wiki.tui import project_events, require_tty, summarize_nodes
from okf_wiki.wiki_run import WikiRunEvent


def _event(
    sequence: int,
    event_type: str,
    *,
    node_id: str = "root",
    payload: dict[str, object] | None = None,
) -> WikiRunEvent:
    return WikiRunEvent(
        run_id="a" * 32,
        sequence=sequence,
        timestamp=datetime.now(UTC),
        type=event_type,
        node_id=node_id,
        payload=payload or {},
    )


def test_tui_projects_plan_nodes_receipts_and_retries() -> None:
    lines = project_events(
        [
            _event(1, "run_created"),
            _event(2, "plan_updated", payload={"total": 3, "depth": 0, "node_kind": "root"}),
            _event(
                3, "child_started", node_id="domain-1", payload={"status": "running", "depth": 1}
            ),
            _event(
                4,
                "receipt_published",
                node_id="domain-1",
                payload={"status": "complete", "receipt_bytes": 120},
            ),
            _event(
                5,
                "provider_retry_scheduled",
                payload={
                    "attempt": 2,
                    "wait_seconds": 1.5,
                    "kind": "http_429",
                    "status": "scheduled",
                },
            ),
            _event(6, "compaction_completed", payload={"before_tokens": 10, "target_tokens": 5}),
            _event(7, "publication_succeeded"),
            _event(8, "run_succeeded"),
        ]
    )
    assert any("plan updated" in line for line in lines)
    assert any("node domain-1" in line for line in lines)
    assert any("receipt published" in line for line in lines)
    assert any("provider retry" in line for line in lines)
    assert any("compaction" in line for line in lines)
    assert lines[-1] == "run succeeded"
    nodes = summarize_nodes(
        [
            _event(1, "child_started", node_id="domain-1", payload={"status": "running"}),
            _event(2, "child_finished", node_id="domain-1", payload={"status": "complete"}),
        ]
    )
    assert nodes["domain-1"] == "complete"


def test_tui_projects_run_failed_error_type() -> None:
    lines = project_events(
        [
            _event(1, "run_created"),
            _event(2, "run_failed", payload={"error_type": "HostValidationError"}),
        ]
    )
    assert lines[-1] == "run failed error_type=HostValidationError"


def test_tui_redacts_secret_like_fragments_from_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-value")
    lines = project_events(
        [
            _event(
                1,
                "provider_retry_scheduled",
                payload={"attempt": 1, "wait_seconds": 1, "kind": "network", "status": "scheduled"},
            )
        ]
    )
    joined = "\n".join(lines)
    assert "sk-secret-value" not in joined


def test_non_tty_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    class Fake:
        def isatty(self) -> bool:
            return False

    with pytest.raises(RuntimeError, match="interactive TTY"):
        require_tty(Fake())
