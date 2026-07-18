"""Typed helpers for Wiki Run Record publication fragments.

Keeps Host publication status dicts consistent across approve / deny / await /
no-op paths without inventing a second persistence schema.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

PublicationStatusName = Literal[
    "published",
    "unchanged",
    "awaiting_publication",
    "publication_declined",
    "not_published",
]


def publication_status(
    status: PublicationStatusName,
    *,
    changed: bool,
    reviewer: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    """Build the secret-free publication block stored on a Wiki Run Record."""
    payload: dict[str, object] = {"status": status, "changed": changed}
    if reviewer is not None:
        payload["reviewer"] = dict(reviewer)
    return payload


def status_published(*, reviewer: Mapping[str, Any] | None = None) -> dict[str, object]:
    return publication_status("published", changed=True, reviewer=reviewer)


def status_unchanged() -> dict[str, object]:
    return publication_status("unchanged", changed=False)


def status_awaiting(*, reviewer: Mapping[str, Any] | None = None) -> dict[str, object]:
    return publication_status("awaiting_publication", changed=False, reviewer=reviewer)


def status_declined(*, reviewer: Mapping[str, Any] | None = None) -> dict[str, object]:
    return publication_status("publication_declined", changed=False, reviewer=reviewer)


def status_not_started() -> dict[str, object]:
    """Initial lifecycle value before any publication decision."""
    return publication_status("not_published", changed=False)


__all__ = [
    "PublicationStatusName",
    "publication_status",
    "status_awaiting",
    "status_declined",
    "status_not_started",
    "status_published",
    "status_unchanged",
]
