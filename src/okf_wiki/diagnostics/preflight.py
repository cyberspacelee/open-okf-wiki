"""Credential preflight before expensive Wiki Run work."""

from __future__ import annotations

from typing import Any

from ..errors import ConfigError
from ..provider_env import (
    ENV_OPENAI_API_KEY,
    openai_api_key,
    openai_base_url,
)

# Provider prefixes that resolve through OpenAI / OpenAI-compatible credentials.
_OPENAI_PROVIDER_NAMES = frozenset({"openai", "openai-chat", "openai-responses"})


def _openai_provider_name(model: str) -> str | None:
    identity = model.strip()
    if ":" not in identity:
        return None
    provider_name, model_name = identity.split(":", 1)
    if not provider_name or not model_name:
        return None
    if provider_name not in _OPENAI_PROVIDER_NAMES:
        return None
    return provider_name


def preflight_provider_credentials(model: Any) -> None:
    """Fail fast when required provider credentials are clearly missing.

    For OpenAI-compatible model identities (``openai:…``, ``openai-chat:…``,
    ``openai-responses:…``), require ``OPENAI_API_KEY`` unless a local/gateway
    ``OPENAI_BASE_URL`` is set (servers that ignore auth may omit the key).

    Non-string models (in-process FunctionModel fixtures) and non-OpenAI
    identities are skipped.
    """
    if not isinstance(model, str):
        return
    if _openai_provider_name(model) is None:
        return
    if openai_api_key():
        return
    # Special local / gateway case: base URL set without a key (placeholder auth).
    if openai_base_url():
        return
    raise ConfigError(
        f"Missing {ENV_OPENAI_API_KEY} for model {model.strip()!r}. "
        f"Set {ENV_OPENAI_API_KEY} in the process environment or a .env file "
        "beside the Wiki Run config (copy .env.example). "
        "For local OpenAI-compatible servers that ignore auth, set OPENAI_BASE_URL instead."
    )


__all__ = ["preflight_provider_credentials"]
