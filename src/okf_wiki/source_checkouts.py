import hashlib
import os
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .security import git_read, git_read_bytes


class SourceCheckoutError(ValueError):
    pass


FULL_COMMIT_RE = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})")


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
    dirty = bool(_working_tree_changes(checkout))
    ahead: int | None = None
    behind: int | None = None
    remote_commit: str | None = None
    if branch:
        remote_commit = _git_inspect(
            checkout, "rev-parse", "--verify", "@{upstream}^{commit}", required=False
        )
        if remote_commit:
            counts = _git_inspect(
                checkout, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"
            )
            if counts:
                ahead, behind = (int(value) for value in counts.split())
    return {
        "remote": remote,
        "branch": branch,
        "commit": commit,
        "local_commit": commit,
        "remote_commit": remote_commit,
        "dirty": dirty,
        "ahead": ahead,
        "behind": behind,
        "error": None,
    }


def resolve_revision_policy(
    checkout: Path, revision_policy: str, revision: str, *, require_clean: bool = True
) -> dict[str, str | None]:
    inspect_checkout(checkout)
    if require_clean:
        _require_clean_checkout(checkout)
    local_commit: str | None
    remote_commit: str | None
    if revision_policy == "follow_branch":
        _validate_branch(checkout, revision)
        local_commit = _git_inspect(
            checkout,
            "rev-parse",
            "--verify",
            f"refs/heads/{revision}^{{commit}}",
            context=f"Followed branch {revision} is unavailable locally",
        )
        remote_commit = _git_inspect(
            checkout,
            "rev-parse",
            "--verify",
            f"refs/remotes/origin/{revision}^{{commit}}",
            required=False,
        )
        exact_commit = local_commit
    elif revision_policy == "pinned_commit":
        if FULL_COMMIT_RE.fullmatch(revision) is None:
            raise SourceCheckoutError("Pinned Commit must be a complete Git commit ID")
        exact_commit = _git_inspect(
            checkout,
            "rev-parse",
            "--verify",
            f"{revision}^{{commit}}",
            context="Pinned Commit is unavailable in this checkout",
        )
        if exact_commit is None or exact_commit.casefold() != revision.casefold():
            raise SourceCheckoutError(
                "Pinned Commit does not resolve to the exact requested commit"
            )
        local_commit = _git_inspect(checkout, "rev-parse", "--verify", "HEAD^{commit}")
        branch = _git_inspect(checkout, "symbolic-ref", "--short", "-q", "HEAD", required=False)
        remote_commit = (
            _git_inspect(
                checkout,
                "rev-parse",
                "--verify",
                f"refs/remotes/origin/{branch}^{{commit}}",
                required=False,
            )
            if branch
            else None
        )
    else:
        raise SourceCheckoutError(f"Unsupported Source Revision Policy: {revision_policy}")
    assert exact_commit is not None
    tree = git_read_bytes(checkout, "ls-tree", "-r", "--full-tree", "-z", exact_commit)
    return {
        "local_commit": local_commit,
        "remote_commit": remote_commit,
        "exact_commit": exact_commit,
        "tree_digest": hashlib.sha256(tree).hexdigest(),
    }


