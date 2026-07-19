"""Operator diagnostics: credential preflight, doctor reports, and error helpers.

Re-exports secret-safe error helpers so call sites can import one package for
operator-facing diagnostics without reaching into security/errors internals.
"""

from __future__ import annotations

from ..run.errors import ConfigError, is_operator_safe_exception, operator_error
from ..run.security import (
    PROVIDER_DIAGNOSTICS_WITHHELD,
    safe_error_message,
    safe_exception_traceback,
)
from .doctor import CredentialStatus, collect_credential_report, format_credential_report
from .preflight import preflight_provider_credentials

__all__ = [
    "ConfigError",
    "CredentialStatus",
    "PROVIDER_DIAGNOSTICS_WITHHELD",
    "collect_credential_report",
    "format_credential_report",
    "is_operator_safe_exception",
    "operator_error",
    "preflight_provider_credentials",
    "safe_error_message",
    "safe_exception_traceback",
]
