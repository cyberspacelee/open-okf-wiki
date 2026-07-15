import os
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from urllib.parse import quote_from_bytes, unquote_to_bytes


MAX_ANALYZABLE_FILE_BYTES = 1_000_000
REDACTION = "[REDACTED CREDENTIAL]"
PROVIDER_DIAGNOSTICS_WITHHELD = "provider diagnostics withheld"
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
    raw = str(error)
    message = redact_secrets(raw, environment_secrets(secrets))
    if (
        message != raw
        or any(marker in message.casefold() for marker in _SECRET_TEXT_MARKERS)
        or not isinstance(error, (OSError, ValueError))
    ):
        return PROVIDER_DIAGNOSTICS_WITHHELD
    return message