def pull_checkout(
    checkout: Path, source_id: str, followed_branch: str | None = None
) -> dict[str, object]:
    status = inspect_checkout(checkout)
    _require_clean_checkout(checkout)
    branch = status["branch"]
    if not isinstance(branch, str):
        raise SourceCheckoutError(
            f"Pull blocked for Source {source_id}: checkout is detached; check out a branch manually"
        )
    if followed_branch is not None and branch != followed_branch:
        raise SourceCheckoutError(
            f"Pull blocked for Source {source_id}: checkout is on {branch}; "
            f"check out followed branch {followed_branch} manually"
        )
    _validate_branch(checkout, branch)
    before = status["commit"]
    temporary_ref = f"refs/okf-wiki/pull/{secrets.token_hex(16)}"
    try:
        fetched = _git_mutate(
            checkout,
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            "origin",
            f"refs/heads/{branch}:{temporary_ref}",
            credentials=True,
        )
        if fetched.returncode:
            raise SourceCheckoutError(
                f"Pull failed for Source {source_id}: remote branch origin/{branch} is unavailable; "
                "verify the branch, remote, and your Git credentials"
            )
        remote_commit = _git_inspect(
            checkout,
            "rev-parse",
            "--verify",
            f"{temporary_ref}^{{commit}}",
            context=f"Pull failed for Source {source_id}: fetched commit is unavailable",
        )
        current = _git_inspect(checkout, "rev-parse", "--verify", "HEAD^{commit}")
        if current != before:
            raise SourceCheckoutError(
                f"Pull blocked for Source {source_id}: checkout changed while fetching; try again"
            )
        current_branch = _git_inspect(
            checkout, "symbolic-ref", "--short", "-q", "HEAD", required=False
        )
        if current_branch != branch:
            raise SourceCheckoutError(
                f"Pull blocked for Source {source_id}: checked-out branch changed while fetching; "
                "try again"
            )
        _require_clean_checkout(checkout)
        if _external_checkout_filter(checkout, temporary_ref):
            raise SourceCheckoutError(
                f"Pull blocked for Source {source_id}: Git attributes select an executable filter; "
                "remove the filter before updating this checkout"
            )
        remote_is_ahead = (
            _git_mutate(checkout, "merge-base", "--is-ancestor", "HEAD", temporary_ref).returncode
            == 0
        )
        local_is_ahead = (
            _git_mutate(checkout, "merge-base", "--is-ancestor", temporary_ref, "HEAD").returncode
            == 0
        )
        if not remote_is_ahead and not local_is_ahead:
            raise SourceCheckoutError(
                f"Pull failed for Source {source_id}: origin/{branch} is not a fast-forward; "
                "resolve the branch divergence manually"
            )
        if remote_is_ahead:
            merged = _git_mutate(
                checkout, "merge", "--ff-only", "--no-edit", "--no-verify", temporary_ref
            )
            if merged.returncode:
                raise SourceCheckoutError(
                    f"Pull failed for Source {source_id}: Git could not fast-forward the clean checkout"
                )
        assert remote_commit is not None
        tracked = _git_mutate(
            checkout,
            "update-ref",
            f"refs/remotes/origin/{branch}",
            remote_commit,
        )
        if tracked.returncode:
            raise SourceCheckoutError(
                f"Pull updated Source {source_id}, but its origin/{branch} status could not be recorded"
            )
        return inspect_checkout(checkout)
    finally:
        _git_mutate(checkout, "update-ref", "-d", temporary_ref)


def _working_tree_changes(checkout: Path) -> list[str]:
    status = _git_inspect(
        checkout,
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "--ignored=matching",
        context=f"{checkout}: Git working-tree status is unavailable",
    )
    return status.splitlines() if status else []


def _require_clean_checkout(checkout: Path) -> None:
    changes = _working_tree_changes(checkout)
    categories = []
    if any(line.startswith("u ") for line in changes):
        categories.append("unresolved conflicts")
    if any(line.startswith(("? ", "! ")) for line in changes):
        categories.append("untracked or ignored files")
    if any(line[:1] in {"1", "2"} and len(line) > 3 and line[2] != "." for line in changes):
        categories.append("staged changes")
    if any(line[:1] in {"1", "2"} and len(line) > 3 and line[3] != "." for line in changes):
        categories.append("tracked changes")
    operations = [
        name
        for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_HEAD")
        if _git_inspect(checkout, "rev-parse", "--verify", "-q", name, required=False)
    ]
    operations.extend(
        name
        for name in ("rebase-merge", "rebase-apply", "sequencer")
        if _git_path_exists(checkout, name)
    )
    if operations:
        categories.append("an unfinished Git operation")
    if categories:
        raise SourceCheckoutError(
            "Pull blocked: checkout has " + ", ".join(dict.fromkeys(categories))
        )


def _git_path_exists(checkout: Path, name: str) -> bool:
    path = _git_inspect(
        checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
        required=False,
    )
    return bool(path and os.path.lexists(path))


def _validate_branch(checkout: Path, branch: str) -> None:
    if (
        branch.startswith("-")
        or _git_inspect(checkout, "check-ref-format", "--branch", branch, required=False) is None
    ):
        raise SourceCheckoutError(f"Invalid followed branch name: {branch}")


