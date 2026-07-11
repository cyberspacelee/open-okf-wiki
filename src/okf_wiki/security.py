import os
import shutil
import subprocess
from pathlib import PurePosixPath
from pathlib import Path
from urllib.parse import quote_from_bytes, unquote_to_bytes


MAX_ANALYZABLE_FILE_BYTES = 1_000_000
MAX_TOOL_RESULT_CHARS = 100_000
MAX_SEARCH_MATCHES = 200
REDACTION = "[REDACTED CREDENTIAL]"
GIT_EXECUTABLE = shutil.which("git", path=os.defpath) or "git"


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


def contains_secret(value: str, secrets: tuple[str, ...]) -> bool:
    return any(secret and secret in value for secret in secrets)
