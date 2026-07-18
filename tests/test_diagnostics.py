"""Diagnostics seam: preflight credentials and doctor reports."""

from __future__ import annotations

from pathlib import Path

import pytest

from okf_wiki.diagnostics import (
    ConfigError,
    collect_credential_report,
    format_credential_report,
    preflight_provider_credentials,
    safe_error_message,
)
from okf_wiki.diagnostics.doctor import CREDENTIAL_ENV_KEYS
from okf_wiki.provider_env import ENV_OPENAI_API_KEY, ENV_OPENAI_BASE_URL
from okf_wiki.security import PROVIDER_DIAGNOSTICS_WITHHELD, REDACTION


def test_preflight_passes_when_openai_key_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_OPENAI_API_KEY, "sk-test-key")
    monkeypatch.delenv(ENV_OPENAI_BASE_URL, raising=False)
    preflight_provider_credentials("openai:gpt-5-mini")


def test_preflight_passes_for_unknown_and_non_string_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(ENV_OPENAI_API_KEY, raising=False)
    monkeypatch.delenv(ENV_OPENAI_BASE_URL, raising=False)
    preflight_provider_credentials("test")
    preflight_provider_credentials(object())  # FunctionModel-style fixture


def test_preflight_allows_missing_key_when_base_url_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(ENV_OPENAI_API_KEY, raising=False)
    monkeypatch.setenv(ENV_OPENAI_BASE_URL, "http://127.0.0.1:8000/v1")
    preflight_provider_credentials("openai:local-model")


def test_preflight_fails_fast_for_missing_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(ENV_OPENAI_API_KEY, raising=False)
    monkeypatch.delenv(ENV_OPENAI_BASE_URL, raising=False)
    with pytest.raises(ConfigError) as raised:
        preflight_provider_credentials("openai:gpt-5-mini")
    message = str(raised.value)
    assert ENV_OPENAI_API_KEY in message
    assert ".env" in message
    assert "openai:gpt-5-mini" in message
    # ConfigError remains operator-safe after redaction path.
    assert safe_error_message(raised.value) == message
    assert safe_error_message(raised.value) != PROVIDER_DIAGNOSTICS_WITHHELD


@pytest.mark.parametrize(
    "identity",
    ["openai-chat:gpt-4o", "openai-responses:gpt-4o"],
)
def test_preflight_covers_openai_compatible_prefixes(
    monkeypatch: pytest.MonkeyPatch,
    identity: str,
) -> None:
    monkeypatch.delenv(ENV_OPENAI_API_KEY, raising=False)
    monkeypatch.delenv(ENV_OPENAI_BASE_URL, raising=False)
    with pytest.raises(ConfigError):
        preflight_provider_credentials(identity)


def test_doctor_report_set_unset_redacted_preview(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "doctor-secret-value-never-print"
    monkeypatch.setenv(ENV_OPENAI_API_KEY, secret)
    monkeypatch.delenv(ENV_OPENAI_BASE_URL, raising=False)
    monkeypatch.delenv("OPENAI_ORG_ID", raising=False)
    monkeypatch.delenv("OPENAI_PROJECT_ID", raising=False)

    dotenv = tmp_path / ".env"
    dotenv.write_text(
        f"{ENV_OPENAI_API_KEY}={secret}\n{ENV_OPENAI_BASE_URL}=https://gateway.example/v1\n",
        encoding="utf-8",
    )
    # BASE_URL only in dotenv; simulate load by setting it after snapshotting process keys.
    process_keys = frozenset({ENV_OPENAI_API_KEY})
    monkeypatch.setenv(ENV_OPENAI_BASE_URL, "https://gateway.example/v1")

    report = collect_credential_report(dotenv_path=dotenv, process_keys=process_keys)
    by_name = {item.name: item for item in report}
    assert set(by_name) == set(CREDENTIAL_ENV_KEYS)

    key = by_name[ENV_OPENAI_API_KEY]
    assert key.status == "set"
    assert key.length == len(secret)
    assert key.source == "process"
    preview = key.as_dict()["preview"]
    assert isinstance(preview, str)
    assert secret not in preview
    assert secret not in format_credential_report(report)
    assert REDACTION not in format_credential_report(report)  # never had raw to redact

    base = by_name[ENV_OPENAI_BASE_URL]
    assert base.status == "set"
    assert base.source == "dotenv"
    assert base.length == len("https://gateway.example/v1")

    assert by_name["OPENAI_ORG_ID"].status == "unset"
    assert by_name["OPENAI_PROJECT_ID"].status == "unset"
    text = format_credential_report(report)
    assert f"{ENV_OPENAI_API_KEY}: set (length={len(secret)}, source=process)" in text
    assert "OPENAI_ORG_ID: unset" in text


def test_preflight_anthropic_requires_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ConfigError, match="ANTHROPIC_API_KEY"):
        preflight_provider_credentials("anthropic:claude-sonnet-4-6")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    preflight_provider_credentials("anthropic:claude-sonnet-4-6")