def _external_checkout_filter(checkout: Path, revision: str) -> bool:
    configured = _git_mutate(
        checkout,
        "config",
        "--local",
        "--get-regexp",
        r"^filter\..*\.(clean|smudge|process)$",
    )
    if configured.returncode != 0 or not configured.stdout.strip():
        return False
    paths = _git_inspect(checkout, "ls-tree", "-r", "--name-only", revision)
    for path in paths.splitlines() if paths else ():
        if path == ".gitattributes" or path.endswith("/.gitattributes"):
            attributes = _git_inspect(checkout, "show", f"{revision}:{path}", required=False)
            if attributes is None:
                return True
            if any(
                "filter" in line.split("#", 1)[0].split()[1:]
                or any(token.startswith("filter=") for token in line.split("#", 1)[0].split()[1:])
                for line in attributes.splitlines()
            ):
                return True
    return False


def _git_mutate(
    checkout: Path, *arguments: str, credentials: bool = False
) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("git", path=os.defpath)
    if executable is None:
        raise SourceCheckoutError("System Git is not available")
    environment = _clone_environment()
    if not credentials:
        environment.update(
            {
                "GCM_INTERACTIVE": "Never",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "HOME": os.devnull,
                "XDG_CONFIG_HOME": os.devnull,
            }
        )
    command = [
        executable,
        "--no-pager",
        "--no-replace-objects",
        "--no-optional-locks",
        "-c",
        f"core.hooksPath={os.devnull}",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.sshCommand=ssh",
        "-c",
        "core.gitProxy=",
        "-c",
        "submodule.recurse=false",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "remote.origin.uploadpack=git-upload-pack",
        "-C",
        str(checkout.resolve()),
        *arguments,
    ]
    try:
        return subprocess.run(
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as error:
        raise SourceCheckoutError(f"Git operation failed: {error}") from error


def clone_checkout(
    workspace: Path,
    state_directory: Path,
    source_id: str,
    remote: str,
    revision: str | None = None,
    checkout_branch: str | None = None,
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
        _git_clone(source_id, remote, temporary, template, checkout_branch)
        status = inspect_checkout(temporary)
        if checkout_branch is not None:
            verify_checkout_branch(temporary, checkout_branch)
        elif revision is not None:
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


def verify_checkout_branch(checkout: Path, branch: str) -> None:
    _validate_branch(checkout, branch)
    _git_inspect(
        checkout,
        "rev-parse",
        "--verify",
        f"refs/heads/{branch}^{{commit}}",
        context=f"{checkout}: configured followed branch is unavailable",
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


def _git_clone(
    source_id: str,
    remote: str,
    target: Path,
    template: Path,
    checkout_branch: str | None,
) -> None:
    executable = shutil.which("git", path=os.defpath)
    if executable is None:
        raise SourceCheckoutError("System Git is not available")
    environment = _clone_environment()
    command = [
        executable,
        "-c",
        f"core.hooksPath={os.devnull}",
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
    checkout_prefix = [
        executable,
        "-c",
        f"core.hooksPath={os.devnull}",
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
    if checkout_branch is not None:
        branch_check = subprocess.run(
            [executable, "check-ref-format", "--branch", checkout_branch],
            check=False,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            env=checkout_environment,
        )
        if checkout_branch.startswith("-") or branch_check.returncode:
            raise SourceCheckoutError(f"Invalid followed branch name: {checkout_branch}")
    _run_clone_operation(source_id, command, environment)
    checkout = checkout_prefix
    if checkout_branch is not None:
        remote_ref = f"refs/remotes/origin/{checkout_branch}"
        if (
            _git_inspect(
                target, "rev-parse", "--verify", f"{remote_ref}^{{commit}}", required=False
            )
            is None
        ):
            raise SourceCheckoutError(
                f"Source {source_id} clone failed: remote branch origin/{checkout_branch} is unavailable"
            )
        local_ref = f"refs/heads/{checkout_branch}"
        if _git_inspect(target, "rev-parse", "--verify", f"{local_ref}^{{commit}}", required=False):
            checkout.append(checkout_branch)
        else:
            checkout.extend(["--track", "-b", checkout_branch, remote_ref])
    _run_clone_operation(source_id, checkout, checkout_environment)


def _run_clone_operation(source_id: str, command: list[str], environment: dict[str, str]) -> None:
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
