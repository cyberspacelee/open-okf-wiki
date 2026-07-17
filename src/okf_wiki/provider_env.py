"""Environment and non-secret model/provider defaults for Wiki Runs.

Secrets (API keys, tokens) stay in process environment or ``.env`` only — never YAML.
OpenAI-compatible endpoints use the standard OpenAI client variables plus optional product
defaults for model identity and token budgets.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from pydantic_ai import ModelSettings

# Default model identity when neither CLI nor YAML provides one.
DEFAULT_MODEL_IDENTITY = "openai:gpt-5-mini"

# OpenAI / OpenAI-compatible (also read by the OpenAI Python client).
ENV_OPENAI_API_KEY = "OPENAI_API_KEY"
ENV_OPENAI_BASE_URL = "OPENAI_BASE_URL"
ENV_OPENAI_ORG_ID = "OPENAI_ORG_ID"
ENV_OPENAI_PROJECT_ID = "OPENAI_PROJECT_ID"

# Product-level operator defaults (non-secret).
ENV_MODEL = "OKF_WIKI_MODEL"
ENV_MAX_TOKENS = "OKF_WIKI_MAX_TOKENS"
ENV_CONTEXT_TARGET_TOKENS = "OKF_WIKI_CONTEXT_TARGET_TOKENS"
ENV_INPUT_TOKENS_LIMIT = "OKF_WIKI_INPUT_TOKENS_LIMIT"
ENV_OUTPUT_TOKENS_LIMIT = "OKF_WIKI_OUTPUT_TOKENS_LIMIT"
ENV_TOTAL_TOKENS_LIMIT = "OKF_WIKI_TOTAL_TOKENS_LIMIT"
ENV_REQUEST_TIMEOUT_SECONDS = "OKF_WIKI_REQUEST_TIMEOUT_SECONDS"
ENV_TEMPERATURE = "OKF_WIKI_TEMPERATURE"

_LIMIT_ENV: tuple[tuple[str, str, type], ...] = (
    ("context_target_tokens", ENV_CONTEXT_TARGET_TOKENS, int),
    ("input_tokens_limit", ENV_INPUT_TOKENS_LIMIT, int),
    ("output_tokens_limit", ENV_OUTPUT_TOKENS_LIMIT, int),
    ("total_tokens_limit", ENV_TOTAL_TOKENS_LIMIT, int),
    ("request_timeout_seconds", ENV_REQUEST_TIMEOUT_SECONDS, float),
)


def _env_text(name: str) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    text = raw.strip()
    return text or None


def _env_number(name: str, cast: type) -> int | float | None:
    text = _env_text(name)
    if text is None:
        return None
    try:
        value = cast(text)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Environment variable {name} must be a valid {cast.__name__}") from error
    if isinstance(value, float) and (value != value or value in {float("inf"), float("-inf")}):
        raise ValueError(f"Environment variable {name} must be a finite number")
    return value


def openai_api_key() -> str | None:
    """API key for OpenAI and OpenAI-compatible providers."""
    return _env_text(ENV_OPENAI_API_KEY)


def openai_base_url() -> str | None:
    """Base URL for OpenAI and OpenAI-compatible Chat Completions APIs (…/v1)."""
    return _env_text(ENV_OPENAI_BASE_URL)


def openai_organization() -> str | None:
    return _env_text(ENV_OPENAI_ORG_ID)


def openai_project() -> str | None:
    return _env_text(ENV_OPENAI_PROJECT_ID)


def resolve_model_identity(configured: str | None = None) -> str:
    """CLI/YAML identity wins; otherwise ``OKF_WIKI_MODEL``; else product default."""
    if configured is not None:
        text = configured.strip()
        if text:
            return text
    env_model = _env_text(ENV_MODEL)
    if env_model is not None:
        return env_model
    return DEFAULT_MODEL_IDENTITY


def resolve_model_settings(
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    timeout: float | int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> ModelSettings:
    """Build ModelSettings from explicit non-secret values and optional env defaults.

    Precedence for each field: explicit argument → matching env var → omit (provider default).
    """
    settings: dict[str, Any] = dict(extra or {})

    if max_tokens is None:
        raw = _env_number(ENV_MAX_TOKENS, int)
        max_tokens = int(raw) if raw is not None else None
    if max_tokens is not None:
        if max_tokens < 1:
            raise ValueError(f"{ENV_MAX_TOKENS} / max_tokens must be positive")
        settings["max_tokens"] = max_tokens

    if temperature is None:
        raw = _env_number(ENV_TEMPERATURE, float)
        temperature = float(raw) if raw is not None else None
    if temperature is not None:
        if not 0.0 <= temperature <= 2.0:
            raise ValueError("temperature must be between 0 and 2")
        settings["temperature"] = temperature

    if top_p is not None:
        if not 0.0 < top_p <= 1.0:
            raise ValueError("top_p must be in (0, 1]")
        settings["top_p"] = top_p

    if timeout is None:
        raw = _env_number(ENV_REQUEST_TIMEOUT_SECONDS, float)
        timeout = float(raw) if raw is not None else None
    if timeout is not None:
        if not (timeout > 0):
            raise ValueError("timeout must be positive")
        settings["timeout"] = timeout

    return ModelSettings(**settings)


def env_limit_overrides() -> dict[str, int | float]:
    """Non-secret WikiRunLimits fields sourced from environment variables."""
    overrides: dict[str, int | float] = {}
    for field_name, env_name, cast in _LIMIT_ENV:
        value = _env_number(env_name, cast)
        if value is None:
            continue
        if cast is int:
            overrides[field_name] = int(value)
        else:
            overrides[field_name] = float(value)
    return overrides


def merge_limit_overrides(
    *layers: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Merge override layers left-to-right (later wins). Omits ``None`` values."""
    merged: dict[str, Any] = {}
    for layer in layers:
        if not layer:
            continue
        for key, value in layer.items():
            if value is not None:
                merged[key] = value
    return merged


__all__ = [
    "DEFAULT_MODEL_IDENTITY",
    "ENV_CONTEXT_TARGET_TOKENS",
    "ENV_INPUT_TOKENS_LIMIT",
    "ENV_MAX_TOKENS",
    "ENV_MODEL",
    "ENV_OPENAI_API_KEY",
    "ENV_OPENAI_BASE_URL",
    "ENV_OPENAI_ORG_ID",
    "ENV_OPENAI_PROJECT_ID",
    "ENV_OUTPUT_TOKENS_LIMIT",
    "ENV_REQUEST_TIMEOUT_SECONDS",
    "ENV_TEMPERATURE",
    "ENV_TOTAL_TOKENS_LIMIT",
    "env_limit_overrides",
    "merge_limit_overrides",
    "openai_api_key",
    "openai_base_url",
    "openai_organization",
    "openai_project",
    "resolve_model_identity",
    "resolve_model_settings",
]
