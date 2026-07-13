import os
import re
import tempfile
from pathlib import Path
from typing import Literal, TypeAlias


PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
GatewayErrorCategory: TypeAlias = Literal[
    "authentication",
    "capability",
    "configuration",
    "connection",
    "gateway",
    "not_found",
    "rate_limit",
    "redirect",
    "request",
    "stale",
    "timeout",
]


class GatewayError(ValueError):
    def __init__(
        self,
        message: str,
        *,
        category: GatewayErrorCategory = "configuration",
        model_specific: bool = False,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.model_specific = model_specific


def actionable_model_error(error: Exception) -> str | None:
    name = type(error).__name__
    if name == "UsageLimitExceeded":
        return "Agent budget exhausted; increase the per-agent-call limit or narrow the work"
    if name == "TimeoutError":
        return "Gateway request timed out; retry or increase the configured time limit"
    if name == "ModelHTTPError":
        status = getattr(error, "status_code", None)
        if status in {401, 403}:
            return "Gateway authentication failed; update the Gateway Profile credential"
        if status == 429:
            return "Gateway rate limit was reached; retry later or reduce concurrency"
        if isinstance(status, int) and status >= 500:
            return "Gateway is unavailable; retry after the service recovers"
        return f"Gateway request failed with HTTP status {status or 'unknown'}"
    if name == "ModelAPIError":
        return "Gateway connection failed; check the profile endpoint and network"
    if name == "UnexpectedModelBehavior":
        return "Gateway returned invalid structured output; verify model capabilities"
    return None


def atomic_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
