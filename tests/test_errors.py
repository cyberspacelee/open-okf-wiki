from pathlib import Path

import pytest
from pydantic import BaseModel, Field, ValidationError

from okf_wiki.run.errors import (
    ConfigError,
    RunValidationError,
    OkfWikiError,
    PublicationError,
    format_validation_error,
    is_operator_safe_exception,
    operator_error,
)
from okf_wiki.run.security import (
    PROVIDER_DIAGNOSTICS_WITHHELD,
    safe_error_message,
    safe_exception_traceback,
    write_error_diagnostics,
)


class _Sample(BaseModel):
    count: int = Field(gt=0)


def test_format_validation_error_lists_field_paths() -> None:
    try:
        _Sample.model_validate({"count": 0})
    except ValidationError as error:
        message = format_validation_error(error, prefix="Config is invalid")
    assert message.startswith("Config is invalid:")
    assert "count" in message
    assert "greater" in message.casefold()
    assert "input_value" not in message


def test_operator_error_preserves_validation_and_cause_detail() -> None:
    try:
        _Sample.model_validate({"count": 0})
    except ValidationError as error:
        wrapped = operator_error("Record is invalid", error)
    assert isinstance(wrapped, ConfigError)
    assert isinstance(wrapped, OkfWikiError)
    assert isinstance(wrapped, ValueError)
    assert "Record is invalid:" in str(wrapped)
    assert "count" in str(wrapped)

    os_error = FileNotFoundError(2, "No such file", "/tmp/missing")
    path_error = operator_error("Path is not readable", os_error, error_cls=RunValidationError)
    assert isinstance(path_error, RunValidationError)
    assert "Path is not readable:" in str(path_error)
    assert "No such file" in str(path_error)


def test_safe_error_message_surfaces_operator_validation_errors() -> None:
    try:
        _Sample.model_validate({"count": 0})
    except ValidationError as error:
        message = safe_error_message(error)
    assert message != PROVIDER_DIAGNOSTICS_WITHHELD
    assert "count" in message


def test_safe_error_message_still_withholds_provider_runtime_errors() -> None:
    assert (
        safe_error_message(RuntimeError("provider Authorization: Bearer secret-token"))
        == PROVIDER_DIAGNOSTICS_WITHHELD
    )
    assert not is_operator_safe_exception(RuntimeError("opaque"))
    assert is_operator_safe_exception(ValueError("bad config"))
    assert is_operator_safe_exception(ConfigError("bad config"))
    assert is_operator_safe_exception(PublicationError("locked"))
    assert not is_operator_safe_exception(AssertionError("internal"))


def test_safe_error_message_surfaces_missing_credential_runtime_errors() -> None:
    """OpenAI-style missing-key failures must not collapse to withheld solely by type."""
    openai_style = (
        "The api_key client option must be set either by passing api_key to the client "
        "or by setting the OPENAI_API_KEY environment variable"
    )
    message = safe_error_message(RuntimeError(openai_style))
    assert message != PROVIDER_DIAGNOSTICS_WITHHELD
    assert "OPENAI_API_KEY" in message
    assert "api_key client option" in message

    # Exception type alone (e.g. SDK OpenAIError-like) must not force withhold.
    class OpenAIError(Exception):
        pass

    sdk_message = safe_error_message(OpenAIError(openai_style))
    assert sdk_message != PROVIDER_DIAGNOSTICS_WITHHELD
    assert "OPENAI_API_KEY" in sdk_message


def test_safe_error_message_surfaces_redacted_non_marker_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "live-env-secret-value-xyz"
    monkeypatch.setenv("OPENAI_API_KEY", secret)
    message = safe_error_message(RuntimeError(f"upstream rejected token {secret}"))
    assert message != PROVIDER_DIAGNOSTICS_WITHHELD
    assert secret not in message
    assert "upstream rejected token" in message


def test_safe_exception_traceback_preserves_stacks_and_redacts_secrets() -> None:
    try:
        raise ConfigError("staging path is invalid")
    except ConfigError as error:
        stack = safe_exception_traceback(error)
    assert stack is not None
    assert "ConfigError" in stack
    assert "staging path is invalid" in stack
    assert "Traceback" in stack

    # RuntimeError used to lose stacks entirely; debugging needs them without a log file.
    try:
        raise RuntimeError("model transport failed: connection reset")
    except RuntimeError as error:
        runtime_stack = safe_exception_traceback(error)
    assert runtime_stack is not None
    assert "RuntimeError" in runtime_stack
    assert "connection reset" in runtime_stack

    secret = "traceback-secret-token"
    try:
        raise RuntimeError(f"provider Authorization: Bearer {secret}")
    except RuntimeError as error:
        secret_stack = safe_exception_traceback(error)
    assert secret_stack is not None
    assert secret not in secret_stack
    assert "Traceback" in secret_stack
    assert "Authorization: Bearer" not in secret_stack


def test_write_error_diagnostics_writes_scrubbed_file(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "err.diag.txt"
    try:
        raise ConfigError("staging path is invalid")
    except ConfigError as error:
        written = write_error_diagnostics(path, error=error, run_id="ab" * 16, command="wiki-run")
    assert written == path.resolve()
    text = path.read_text(encoding="utf-8")
    assert "error_type: ConfigError" in text
    assert "run_id: " in text
    assert "staging path is invalid" in text
    assert "Traceback" in text
