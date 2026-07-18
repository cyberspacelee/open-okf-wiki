"""Doctor-style credential presence reports (no raw secrets)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from ..provider_env import (
    ENV_OPENAI_API_KEY,
    ENV_OPENAI_BASE_URL,
    ENV_OPENAI_ORG_ID,
    ENV_OPENAI_PROJECT_ID,
)

# Credential-related env keys operators need for common provider families.
CREDENTIAL_ENV_KEYS: tuple[str, ...] = (
    ENV_OPENAI_API_KEY,
    ENV_OPENAI_BASE_URL,
    ENV_OPENAI_ORG_ID,
    ENV_OPENAI_PROJECT_ID,
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
)


@dataclass(frozen=True, slots=True)
class CredentialStatus:
    """Presence of one credential-related environment key (never raw value)."""

    name: str
    status: str  # "set" | "unset"
    length: int | None = None
    source: str | None = None  # "process" | "dotenv" | None when unset

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "name": self.name,
            "status": self.status,
        }
        if self.status == "set":
            payload["length"] = self.length
            payload["source"] = self.source
            payload["preview"] = f"[set length={self.length} source={self.source}]"
        else:
            payload["preview"] = "[unset]"
        return payload


def _dotenv_defined_keys(dotenv_path: Path | None) -> set[str]:
    if dotenv_path is None or not dotenv_path.is_file():
        return set()
    values = dotenv_values(dotenv_path)
    return {
        name for name, value in values.items() if name and value is not None and str(value).strip()
    }


def collect_credential_report(
    *,
    dotenv_path: Path | None = None,
    process_keys: frozenset[str] | None = None,
    keys: tuple[str, ...] = CREDENTIAL_ENV_KEYS,
) -> list[CredentialStatus]:
    """Report credential env keys as set/unset with redacted length/source only.

    ``process_keys`` lists names already present in the process environment before
    dotenv load (so source can distinguish process vs dotenv). When omitted, any
    set key is attributed to ``process``.
    """
    dotenv_keys = _dotenv_defined_keys(dotenv_path)
    known_process = (
        process_keys
        if process_keys is not None
        else frozenset(name for name in keys if os.environ.get(name, "").strip())
    )
    report: list[CredentialStatus] = []
    for name in keys:
        raw = os.environ.get(name)
        text = raw.strip() if raw is not None else ""
        if not text:
            report.append(CredentialStatus(name=name, status="unset"))
            continue
        if name in known_process:
            source = "process"
        elif name in dotenv_keys:
            source = "dotenv"
        else:
            source = "process"
        report.append(
            CredentialStatus(
                name=name,
                status="set",
                length=len(text),
                source=source,
            )
        )
    return report


def format_credential_report(statuses: list[CredentialStatus]) -> str:
    """Human-readable multi-line summary (no secret values)."""
    lines: list[str] = []
    for item in statuses:
        if item.status == "set":
            lines.append(f"{item.name}: set (length={item.length}, source={item.source})")
        else:
            lines.append(f"{item.name}: unset")
    return "\n".join(lines)


__all__ = [
    "CREDENTIAL_ENV_KEYS",
    "CredentialStatus",
    "collect_credential_report",
    "format_credential_report",
]
