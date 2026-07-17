"""Operator-facing error formatting for config, records, and host validation.

Keeps field-level detail without re-emitting raw rejected input payloads (which may be
large or secret-bearing). Provider transport failures still go through
``safe_error_message`` redaction separately.
"""

from __future__ import annotations

import re

from pydantic import ValidationError

_MAX_DETAIL_CHARS = 300
_MAX_VALIDATION_ISSUES = 20


def format_validation_error(
    error: ValidationError,
    *,
    prefix: str,
) -> str:
    """Turn a Pydantic ValidationError into a multi-line operator message."""
    lines = [f"{prefix}:"]
    details = error.errors(include_url=False)
    for item in details[:_MAX_VALIDATION_ISSUES]:
        loc_parts = item.get("loc") or ()
        path = ".".join(str(part) for part in loc_parts) if loc_parts else "<root>"
        message = str(item.get("msg") or "invalid value").strip() or "invalid value"
        lines.append(f"- {path}: {message}")
    remaining = len(details) - _MAX_VALIDATION_ISSUES
    if remaining > 0:
        lines.append(f"- … and {remaining} more error(s)")
    return "\n".join(lines)


def format_cause_detail(error: BaseException, *, max_chars: int = _MAX_DETAIL_CHARS) -> str:
    """Single-line detail from an underlying exception, length-capped."""
    detail = str(error).strip()
    detail = re.sub(r"\s+", " ", detail)
    if len(detail) > max_chars:
        detail = detail[: max_chars - 3] + "..."
    return detail


def operator_error(
    prefix: str,
    error: BaseException | None = None,
    *,
    detail: str | None = None,
) -> ValueError:
    """Build a ValueError that preserves operator detail without dumping payloads.

    - ``ValidationError`` → multi-line field list under ``prefix``
    - other causes / explicit ``detail`` → ``prefix: detail``
    - bare prefix when nothing useful is available
    """
    if isinstance(error, ValidationError):
        return ValueError(format_validation_error(error, prefix=prefix))
    text = (detail if detail is not None else format_cause_detail(error) if error else "").strip()
    if text:
        # Avoid "prefix: prefix: ..." when the cause already starts with the same prefix.
        if text == prefix or text.startswith(f"{prefix}:"):
            return ValueError(text)
        return ValueError(f"{prefix}: {text}")
    return ValueError(prefix)


def reraise_as_operator_error(prefix: str, error: BaseException) -> None:
    """Raise ``operator_error`` for ``error`` (never returns)."""
    raise operator_error(prefix, error) from error


def is_operator_safe_exception(error: BaseException) -> bool:
    """Exceptions whose messages are safe to surface after secret redaction."""
    if isinstance(
        error,
        (
            ValueError,
            OSError,
            TypeError,
            KeyError,
            TimeoutError,
            ArithmeticError,
            LookupError,
            AssertionError,
        ),
    ):
        return True
    # Avoid hard dependency at import for non-pydantic call sites.
    return type(error).__name__ == "ValidationError" or isinstance(error, ValidationError)


__all__ = [
    "format_cause_detail",
    "format_validation_error",
    "is_operator_safe_exception",
    "operator_error",
    "reraise_as_operator_error",
]
