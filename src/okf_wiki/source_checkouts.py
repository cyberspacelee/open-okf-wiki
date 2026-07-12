import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .security import git_read


class SourceCheckoutError(ValueError):
    pass


def validate_clone_remote(remote: str) -> None:
    if remote.startswith("-") or "::" in remote:
        raise SourceCheckoutError(
            "Invalid Source remote: executable or option-like remotes are refused"
        )
    parsed = urlsplit(remote)
    if (
        parsed.query
        or parsed.fragment
        or parsed.password is not None
        or (parsed.scheme in {"http", "https"} and parsed.username is not None)
    ):
        raise SourceCheckoutError(
            "Invalid Source remote: credentials, query, and fragment values are refused"
        )
    if parsed.scheme and parsed.scheme not in {"file", "git", "http", "https", "ssh"}:
        raise SourceCheckoutError(f"Invalid Source remote protocol: {parsed.scheme}")


def inspect_checkout(checkout: Path) -> dict[str, object]:
    if not checkout.is_dir():
        raise SourceCheckoutError(f"{checkout}: not a usable Git working tree")
    context = f"{checkout}: not a usable Git working tree"
    inside = _git_inspect(checkout, "rev-parse", "--is-inside-work-tree", context=context)
    top = _git_inspect(checkout, "rev-parse", "--show-toplevel", context=context)
    if inside != "true" or top is None or Path(top).resolve() != checkout.resolve():
        raise SourceCheckoutError(context)
    commit = _git_inspect(checkout, "rev-parse", "--verify", "HEAD^{commit}", context=context)
    branch = _git_inspect(checkout, "symbolic-ref", "--short", "-q", "HEAD", required=False)
    remote = _git_inspect(checkout, "remote", "get-url", "origin", required=False)
    dirty = bool(_git_inspect(checkout, "status", "--porcelain=v1", "--untracked-files=normal"))
    ahead: int | None = None
    behind: int | None = None
    if branch and _git_inspect(
        checkout, "rev-parse", "--verify", "@{upstream}^{commit}", required=False
    ):
        counts = _git_inspect(checkout, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
        if counts:
            ahead, behind = (int(value) for value in counts.split())
    return {
        "remote": remote,
        "branch": branch,
        "commit": commit,
        "dirty": dirty,
        "ahead": ahead,
        "behind": behind,
        "error": None,
    }


def clone_checkout(
    workspace: Path, state_directory: Path, source_id: str, remote: str
) -> tuple[Path, dict[str, object], os.stat_result]:
    validate_clone_remote(remote)
    sources_root = workspace / "sources"
    _ensure_real_directory(sources_root)
    target = sources_root / source_id
    if os.path.lexists(target):
        raise SourceCheckoutError(f"Source {source_id} checkout already exists: {target}")
    _ensure_real_directory(state_directory)
    temporary = Path(tempfile.mkdtemp(prefix=f".{source_id}.clone-", dir=sources_root))
    template = Path(tempfile.mkdtemp(prefix="git-template-", dir=state_directory))
    (template / "hooks").mkdir()
    try:
        _git_clone(source_id, remote, temporary, template)
        status = inspect_checkout(temporary)
        os.replace(temporary, target)
        return target, status, target.stat()
    except SourceCheckoutError:
        raise
    except OSError as error:
        raise SourceCheckoutError(f"Source {source_id} clone failed: {error}") from error
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        shutil.rmtree(template, ignore_errors=True)


def delete_managed_checkout(
    workspace: Path, source_id: str, receipt_path: Path, device: int, inode: int
) -> bool:
    sources_root = workspace / "sources"
    target = sources_root / source_id
    expected = workspace / "sources" / source_id
    if receipt_path != expected or target != expected:
        raise SourceCheckoutError("Managed checkout path is escaped or ambiguous")
    if not os.path.lexists(target):
        return False
    for path in (workspace, sources_root, target):
        try:
            info = path.lstat()
        except OSError as error:
            raise SourceCheckoutError(f"Managed checkout path is unavailable: {error}") from error
        if stat.S_ISLNK(info.st_mode):
            raise SourceCheckoutError(f"Managed checkout path contains a symlink: {path}")
        if not stat.S_ISDIR(info.st_mode):
            raise SourceCheckoutError(f"Managed checkout path is not a directory: {path}")
    identity = target.stat()
    if (identity.st_dev, identity.st_ino) != (device, inode):
        raise SourceCheckoutError("Managed checkout ownership no longer matches its receipt")
    for root, directories, _files in os.walk(target, followlinks=False):
        for name in directories:
            candidate = Path(root) / name
            if not candidate.is_symlink() and os.path.ismount(candidate):
                raise SourceCheckoutError(
                    f"Managed checkout contains an external mount: {candidate}"
                )
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(sources_root, flags)
    try:
        shutil.rmtree(source_id, dir_fd=descriptor)
    except OSError as error:
        raise SourceCheckoutError(f"Cannot delete managed Source {source_id}: {error}") from error
    finally:
        os.close(descriptor)
    return True


def _ensure_real_directory(path: Path) -> None:
    if os.path.lexists(path):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SourceCheckoutError(f"{path}: must be a real directory, not a symlink")
        return
    path.mkdir(parents=True)


def _git_clone(source_id: str, remote: str, target: Path, template: Path) -> None:
    executable = shutil.which("git", path=os.defpath)
    if executable is None:
        raise SourceCheckoutError("System Git is not available")
    environment = os.environ.copy()
    injected = {
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_TEMPLATE_DIR",
        "GIT_WORK_TREE",
    }
    for key in list(environment):
        if (
            key in injected
            or key.startswith("GIT_CONFIG_KEY_")
            or key.startswith("GIT_CONFIG_VALUE_")
        ):
            environment.pop(key)
    environment.update({"GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"})
    command = [
        executable,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "protocol.ext.allow=never",
        "clone",
        "--no-local",
        "--no-recurse-submodules",
        f"--template={template}",
        "--",
        remote,
        str(target),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as error:
        raise SourceCheckoutError(f"Source {source_id} clone failed: {error}") from error
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise SourceCheckoutError(
            f"Source {source_id} clone failed: "
            f"{detail[-1] if detail else 'Git exited unsuccessfully'}"
        )


def _git_inspect(
    checkout: Path,
    *arguments: str,
    required: bool = True,
    context: str = "Git checkout inspection failed",
) -> str | None:
    try:
        return git_read(checkout, *arguments).strip()
    except (OSError, UnicodeError, ValueError) as error:
        if not required:
            return None
        detail = str(error).strip().splitlines()
        raise SourceCheckoutError(
            f"{context}: {detail[-1] if detail else 'Git exited unsuccessfully'}"
        ) from error
