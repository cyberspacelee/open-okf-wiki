"""Credential preflight before expensive Wiki Run work."""

from __future__ import annotations

import os
from typing import Any

from ..errors import ConfigError
from ..provider_env import (
    ENV_OPENAI_API_KEY,
    openai_api_key,
    openai_base_url,
)

# Provider prefixes that resolve through OpenAI / OpenAI-compatible credentials.
_OPENAI_PROVIDER_NAMES = frozenset({"openai", "openai-chat", "openai-responses"})
_ANTHROPIC_PROVIDER_NAMES = frozenset({"anthropic", "claude"})
_GOOGLE_PROVIDER_NAMES = frozenset({"google", "google-gla", "google-vertex", "gemini"})


def _provider_name(model: str) -> str | None:
    identity = model.strip()
    if ":" not in identity:
        return None
    provider_name, model_name = identity.split(":", 1)
    if not provider_name or not model_name:
        return None
    return provider_name


def _env_set(name: str) -> bool:
    raw = os.environ.get(name)
    return bool(raw and raw.strip())


def preflight_provider_credentials(model: Any) -> None:
    """Fail fast when required provider credentials are clearly missing.

    - OpenAI-compatible (``openai:…``, ``openai-chat:…``, ``openai-responses:…``):
      require ``OPENAI_API_KEY`` unless ``OPENAI_BASE_URL`` is set (local gateways).
    - Anthropic (``anthropic:…`` / ``claude:…``): require ``ANTHROPIC_API_KEY``.
    - Google (``google:…`` / ``gemini:…`` / …): require ``GOOGLE_API_KEY`` or
      ``GEMINI_API_KEY``.

    Non-string models (in-process FunctionModel fixtures) are skipped.
    """
    if not isinstance(model, str):
        return
    provider = _provider_name(model)
    if provider is None:
        return
    if provider in _OPENAI_PROVIDER_NAMES:
        if openai_api_key():
            return
        if openai_base_url():
            return
        raise ConfigError(
            f"Missing {ENV_OPENAI_API_KEY} for model {model.strip()!r}. "
            f"Set {ENV_OPENAI_API_KEY} in the process environment or a .env file "
            "beside the Wiki Run config (copy .env.example). "
            "For local OpenAI-compatible servers that ignore auth, set OPENAI_BASE_URL instead."
        )
    if provider in _ANTHROPIC_PROVIDER_NAMES:
        if _env_set("ANTHROPIC_API_KEY"):
            return
        raise ConfigError(
            f"Missing ANTHROPIC_API_KEY for model {model.strip()!r}. "
            "Set ANTHROPIC_API_KEY in the process environment or a .env file "
            "beside the Wiki Run config."
        )
    if provider in _GOOGLE_PROVIDER_NAMES:
        if _env_set("GOOGLE_API_KEY") or _env_set("GEMINI_API_KEY"):
            return
        raise ConfigError(
            f"Missing GOOGLE_API_KEY or GEMINI_API_KEY for model {model.strip()!r}. "
            "Set one of those variables in the process environment or a .env file "
            "beside the Wiki Run config."
        )


__all__ = ["preflight_provider_credentials"]
