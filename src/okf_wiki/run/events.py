"""Wiki Run event payload sanitization and model-error redaction.

Keeps audit-surface helpers out of :mod:`okf_wiki.run.records` so Wiki Run
Record I/O and Manual Retry stay focused on immutable terminal records.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping

from .security import _SECRET_SETTING_MARKERS, environment_secrets, redact_secrets

# Allow PascalCase exception type names (e.g. OSError) as bounded diagnostic labels.
_EVENT_ENUM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
_EVENT_SAFE_KEYS = {
    "attempt",
    "changed",
    "count",
    "depth",
    "duration_seconds",
    "dynamic_workflow",
    "reviewer",
    "fanout",
    "retries",
    "kind",
    "node_kind",
    "reason_code",
    "error_type",
    "status",
    "total",
    "wait_seconds",
    "active",
    "max_active",
    "concurrency",
    "critical_failures",
    "receipt_bytes",
    "requests",
    "tool_calls",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "provider_attempts",
    "provider_possible_duplicates",
    "fallback",
    "context_tokens",
    "warning_tokens",
    "before_tokens",
    "target_tokens",
    "defect_count",
}


def exception_chain(error: BaseException) -> Iterator[BaseException]:
    """Walk ``__cause__`` / ``__context__`` / exception groups without cycles."""
    seen: set[int] = set()
    pending: list[BaseException] = [error]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)


def model_secret_values(settings: Mapping[str, object]) -> tuple[str, ...]:
    """Collect secret-bearing strings from model settings and the environment."""
    values: set[str] = set()

    def collect(value: object, *, sensitive: bool) -> None:
        if isinstance(value, Mapping):
            for key, item in value.items():
                normalized = str(key).casefold().replace("-", "_")
                collect(
                    item,
                    sensitive=sensitive
                    or normalized in {"extra_body", "extra_headers"}
                    or any(marker in normalized for marker in _SECRET_SETTING_MARKERS),
                )
        elif isinstance(value, (list, tuple)):
            for item in value:
                collect(item, sensitive=sensitive)
        elif sensitive and isinstance(value, str) and value:
            values.add(value)

    collect(settings, sensitive=False)
    values.update(environment_secrets())
    return tuple(values)


def safe_model_error(error: Exception, settings: Mapping[str, object]) -> str | None:
    """Return a redacted provider error string when the chain may contain secrets."""
    secrets = model_secret_values(settings)
    if secrets and any(
        redact_secrets(str(item), secrets) != str(item) for item in exception_chain(error)
    ):
        return f"{type(error).__name__}: model provider diagnostics withheld"
    return None


def sanitize_event_payload(payload: Mapping[str, object]) -> dict[str, object]:
    """Keep public diagnostics to bounded counters and enum-like labels."""
    result: dict[str, object] = {}
    for raw_key, value in list(payload.items())[:32]:
        key = str(raw_key)[:64]
        if key not in _EVENT_SAFE_KEYS:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            result[key] = value
        elif isinstance(value, str) and _EVENT_ENUM_RE.fullmatch(value):
            result[key] = value
    return result


__all__ = [
    "exception_chain",
    "model_secret_values",
    "safe_model_error",
    "sanitize_event_payload",
]
