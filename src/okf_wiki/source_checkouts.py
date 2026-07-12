import os
import secrets
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
    if remote is not None:
        try:
            validate_clone_remote(remote)
        except SourceCheckoutError as error:
            raise SourceCheckoutError(
                "Git origin remote is unsafe; repair the origin remote before refreshing status"
            ) from error
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
    workspace: Path,
    state_directory: Path,
    source_id: str,
    remote: str,
    revision: str | None = None,
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
        if revision is not None:
            verify_checkout_revision(temporary, revision)
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
    _validate_delete_root(workspace, sources_root)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        workspace_descriptor = os.open(workspace, flags)
    except OSError as error:
        raise SourceCheckoutError(f"Cannot delete managed Source {source_id}: {error}") from error
    try:
        descriptor = os.open("sources", flags, dir_fd=workspace_descriptor)
        try:
            if _is_mounted_descriptor(descriptor, workspace_descriptor):
                raise SourceCheckoutError(
                    f"Managed Sources root is an external mount: {sources_root}"
                )
            try:
                target_info = os.stat(source_id, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                quarantines = _matching_quarantines(descriptor, source_id, device, inode)
                if not quarantines:
                    return False
                if len(quarantines) > 1:
                    raise SourceCheckoutError("Managed checkout quarantine is ambiguous")
                _delete_quarantine(
                    descriptor, sources_root, source_id, quarantines[0], device, inode
                )
                return True
            if stat.S_ISLNK(target_info.st_mode):
                raise SourceCheckoutError(f"Managed checkout path contains a symlink: {target}")
            if not stat.S_ISDIR(target_info.st_mode):
                raise SourceCheckoutError(f"Managed checkout path is not a directory: {target}")
            if os.path.ismount(target):
                raise SourceCheckoutError(f"Managed checkout is an external mount: {target}")
            target_descriptor = os.open(source_id, flags, dir_fd=descriptor)
            try:
                identity = os.fstat(target_descriptor)
                if (identity.st_dev, identity.st_ino) != (device, inode):
                    raise SourceCheckoutError(
                        "Managed checkout ownership no longer matches its receipt"
                    )
                if _is_mounted_descriptor(target_descriptor, descriptor):
                    raise SourceCheckoutError(f"Managed checkout is an external mount: {target}")
                quarantine = f".{source_id}.delete-{secrets.token_hex(12)}"
                os.rename(
                    source_id,
                    quarantine,
                    src_dir_fd=descriptor,
                    dst_dir_fd=descriptor,
                )
                _delete_quarantine(descriptor, sources_root, source_id, quarantine, device, inode)
            finally:
                os.close(target_descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise SourceCheckoutError(f"Cannot delete managed Source {source_id}: {error}") from error
    finally:
        os.close(workspace_descriptor)
    return True


def verify_checkout_revision(checkout: Path, revision: str) -> None:
    _git_inspect(
        checkout,
        "rev-parse",
        "--verify",
        f"{revision}^{{commit}}",
        context=f"{checkout}: configured revision is unavailable",
    )


def _ensure_real_directory(path: Path) -> None:
    if os.path.lexists(path):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SourceCheckoutError(f"{path}: must be a real directory, not a symlink")
        return
    path.mkdir(parents=True)


def _validate_delete_root(workspace: Path, sources_root: Path) -> None:
    for path in (workspace, sources_root):
        try:
            info = path.lstat()
        except OSError as error:
            raise SourceCheckoutError(f"Managed checkout path is unavailable: {error}") from error
        if stat.S_ISLNK(info.st_mode):
            raise SourceCheckoutError(f"Managed checkout path contains a symlink: {path}")
        if not stat.S_ISDIR(info.st_mode):
            raise SourceCheckoutError(f"Managed checkout path is not a directory: {path}")
    if os.path.ismount(sources_root):
        raise SourceCheckoutError(f"Managed Sources root is an external mount: {sources_root}")


def _matching_quarantines(
    sources_descriptor: int, source_id: str, device: int, inode: int
) -> list[str]:
    prefix = f".{source_id}.delete-"
    matches = []
    with os.scandir(sources_descriptor) as entries:
        for entry in entries:
            if not entry.name.startswith(prefix):
                continue
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (device, inode):
                matches.append(entry.name)
    return matches


def _delete_quarantine(
    sources_descriptor: int,
    sources_root: Path,
    source_id: str,
    quarantine: str,
    device: int,
    inode: int,
) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        quarantine_descriptor = os.open(quarantine, flags, dir_fd=sources_descriptor)
    except OSError as error:
        _restore_quarantine(sources_descriptor, source_id, quarantine)
        raise SourceCheckoutError("Managed checkout ownership cannot be verified") from error
    try:
        identity = os.fstat(quarantine_descriptor)
        if (identity.st_dev, identity.st_ino) != (device, inode):
            _restore_quarantine(sources_descriptor, source_id, quarantine)
            raise SourceCheckoutError("Managed checkout ownership no longer matches its receipt")
        if _is_mounted_descriptor(quarantine_descriptor, sources_descriptor):
            _restore_quarantine(sources_descriptor, source_id, quarantine)
            raise SourceCheckoutError(
                f"Managed checkout is an external mount: {sources_root / quarantine}"
            )
        _delete_directory_contents(quarantine_descriptor)
        current = os.stat(quarantine, dir_fd=sources_descriptor, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (device, inode):
            raise SourceCheckoutError(
                "Managed checkout changed during deletion; external path retained"
            )
        os.rmdir(quarantine, dir_fd=sources_descriptor)
    finally:
        os.close(quarantine_descriptor)


def _delete_directory_contents(descriptor: int) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.scandir(descriptor) as iterator:
        entries = list(iterator)
    for entry in entries:
        info = entry.stat(follow_symlinks=False)
        quarantine = f".delete-{secrets.token_hex(16)}"
        if not stat.S_ISDIR(info.st_mode):
            os.rename(
                entry.name,
                quarantine,
                src_dir_fd=descriptor,
                dst_dir_fd=descriptor,
            )
            moved = os.stat(quarantine, dir_fd=descriptor, follow_symlinks=False)
            if (moved.st_dev, moved.st_ino) != (info.st_dev, info.st_ino):
                raise SourceCheckoutError("Managed checkout changed during deletion")
            os.unlink(quarantine, dir_fd=descriptor)
            continue
        child_descriptor = os.open(entry.name, flags, dir_fd=descriptor)
        try:
            identity = os.fstat(child_descriptor)
            if (identity.st_dev, identity.st_ino) != (info.st_dev, info.st_ino):
                raise SourceCheckoutError("Managed checkout changed during deletion")
            os.rename(
                entry.name,
                quarantine,
                src_dir_fd=descriptor,
                dst_dir_fd=descriptor,
            )
            moved = os.stat(quarantine, dir_fd=descriptor, follow_symlinks=False)
            if (moved.st_dev, moved.st_ino) != (identity.st_dev, identity.st_ino):
                raise SourceCheckoutError("Managed checkout changed during deletion")
            if _is_mounted_descriptor(child_descriptor, descriptor):
                raise SourceCheckoutError(
                    f"Managed checkout contains an external mount: {entry.name}"
                )
            _delete_directory_contents(child_descriptor)
            current = os.stat(quarantine, dir_fd=descriptor, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                raise SourceCheckoutError("Managed checkout changed during deletion")
            os.rmdir(quarantine, dir_fd=descriptor)
        finally:
            os.close(child_descriptor)


def _is_mounted_descriptor(descriptor: int, parent_descriptor: int) -> bool:
    mount_id = _descriptor_mount_id(descriptor)
    parent_mount_id = _descriptor_mount_id(parent_descriptor)
    return mount_id is None or parent_mount_id is None or mount_id != parent_mount_id


def _descriptor_mount_id(descriptor: int) -> int | None:
    try:
        lines = Path(f"/proc/self/fdinfo/{descriptor}").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        if line.startswith("mnt_id:"):
            return int(line.partition(":")[2].strip())
    return None


def _restore_quarantine(sources_descriptor: int, source_id: str, quarantine: str) -> None:
    try:
        os.stat(source_id, dir_fd=sources_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        os.rename(
            quarantine,
            source_id,
            src_dir_fd=sources_descriptor,
            dst_dir_fd=sources_descriptor,
        )
    else:
        raise SourceCheckoutError(
            f"Managed checkout changed during deletion; retained as {quarantine}"
        )


def _git_clone(source_id: str, remote: str, target: Path, template: Path) -> None:
    executable = shutil.which("git", path=os.defpath)
    if executable is None:
        raise SourceCheckoutError("System Git is not available")
    environment = _clone_environment()
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
        "--no-checkout",
        "--no-local",
        "--no-recurse-submodules",
        f"--template={template}",
        "--",
        remote,
        str(target),
    ]
    checkout = [
        executable,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "submodule.recurse=false",
        "-C",
        str(target),
        "checkout",
    ]
    checkout_environment = environment | {
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    for operation, operation_environment in (
        (command, environment),
        (checkout, checkout_environment),
    ):
        try:
            result = subprocess.run(
                operation,
                check=False,
                capture_output=True,
                text=True,
                env=operation_environment,
            )
        except OSError as error:
            raise SourceCheckoutError(f"Source {source_id} clone failed: {error}") from error
        if result.returncode:
            raise SourceCheckoutError(
                f"Source {source_id} clone failed: Git exited with status {result.returncode}"
            )


def _clone_environment() -> dict[str, str]:
    allowed = {
        "ALL_PROXY",
        "APPDATA",
        "COMSPEC",
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
        "GCM_CREDENTIAL_STORE",
        "GCM_GUI_PROMPT",
        "GCM_HTTP_TIMEOUT",
        "GCM_INTERACTIVE",
        "GIT_ASKPASS",
        "GIT_CONFIG_GLOBAL",
        "GIT_SSL_CAINFO",
        "GIT_SSL_CAPATH",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "LOCALAPPDATA",
        "NO_PROXY",
        "PATHEXT",
        "SSH_AGENT_PID",
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "SSH_AUTH_SOCK",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WAYLAND_DISPLAY",
        "WINDIR",
        "XAUTHORITY",
        "XDG_CONFIG_HOME",
        "__CF_USER_TEXT_ENCODING",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    environment.update(
        {
            "GIT_OPTIONAL_LOCKS": "0",
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": os.defpath,
        }
    )
    return environment


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
