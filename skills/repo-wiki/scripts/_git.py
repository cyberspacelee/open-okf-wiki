"""Every git subprocess call. Paths in and out are posix, relative to the repo."""

import subprocess
import threading
from pathlib import Path
from typing import Self


class GitError(Exception):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(f"{message}: {stderr}" if stderr else message)
        self.stderr = stderr


def _run(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-C", str(repo), *args],
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        raise GitError(f"git {args[0]} failed in {repo}", _err(result.stderr))
    return result


def _text(data: bytes) -> str:
    return data.decode("utf-8", errors="surrogateescape")


def _err(data: bytes) -> str:
    return data.decode("utf-8", errors="replace").strip()


def _paths(data: bytes) -> list[str]:
    return [item for item in _text(data).split("\0") if item]


def _rev(rev: str) -> str:
    if not rev or rev.startswith("-"):
        raise GitError(f"invalid revision {rev!r}")
    return rev


def toplevel(path: Path) -> Path | None:
    if not Path(path).is_dir():
        return None
    result = _run(path, "rev-parse", "--show-toplevel", check=False)
    if result.returncode:
        return None
    return Path(_text(result.stdout).strip()).resolve()


def head(repo: Path) -> str:
    return _text(_run(repo, "rev-parse", "--verify", "HEAD").stdout).strip()


def is_shallow(repo: Path) -> bool:
    """True for a shallow clone, whose history (and so co-change) is cut off."""
    out = _run(repo, "rev-parse", "--is-shallow-repository").stdout
    return _text(out).strip() == "true"


def is_clean(repo: Path, exclude: list[str] = ()) -> tuple[bool, list[str]]:
    """Tracked changes only; paths equal to or under an ``exclude`` prefix are ignored."""
    out = _run(repo, "status", "--porcelain=v1", "-z", "--untracked-files=no").stdout
    tokens = _text(out).split("\0")
    prefixes = [item.rstrip("/") for item in exclude]
    dirty: list[str] = []
    index = 0
    while index < len(tokens):
        entry = tokens[index]
        index += 1
        if not entry:
            continue
        paths = [entry[3:]]
        if entry[0] in "RC" or entry[1] in "RC":  # rename/copy: original path follows
            paths.append(tokens[index])
            index += 1
        for path in paths:
            if not any(path == p or path.startswith(p + "/") for p in prefixes):
                dirty.append(path)
    dirty = sorted(set(dirty))
    return not dirty, dirty


def changed(repo: Path, path: str) -> list[str]:
    """Uncommitted changes (tracked or untracked, ignored files excluded) at or below ``path``."""
    out = _run(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path).stdout
    tokens = _text(out).split("\0")
    found: list[str] = []
    index = 0
    while index < len(tokens):
        entry = tokens[index]
        index += 1
        if not entry:
            continue
        found.append(entry[3:])
        if entry[0] in "RC" or entry[1] in "RC":
            index += 1
    return sorted(set(found))


def ls_files(repo: Path, rev: str | None = None) -> list[str]:
    if rev is None:
        return sorted(set(_paths(_run(repo, "ls-files", "-z").stdout)))
    out = _run(repo, "ls-tree", "-r", "-z", "--name-only", _rev(rev)).stdout
    return sorted(_paths(out))


def ls_candidates(repo: Path, name: str) -> list[str]:
    """Tracked or untracked-but-not-ignored files whose basename is ``name``."""
    out = _run(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").stdout
    return sorted({p for p in _paths(out) if p.rsplit("/", 1)[-1] == name})


def rev_exists(repo: Path, rev: str) -> bool:
    if not rev or rev.startswith("-"):
        return False
    result = _run(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}", check=False)
    return result.returncode == 0


class BlobReader:
    """One long-lived ``git cat-file --batch`` process; use as a context manager."""

    def __init__(self, repo: Path):
        self.repo = repo
        self._proc = subprocess.Popen(
            ["git", "-c", "core.quotepath=off", "-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def read(self, rev: str, path: str) -> bytes | None:
        """Blob bytes of ``path`` at ``rev``; None when missing or not a blob."""
        request = f"{rev}:{path}".encode("utf-8", errors="surrogateescape")
        if b"\n" in request or b"\r" in request:
            raise GitError(f"object name contains a line break: {rev}:{path!r}")
        proc = self._proc
        if proc.poll() is not None:
            raise GitError("git cat-file is not running", self._stderr())
        try:
            proc.stdin.write(request + b"\n")
            proc.stdin.flush()
        except OSError as exc:
            raise GitError("git cat-file write failed", self._stderr()) from exc
        header = proc.stdout.readline()
        if not header.endswith(b"\n"):
            raise GitError("git cat-file ended unexpectedly", self._stderr())
        # "<oid> <type> <size>", or "<name> missing" where <name> may contain spaces.
        fields = header.split()
        if len(fields) != 3 or not fields[2].isdigit():
            return None
        size = int(fields[2])
        data = proc.stdout.read(size)
        if len(data) != size or proc.stdout.read(1) != b"\n":
            raise GitError("git cat-file returned a truncated object", self._stderr())
        return data if fields[1] == b"blob" else None

    def read_many(self, rev: str, paths: list[str]):
        """Yield (path, blob bytes or None) for every path, in order.

        Requests are written by a helper thread while replies are read, so git
        never waits for a round trip; this is several times faster than ``read``
        in a loop over thousands of files.
        """
        requests = []
        for path in paths:
            request = f"{rev}:{path}".encode("utf-8", errors="surrogateescape")
            if b"\n" in request or b"\r" in request:
                raise GitError(f"object name contains a line break: {rev}:{path!r}")
            requests.append(request + b"\n")
        proc = self._proc
        if proc.poll() is not None:
            raise GitError("git cat-file is not running", self._stderr())
        failed: list[OSError] = []

        def write() -> None:
            try:
                for request in requests:
                    proc.stdin.write(request)
                proc.stdin.flush()
            except OSError as exc:
                failed.append(exc)

        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        finished = False
        try:
            for path in paths:
                header = proc.stdout.readline()
                if not header.endswith(b"\n"):
                    raise GitError("git cat-file ended unexpectedly", self._stderr())
                fields = header.split()
                if len(fields) != 3 or not fields[2].isdigit():
                    yield path, None
                    continue
                size = int(fields[2])
                data = proc.stdout.read(size)
                if len(data) != size or proc.stdout.read(1) != b"\n":
                    raise GitError("git cat-file returned a truncated object", self._stderr())
                yield path, data if fields[1] == b"blob" else None
            finished = True
        finally:
            if not finished:
                # Abandoned mid-stream: unread replies would block git and so the
                # writer; stop the process (this reader cannot be reused).
                proc.kill()
            writer.join()
        if failed:
            raise GitError("git cat-file write failed", self._stderr()) from failed[0]

    def _stderr(self) -> str:
        if self._proc.poll() is None:
            return ""
        return _err(self._proc.stderr.read())

    def close(self) -> None:
        proc = self._proc
        if proc.stdin and not proc.stdin.closed:
            try:
                proc.stdin.close()
            except OSError:
                pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        proc.stderr.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def diff_name_status(
    repo: Path, old: str, new: str, pathspecs: list[str]
) -> list[tuple[str, str, str | None]]:
    """(status letter, path, new path for R/C) from ``old`` to ``new``.

    Pathspecs are plain posix globs or paths and get the ``:(glob)`` magic; a
    pathspec that already starts with ``:(`` is passed through unchanged. An
    empty list means the whole tree.
    """
    args = ["diff", "--name-status", "-z", "-M", "--no-ext-diff", _rev(old), _rev(new)]
    if pathspecs:
        args += ["--", *(p if p.startswith(":(") else f":(glob){p}" for p in pathspecs)]
    tokens = _text(_run(repo, *args).stdout).split("\0")
    changes: list[tuple[str, str, str | None]] = []
    index = 0
    while index < len(tokens) and tokens[index]:
        letter = tokens[index][0]
        if letter in "RC":
            changes.append((letter, tokens[index + 1], tokens[index + 2]))
            index += 3
        else:
            changes.append((letter, tokens[index + 1], None))
            index += 2
    return changes


def grep_files(repo: Path, rev: str, tokens: tuple[str, ...]) -> set[str]:
    """Paths at ``rev`` whose text contains at least one of the fixed strings."""
    args = ["grep", "-z", "-l", "-I", "-F", "--no-color"]
    for token in tokens:
        args += ["-e", token]
    result = _run(repo, *args, _rev(rev), "--", check=False)
    if result.returncode not in (0, 1):  # 1: no file matched
        raise GitError(f"git grep failed in {repo}", _err(result.stderr))
    prefix = f"{rev}:"
    return {p.removeprefix(prefix) for p in _paths(result.stdout)}


def log_name_only(repo: Path, max_commits: int) -> list[list[str]]:
    """Changed paths per commit reachable from HEAD, newest first."""
    out = _run(
        repo,
        "-c",
        "log.showSignature=false",
        "log",
        "-z",
        "--name-only",
        "--format=%x00%H",
        f"--max-count={int(max_commits)}",
    ).stdout
    # Stream: for each commit "\0<hash>\0", then "\n<path>\0<path>\0..." when it
    # changed files. Paths are never empty, so an empty token marks a boundary
    # and the token after it is the hash.
    commits: list[list[str]] = []
    header = False
    first = False
    for token in _text(out).split("\0"):
        if header:
            commits.append([])
            header, first = False, True
        elif not token:
            header = True
        else:
            commits[-1].append(token[1:] if first and token.startswith("\n") else token)
            first = False
    return commits


def check_ignore(repo: Path, path: str) -> bool:
    result = _run(repo, "check-ignore", "-q", "--", path, check=False)
    if result.returncode not in (0, 1):
        raise GitError(f"git check-ignore failed in {repo}", _err(result.stderr))
    return result.returncode == 0
