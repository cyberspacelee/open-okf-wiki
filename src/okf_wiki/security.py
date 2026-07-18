import os
import shutil
import subprocess
import traceback
from pathlib import Path, PurePosixPath
from urllib.parse import quote_from_bytes, unquote_to_bytes


MAX_ANALYZABLE_FILE_BYTES = 1_000_000
REDACTION = "[REDACTED CREDENTIAL]"
PROVIDER_DIAGNOSTICS_WITHHELD = "provider diagnostics withheld"
_MAX_TRACEBACK_CHARS = 32_768
GIT_EXECUTABLE = shutil.which("git", path=os.defpath) or "git"
_SECRET_ENV_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH", "COOKIE")
_SECRET_TEXT_MARKERS = (
    "authorization:",
    "api_key=",
    "api-key=",
    "bearer ",
    "password=",
    "secret=",
)


def git_read_bytes(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        [
            GIT_EXECUTABLE,
            "--no-pager",
            "--no-replace-objects",
            "--no-optional-locks",
            "-c",
            "core.askPass=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "credential.interactive=false",
            "-c",
            "gc.auto=0",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.git.allow=never",
            "-c",
            "protocol.http.allow=never",
            "-c",
            "protocol.https.allow=never",
            "-c",
            "protocol.ssh.allow=never",
            "-C",
            str(repository.resolve()),
            *arguments,
        ],
        check=False,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        env={
            "GCM_INTERACTIVE": "Never",
            "GIT_ALLOW_PROTOCOL": "",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "GIT_PROTOCOL_FROM_USER": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": os.devnull,
            "LANG": "C",
            "LC_ALL": "C",
            "PAGER": "cat",
            "PATH": os.defpath,
            "XDG_CONFIG_HOME": os.devnull,
        },
    )
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip() or "Git read failed")
    return result.stdout


def git_read(repository: Path, *arguments: str) -> str:
    return git_read_bytes(repository, *arguments).decode("utf-8")


def canonical_source_path(path: str) -> str:
    parsed = PurePosixPath(path)
    canonical = parsed.as_posix()
    decoded = unquote_to_bytes(path)
    if (
        not path
        or parsed.is_absolute()
        or ".." in parsed.parts
        or "\x00" in path
        or b"\x00" in decoded
        or canonical != path
        or quote_from_bytes(decoded, safe="/") != path
    ):
        raise ValueError("path must be a canonical repository-relative path")
    return canonical


def redact_secrets(value: str, secrets: tuple[str, ...]) -> str:
    for secret in sorted(set(filter(None, secrets)), key=len, reverse=True):
        value = value.replace(secret, REDACTION)
    return value


def environment_secrets(extra: tuple[str, ...] = ()) -> tuple[str, ...]:
    return tuple(
        set(extra)
        | {
            value
            for name, value in os.environ.items()
            if value and any(marker in name.upper() for marker in _SECRET_ENV_MARKERS)
        }
    )


def safe_error_message(error: Exception, *, secrets: tuple[str, ...] = ()) -> str:
    """Return a secret-safe operator message, or withhold provider diagnostics.

    Host configuration / filesystem / validation errors are surfaced after redaction.
    Provider transport and other opaque failures remain withheld when they look
    secret-bearing or are not operator-safe exception types.
    """
    from .errors import is_operator_safe_exception

    raw = str(error)
    message = redact_secrets(raw, environment_secrets(secrets))
    if message != raw or any(marker in message.casefold() for marker in _SECRET_TEXT_MARKERS):
        return PROVIDER_DIAGNOSTICS_WITHHELD
    if not is_operator_safe_exception(error):
        return PROVIDER_DIAGNOSTICS_WITHHELD
    return message


def _scrub_secret_marker_lines(text: str) -> str:
    """Drop residual secret-like lines after credential redaction."""
    cleaned: list[str] = []
    for line in text.splitlines(keepends=True):
        # Keep frame location lines; scrub exception/message lines that still look secret-bearing.
        stripped = line.lstrip()
        if stripped.startswith("File ") or stripped.startswith('File "'):
            cleaned.append(line)
            continue
        if any(marker in line.casefold() for marker in _SECRET_TEXT_MARKERS):
            ending = "\n" if line.endswith("\n") else ""
            cleaned.append(f"{REDACTION} line{ending}")
            continue
        cleaned.append(line)
    return "".join(cleaned)


def safe_exception_traceback(error: BaseException, *, secrets: tuple[str, ...] = ()) -> str | None:
    """Return a secret-safe traceback for operator debugging.

    Unlike :func:`safe_error_message`, stacks are kept for almost all ``Exception`` types
    (including ``RuntimeError``) so failures remain diagnosable without a log file.
    Known credential values are redacted; residual secret-like lines are scrubbed.
    """
    if not isinstance(error, Exception):
        # BaseException subclasses (e.g. KeyboardInterrupt) are not operator diagnostics.
        return None
    combined = environment_secrets(secrets)
    raw = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    text = _scrub_secret_marker_lines(redact_secrets(raw, combined))
    if len(text) > _MAX_TRACEBACK_CHARS:
        text = text[: _MAX_TRACEBACK_CHARS - 3] + "..."
    return text


def write_error_diagnostics(
    path: Path,
    *,
    error: Exception,
    run_id: str | None = None,
    command: str | None = None,
    secrets: tuple[str, ...] = (),
) -> Path:
    """Write a single secret-scrubbed diagnostic file for one failure (opt-in artifact)."""
    target = path.expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    if type(error).__name__ == "WikiRunResourceLimitError":
        message = redact_secrets(str(error), environment_secrets(secrets))
    else:
        message = safe_error_message(error, secrets=secrets)
        if message == PROVIDER_DIAGNOSTICS_WITHHELD:
            message = f"{type(error).__name__}: {message}"
    stack = safe_exception_traceback(error, secrets=secrets) or "(traceback unavailable)\n"
    if not stack.endswith("\n"):
        stack = stack + "\n"
    body = (
        "# okf-wiki failure diagnostics (secret-scrubbed)\n"
        f"error_type: {type(error).__name__}\n"
        f"run_id: {run_id or ''}\n"
        f"command: {command or ''}\n"
        "\n"
        "## message\n"
        f"{message}\n"
        "\n"
        "## traceback\n"
        f"{stack}"
    )
    target.write_text(body, encoding="utf-8")
    return target
