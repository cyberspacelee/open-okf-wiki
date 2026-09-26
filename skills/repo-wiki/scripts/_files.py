import hashlib
import json
import os
import pathlib
import stat
import tempfile
import time
from collections.abc import Collection


def compact_json(data) -> str:
    return (
        json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
    )


def compact_json_size(data) -> int:
    return len(compact_json(data).encode("utf-8"))


def atomic_json(path: pathlib.Path, data: dict) -> None:
    atomic_text(path, json_text(data))


def json_text(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def normalize_newlines(text: str) -> str:
    """CRLF and lone CR as LF, so a Windows autocrlf checkout reads like the commit."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def text_lines(text: str | bytes) -> list[str]:
    """Lines as git counts them: split on LF only, one trailing CR dropped per line.

    Unlike ``str.splitlines`` this does not break on form feed, U+2028 or other
    Unicode separators, so line numbers agree with ``git blame`` and editors.
    """
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    if not text:
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return [line.removesuffix("\r") for line in lines]


def _new_file_mode() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def atomic_text(path: pathlib.Path, text: str) -> None:
    """Replace ``path`` atomically, keeping the permissions of an existing file
    (a new file gets the usual 0666 & ~umask, not mkstemp's 0600).

    A symlink is written through: its target is replaced and the link stays
    (CLAUDE.md -> AGENTS.md keeps pointing at AGENTS.md)."""
    if path.is_symlink():
        path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        mode = _new_file_mode()
    fd, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, mode)
        for attempt in range(5):
            try:
                os.replace(temp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def directory_digest(path: pathlib.Path, *, exclude_names: Collection[str] = ()) -> str:
    digest = hashlib.sha256()
    if not path.exists():
        return digest.hexdigest()
    for file in sorted(item for item in path.rglob("*") if item.is_file()):
        if file.name in exclude_names:
            continue
        digest.update(file.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
    return digest.hexdigest()
