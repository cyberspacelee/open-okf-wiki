"""Host publication approval gate (Pydantic AI deferred-tool shapes).

After Host validation of the Staging Wiki, publication is not a silent side
effect of structured ``Complete``. The Host models the publish decision as a
deferred tool approval for ``publish_wiki`` (ADR 0018 / pydantic-ai
``DeferredToolRequests`` / ``requires_approval`` / ``approve_all``).

YOLO / ``auto_approve_publication`` maps to ``build_results(approve_all=True)``
and must never skip validation, mounts, or publication locks — those remain
outside this gate and run before approval is considered.

Handlers (Operator Session / tests) return ``DeferredToolResults`` that either
approve or deny the pending ``publish_wiki`` call. Deny leaves Staging intact
and does not change the Published Wiki; the Wiki Run Record status becomes
``publication_declined``.
"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal

from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import (
    DeferredToolRequests,
    DeferredToolResults,
    ToolApproved,
    ToolDenied,
)

PUBLISH_TOOL_NAME = "publish_wiki"

# Default operator-facing deny message when the Host builds ToolDenied results.
DEFAULT_DENY_MESSAGE = "Publication declined by operator."

PublicationDecision = Literal["approved", "awaiting", "denied"]

PublicationApprovalHandler = Callable[
    [DeferredToolRequests],
    DeferredToolResults | None | Awaitable[DeferredToolResults | None],
]


def build_publish_approval_request(
    *,
    tool_call_id: str | None = None,
    defects: Mapping[str, object] | None = None,
) -> DeferredToolRequests:
    """Build a Host-owned deferred approval request for atomic publication.

    Optional ``defects`` is a bounded Wiki Reviewer summary attached for the
    operator approval UI (status, findings, defect_count). It does not change
    approve/deny mechanics.
    """
    call_id = tool_call_id or f"publish_{uuid.uuid4().hex}"
    args: dict[str, object] = {}
    if defects is not None:
        args["defects"] = dict(defects)
    return DeferredToolRequests(
        approvals=[
            ToolCallPart(
                tool_name=PUBLISH_TOOL_NAME,
                args=args,
                tool_call_id=call_id,
            )
        ]
    )


def build_approve_results(requests: DeferredToolRequests) -> DeferredToolResults:
    """Approve every pending publication approval (Session / test helper)."""
    return requests.build_results(approve_all=True)


def build_deny_results(
    requests: DeferredToolRequests,
    *,
    message: str = DEFAULT_DENY_MESSAGE,
    as_bool: bool = False,
) -> DeferredToolResults:
    """Deny every pending publication approval (Session / test helper).

    By default each pending approval is a ``ToolDenied``. Pass ``as_bool=True``
    to emit bare ``False`` values (also accepted by pydantic-ai / this gate).
    """
    denial: bool | ToolDenied = False if as_bool else ToolDenied(message=message)
    return requests.build_results(
        approvals={call.tool_call_id: denial for call in requests.approvals}
    )


def decision_from_results(
    requests: DeferredToolRequests,
    results: DeferredToolResults | None,
) -> PublicationDecision:
    """Map deferred tool results to a Host publication decision."""
    if results is None:
        return "awaiting"
    remaining = requests.remaining(results)
    if remaining is not None and remaining.approvals:
        return "awaiting"
    for call in requests.approvals:
        approval = results.approvals.get(call.tool_call_id)
        if approval is False or isinstance(approval, ToolDenied):
            return "denied"
        if approval is True or isinstance(approval, ToolApproved):
            return "approved"
    return "awaiting"


async def resolve_publication_approval(
    *,
    auto_approve: bool,
    handler: PublicationApprovalHandler | None = None,
    defects: Mapping[str, object] | None = None,
) -> tuple[PublicationDecision, DeferredToolRequests, DeferredToolResults | None]:
    """Resolve HITL publication approval using deferred-tool result shapes.

    Precedence:
    1. ``auto_approve`` (YOLO / ``--yes``) → ``approve_all``
    2. optional in-process ``handler`` (Operator Session / tests)
    3. otherwise ``awaiting`` (non-interactive without explicit yes)

    A handler may approve (``build_approve_results`` / ``approve_all``) or deny
    (``build_deny_results`` / ``ToolDenied`` / ``False``). Returning ``None``
    (or results that leave approvals unresolved) keeps the run awaiting.

    ``defects`` is optional bounded Reviewer context for the approval UI only.
    """
    requests = build_publish_approval_request(defects=defects)
    results: DeferredToolResults | None = None
    if auto_approve:
        results = build_approve_results(requests)
    elif handler is not None:
        maybe = handler(requests)
        if inspect.isawaitable(maybe):
            resolved = await maybe
            results = resolved if isinstance(resolved, DeferredToolResults) else None
        elif isinstance(maybe, DeferredToolResults):
            results = maybe
        else:
            results = None
    return decision_from_results(requests, results), requests, results


__all__ = [
    "DEFAULT_DENY_MESSAGE",
    "PUBLISH_TOOL_NAME",
    "PublicationApprovalHandler",
    "PublicationDecision",
    "build_approve_results",
    "build_deny_results",
    "build_publish_approval_request",
    "decision_from_results",
    "resolve_publication_approval",
]
