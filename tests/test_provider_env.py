from pathlib import Path

import pytest
from pydantic_ai.providers.openai import OpenAIProvider

from okf_wiki.host.provider.env import (
    DEFAULT_MODEL_IDENTITY,
    env_limit_overrides,
    resolve_model_identity,
    resolve_model_settings,
)
from okf_wiki.host.provider.retry import ProviderRetryState, prepare_model_with_provider_retry
from okf_wiki.host import WikiRunLimits, WikiRunRequest


def test_resolve_model_identity_prefers_configured_then_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OKF_WIKI_MODEL", raising=False)
    assert resolve_model_identity(None) == DEFAULT_MODEL_IDENTITY
    monkeypatch.setenv("OKF_WIKI_MODEL", "openai:from-env")
    assert resolve_model_identity(None) == "openai:from-env"
    assert resolve_model_identity("openai:from-cli") == "openai:from-cli"
    assert resolve_model_identity("  ") == "openai:from-env"


def test_resolve_model_settings_merges_explicit_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OKF_WIKI_MAX_TOKENS", "4096")
    monkeypatch.setenv("OKF_WIKI_TEMPERATURE", "0.1")
    monkeypatch.delenv("OKF_WIKI_REQUEST_TIMEOUT_SECONDS", raising=False)
    settings = resolve_model_settings(max_tokens=2048, timeout=30)
    assert dict(settings) == {"max_tokens": 2048, "temperature": 0.1, "timeout": 30.0}


def test_env_limit_overrides_and_wiki_run_limits_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OKF_WIKI_CONTEXT_TARGET_TOKENS", "50000")
    monkeypatch.setenv("OKF_WIKI_OUTPUT_TOKENS_LIMIT", "12000")
    monkeypatch.delenv("OKF_WIKI_INPUT_TOKENS_LIMIT", raising=False)
    overrides = env_limit_overrides()
    assert overrides["context_target_tokens"] == 50_000
    assert overrides["output_tokens_limit"] == 12_000
    limits = WikiRunLimits.build({"context_target_tokens": 80_000, "request_limit": 7})
    assert limits.context_target_tokens == 80_000  # YAML wins over env
    assert limits.output_tokens_limit == 12_000  # env fills omitted key
    assert limits.request_limit == 7
    assert limits.input_tokens_limit == 250_000  # product default


def test_yaml_model_object_and_env_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("x\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()

    monkeypatch.setenv("OKF_WIKI_MODEL", "openai:env-model")
    monkeypatch.setenv("OKF_WIKI_MAX_TOKENS", "1024")
    monkeypatch.setenv("OKF_WIKI_CONTEXT_TARGET_TOKENS", "64000")

    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
model:
  identity: openai:yaml-model
  max_tokens: 2048
  temperature: 0.3
staging: ./staging
publication: ./published
repositories:
  - id: source
    path: ./source
    revision: {revision}
limits:
  request_limit: 9
""",
        encoding="utf-8",
    )
    request = WikiRunRequest.from_yaml(config)
    assert request.model.model == "openai:yaml-model"
    assert dict(request.model.settings) == {
        "max_tokens": 2048,
        "temperature": 0.3,
    }
    assert request.limits.request_limit == 9
    assert request.limits.context_target_tokens == 64_000


def test_yaml_omitted_model_uses_env_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("x\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()

    monkeypatch.setenv("OKF_WIKI_MODEL", "openai:only-env")
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
staging: ./staging
publication: ./published
repositories:
  - id: source
    path: ./source
    revision: {revision}
""",
        encoding="utf-8",
    )
    # model key omitted entirely
    request = WikiRunRequest.from_yaml(config)
    assert request.model.model == "openai:only-env"


def test_prepare_model_passes_openai_compatible_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://gateway.example/v1")
    model = prepare_model_with_provider_retry(
        "openai:served-model",
        state=ProviderRetryState(),
    )
    assert not isinstance(model, str)
    provider = model._provider  # type: ignore[attr-defined]
    assert isinstance(provider, OpenAIProvider)
    assert str(provider.base_url).rstrip("/") == "https://gateway.example/v1"
    assert provider.client.api_key == "test-key"
    assert model.model_name == "served-model"  # type: ignore[attr-defined]
