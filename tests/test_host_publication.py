"""Decision-matrix tests for host.publication.finalize (no full agent)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic_ai import ModelSettings

import okf_wiki.host.publication.finalize as finalize_mod
from okf_wiki.host.adaptive.reviewer import ReviewDefectsSummary
from okf_wiki.host.models import WikiManifest, WikiRunLimits
from okf_wiki.host.publication.finalize import PublicationOutcome, finalize
from okf_wiki.host.publication.gate import build_approve_results, build_deny_results
from okf_wiki.host.publication.status import (
    status_awaiting,
    status_declined,
    status_published,
    status_unchanged,
)


LIMITS = WikiRunLimits()


def _events() -> tuple[list[tuple[str, object | None]], Any]:
    seen: list[tuple[str, object | None]] = []

    def emit(event_type: str, payload: object | None = None, **_kwargs: object) -> None:
        seen.append((event_type, payload))

    return seen, emit


def _base_kwargs(tmp_path: Path, emit: Any, **overrides: Any) -> Any:
    """Build kwargs for ``finalize``; typed as Any so call-site spreads type-check."""
    kwargs: dict[str, Any] = {
        "publication_changed": True,
        "auto_approve": False,
        "handler": None,
        "emit": emit,
        "sources": {"source": tmp_path / "source"},
        "staging": tmp_path / "staging",
        "publication": tmp_path / "published",
        "manifest": WikiManifest(pages=["index.md"]),
        "repositories": (),
        "skill_digest": "a" * 64,
        "model_name": "test-model",
        "limits": LIMITS,
        "enable_reviewer": False,
    }
    kwargs.update(overrides)
    return kwargs


def test_unchanged_skips_gate_and_publish(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    # Patch via the module object: package re-exports `finalize` as the function.
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    outcome = asyncio.run(finalize(**_base_kwargs(tmp_path, emit, publication_changed=False)))

    assert outcome == PublicationOutcome(
        terminal_status="complete",
        publication_status=status_unchanged(),
        published=False,
        reviewer_defects=None,
        decision=None,
    )
    assert events == []
    publish.assert_not_called()


def test_yolo_approves_and_publishes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    outcome = asyncio.run(finalize(**_base_kwargs(tmp_path, emit, auto_approve=True)))

    assert outcome.published is True
    assert outcome.terminal_status == "complete"
    assert outcome.publication_status == status_published()
    assert outcome.decision == "approved"
    assert [event for event, _ in events] == ["publication_started", "publication_succeeded"]
    publish.assert_called_once()
    call_kwargs = publish.call_args.kwargs
    assert call_kwargs["model_name"] == "test-model"
    assert call_kwargs["skill_digest"] == "a" * 64


def test_awaiting_without_handler_or_yolo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    outcome = asyncio.run(finalize(**_base_kwargs(tmp_path, emit)))

    assert outcome.published is False
    assert outcome.terminal_status == "awaiting_publication"
    assert outcome.publication_status == status_awaiting()
    assert outcome.decision == "awaiting"
    assert events == []
    publish.assert_not_called()


def test_handler_deny_declines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    def handler(requests):
        return build_deny_results(requests)

    outcome = asyncio.run(finalize(**_base_kwargs(tmp_path, emit, handler=handler)))

    assert outcome.published is False
    assert outcome.terminal_status == "publication_declined"
    assert outcome.publication_status == status_declined()
    assert outcome.decision == "denied"
    assert events == []
    publish.assert_not_called()


def test_handler_approve_publishes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    def handler(requests):
        return build_approve_results(requests)

    outcome = asyncio.run(finalize(**_base_kwargs(tmp_path, emit, handler=handler)))

    assert outcome.published is True
    assert outcome.terminal_status == "complete"
    assert outcome.decision == "approved"
    assert [event for event, _ in events] == ["publication_started", "publication_succeeded"]
    publish.assert_called_once()


def test_approved_without_model_name_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)

    with pytest.raises(RuntimeError, match="did not identify its model"):
        asyncio.run(finalize(**_base_kwargs(tmp_path, emit, auto_approve=True, model_name="")))
    publish.assert_not_called()
    assert events == []  # do not emit publication_started before model_name is known


def test_precomputed_defects_skip_reviewer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)
    reviewer = AsyncMock()
    monkeypatch.setattr(finalize_mod, "run_host_wiki_reviewer", reviewer)

    defects = ReviewDefectsSummary(
        status="complete",
        summary="ok",
        findings=("cite me",),
        defect_count=1,
    )
    outcome = asyncio.run(
        finalize(
            **_base_kwargs(
                tmp_path,
                emit,
                auto_approve=True,
                enable_reviewer=True,
                reviewer_defects=defects,
            )
        )
    )

    reviewer.assert_not_called()
    assert outcome.reviewer_defects is defects
    assert outcome.publication_status == status_published(reviewer=defects.as_record_fragment())
    assert [event for event, _ in events] == ["publication_started", "publication_succeeded"]


def test_enable_reviewer_invokes_host_reviewer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)
    defects = ReviewDefectsSummary(status="partial", summary="needs work", defect_count=2)
    reviewer = AsyncMock(return_value=defects)
    monkeypatch.setattr(finalize_mod, "run_host_wiki_reviewer", reviewer)

    outcome = asyncio.run(
        finalize(
            **_base_kwargs(
                tmp_path,
                emit,
                auto_approve=True,
                enable_reviewer=True,
                review_model=object(),
                review_settings=ModelSettings(),
                source_mount=tmp_path / "source-mount",
                skill_mount=tmp_path / "skill-mount",
                workspace=object(),
                run_id="ab" * 16,
                policy=object(),
                root_deps=object(),
                metrics=object(),
            )
        )
    )

    reviewer.assert_awaited_once()
    assert outcome.reviewer_defects is defects
    assert outcome.publication_status["reviewer"] == defects.as_record_fragment()
    assert [event for event, _ in events] == ["publication_started", "publication_succeeded"]


def test_awaiting_attaches_reviewer_fragment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, emit = _events()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", MagicMock())
    defects = ReviewDefectsSummary(status="complete", summary="clean", defect_count=0)

    outcome = asyncio.run(
        finalize(
            **_base_kwargs(
                tmp_path,
                emit,
                enable_reviewer=True,
                reviewer_defects=defects,
            )
        )
    )

    assert outcome.terminal_status == "awaiting_publication"
    assert outcome.publication_status == status_awaiting(reviewer=defects.as_record_fragment())
    assert outcome.published is False


def test_yolo_takes_precedence_over_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, emit = _events()
    publish = MagicMock()
    monkeypatch.setattr(finalize_mod, "_publish_wiki", publish)
    called = False

    def handler(requests):
        nonlocal called
        called = True
        return build_deny_results(requests)

    outcome = asyncio.run(
        finalize(**_base_kwargs(tmp_path, emit, auto_approve=True, handler=handler))
    )

    assert called is False
    assert outcome.published is True
    assert outcome.decision == "approved"


def test_public_exports() -> None:
    from okf_wiki.host import PublicationOutcome as HostOutcome
    from okf_wiki.host import finalize as host_finalize
    from okf_wiki.host.publication import PublicationOutcome as PubOutcome
    from okf_wiki.host.publication.finalize import finalize as sub_finalize

    assert HostOutcome is PublicationOutcome
    assert PubOutcome is PublicationOutcome
    assert host_finalize is finalize
    assert sub_finalize is finalize
    # Package must not shadow the finalize submodule with the function.
    assert finalize_mod is not finalize
    assert hasattr(finalize_mod, "_publish_wiki")
