from pydantic import BaseModel, Field, ValidationError

from okf_wiki.errors import format_validation_error, is_operator_safe_exception, operator_error
from okf_wiki.security import PROVIDER_DIAGNOSTICS_WITHHELD, safe_error_message


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
    assert "Record is invalid:" in str(wrapped)
    assert "count" in str(wrapped)

    os_error = FileNotFoundError(2, "No such file", "/tmp/missing")
    path_error = operator_error("Path is not readable", os_error)
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
