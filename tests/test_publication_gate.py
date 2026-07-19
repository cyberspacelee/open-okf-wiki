"""Unit tests for run publication deferred-approval gate."""

from __future__ import annotations

import asyncio

from pydantic_ai.tools import DeferredToolResults, ToolDenied

from okf_wiki.run.publication.gate import (
    DEFAULT_DENY_MESSAGE,
    PUBLISH_TOOL_NAME,
    build_approve_results,
    build_deny_results,
    build_publish_approval_request,
    decision_from_results,
    resolve_publication_approval,
)


def test_build_publish_approval_request_uses_deferred_tool_shape() -> None:
    requests = build_publish_approval_request(tool_call_id="publish_test")
    assert len(requests.approvals) == 1
    assert requests.approvals[0].tool_name == PUBLISH_TOOL_NAME
    assert requests.approvals[0].tool_call_id == "publish_test"
    assert requests.approvals[0].args == {}
    assert requests.calls == []


def test_publish_approval_request_attaches_bounded_defects() -> None:
    defects = {
        "status": "complete",
        "summary": "two issues",
        "findings": ["missing citation on auth.md"],
        "open_questions": [],
        "defect_count": 1,
    }
    requests = build_publish_approval_request(tool_call_id="publish_defects", defects=defects)
    assert requests.approvals[0].args == {"defects": defects}


def test_resolve_publication_approval_forwards_defects_to_handler() -> None:
    seen: list[object] = []

    def handler(requests):
        seen.append(requests.approvals[0].args)
        return build_approve_results(requests)

    defects = {"status": "complete", "defect_count": 0, "summary": "ok", "findings": []}
    decision, _requests, _results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler, defects=defects)
    )
    assert decision == "approved"
    assert seen == [{"defects": defects}]


def test_auto_approve_maps_to_approve_all() -> None:
    decision, requests, results = asyncio.run(
        resolve_publication_approval(auto_approve=True, handler=None)
    )
    assert decision == "approved"
    assert results is not None
    assert set(results.approvals) == {call.tool_call_id for call in requests.approvals}


def test_without_handler_or_yolo_awaits() -> None:
    decision, _requests, results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=None)
    )
    assert decision == "awaiting"
    assert results is None


def test_handler_can_approve() -> None:
    def handler(requests):
        return build_approve_results(requests)

    decision, _requests, _results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler)
    )
    assert decision == "approved"


def test_handler_can_deny_with_tool_denied() -> None:
    def handler(requests):
        return build_deny_results(requests)

    decision, _requests, results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler)
    )
    assert decision == "denied"
    assert results is not None
    denial = next(iter(results.approvals.values()))
    assert isinstance(denial, ToolDenied)
    assert denial.message == DEFAULT_DENY_MESSAGE


def test_handler_can_deny_with_false() -> None:
    def handler(requests):
        return build_deny_results(requests, as_bool=True)

    decision, _requests, results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler)
    )
    assert decision == "denied"
    assert results is not None
    assert all(value is False for value in results.approvals.values())


def test_handler_can_deny_via_raw_deferred_results() -> None:
    def handler(requests):
        call_id = requests.approvals[0].tool_call_id
        return DeferredToolResults(approvals={call_id: ToolDenied(message="nope")})

    decision, _requests, _results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler)
    )
    assert decision == "denied"


def test_yolo_takes_precedence_over_handler() -> None:
    called = False

    def handler(requests):
        nonlocal called
        called = True
        return None

    decision, _requests, _results = asyncio.run(
        resolve_publication_approval(auto_approve=True, handler=handler)
    )
    assert decision == "approved"
    assert called is False


def test_decision_from_results_partial_approval_is_awaiting() -> None:
    requests = build_publish_approval_request(tool_call_id="a")
    # Empty results → still awaiting
    assert decision_from_results(requests, DeferredToolResults()) == "awaiting"


def test_decision_from_results_false_is_denied() -> None:
    requests = build_publish_approval_request(tool_call_id="a")
    results = requests.build_results(approvals={"a": False})
    assert decision_from_results(requests, results) == "denied"


def test_async_handler_can_deny() -> None:
    async def handler(requests):
        return build_deny_results(requests, message="later")

    decision, _requests, results = asyncio.run(
        resolve_publication_approval(auto_approve=False, handler=handler)
    )
    assert decision == "denied"
    assert results is not None
    denial = next(iter(results.approvals.values()))
    assert isinstance(denial, ToolDenied)
    assert denial.message == "later"
