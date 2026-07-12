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
