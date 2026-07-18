"""TTY checks for interactive Operator Session entry."""

from __future__ import annotations

import sys
from typing import Protocol


class SupportsIsatty(Protocol):
    def isatty(self) -> bool: ...


def require_tty(stream: SupportsIsatty = sys.stdin) -> None:
    """Reject non-interactive streams; automation should use ``okf-wiki wiki-run``."""
    if not hasattr(stream, "isatty") or not stream.isatty():
        raise RuntimeError(
            "okf-wiki tui requires an interactive TTY; use `okf-wiki wiki-run` for JSON automation"
        )


__all__ = ["SupportsIsatty", "require_tty"]
