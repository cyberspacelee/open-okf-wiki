import json
import hashlib
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import okf_wiki.source_checkouts as source_checkouts_module
import okf_wiki.workspace as workspace_module
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


def git(path: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def make_source(path: Path, *, bare_remote: Path | None = None) -> str:
    path.mkdir()
    git(path, "init", "-q")
    git(path, "config", "user.name", "Test")
    git(path, "config", "user.email", "test@example.com")
    (path / "README.md").write_text("Source knowledge.\n", encoding="utf-8")
    git(path, "add", "README.md")
    git(path, "commit", "-qm", "source")
    if bare_remote is not None:
        subprocess.run(["git", "init", "--bare", "-q", bare_remote], check=True)
        git(path, "remote", "add", "origin", str(bare_remote))
        git(path, "push", "-qu", "origin", "HEAD")
    return git(path, "rev-parse", "HEAD")


def cli(command: list[str], cwd: Path, expected: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", *command],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == expected, result.stderr or result.stdout
    return json.loads(result.stdout)


def test_linked_source_is_registered_in_place_and_reports_local_git_state(tmp_path: Path) -> None:
    source = tmp_path / "existing"
    remote = tmp_path / "remote.git"
    revision = make_source(source, bare_remote=remote)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")

    linked = app.link_source(
        {"id": "requirements", "role": "requirements", "checkout": str(source)}
    )

    assert source.is_dir()
    assert linked["sources"] == [
        {
            "id": "requirements",
            "role": "requirements",
            "revision": git(source, "branch", "--show-current"),
            "revision_policy": "follow_branch",
            "ownership": "linked",
            "checkout": str(source),
            "remote": str(remote),
            "branch": git(source, "branch", "--show-current"),
            "commit": revision,
            "local_commit": revision,
            "remote_commit": revision,
            "dirty": False,
            "ahead": 0,
            "behind": 0,
            "error": None,
        }
    ]
    assert app.sources() == linked
    assert WorkspaceApplication(workspace).sources() == linked

    (source / "untracked.txt").write_text("local\n", encoding="utf-8")
    assert app.sources()["sources"][0]["dirty"] is True
    (source / "untracked.txt").unlink()

    peer = tmp_path / "peer"
    subprocess.run(["git", "clone", "-q", remote, peer], check=True)
    git(peer, "config", "user.name", "Peer")
    git(peer, "config", "user.email", "peer@example.com")
    (peer / "REMOTE.md").write_text("remote\n", encoding="utf-8")
    git(peer, "add", "REMOTE.md")
    git(peer, "commit", "-qm", "remote")
    git(peer, "push", "-q")
    git(source, "fetch", "-q", "origin")
    (source / "LOCAL.md").write_text("local\n", encoding="utf-8")
    git(source, "add", "LOCAL.md")
    git(source, "commit", "-qm", "local")

    diverged = app.sources()["sources"][0]
    assert (diverged["ahead"], diverged["behind"], diverged["dirty"]) == (1, 1, False)


def test_managed_clone_uses_workspace_path_without_running_template_hooks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    revision = make_source(origin)
    hook_output = tmp_path / "hook-ran"
    template = tmp_path / "template"
    hooks = template / "hooks"
    hooks.mkdir(parents=True)
    post_checkout = hooks / "post-checkout"
    post_checkout.write_text(f"#!/bin/sh\ntouch {hook_output}\n", encoding="utf-8")
    post_checkout.chmod(0o755)
    monkeypatch.setenv("GIT_TEMPLATE_DIR", str(template))
    monkeypatch.setenv("SSH_AUTH_SOCK", str(tmp_path / "agent.sock"))

    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    cloned = app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})

    checkout = workspace / "sources" / "code"
    assert checkout.is_dir()
    assert not hook_output.exists()
    assert cloned["sources"][0]["checkout"] == str(checkout)
    assert cloned["sources"][0]["ownership"] == "managed"
    assert cloned["sources"][0]["commit"] == revision
    assert app.settings()["local_settings"]["managed_checkouts"]["code"]["path"] == str(checkout)
    assert not list((workspace / "sources").glob(".code.clone-*"))


def test_managed_clone_does_not_run_repository_selected_global_filters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    (origin / ".gitattributes").write_text("README.md filter=evil\n", encoding="utf-8")
    git(origin, "add", ".gitattributes")
    git(origin, "commit", "-qm", "select filter")
    marker = tmp_path / "FILTER_EXECUTED"
    filter_program = tmp_path / "filter.sh"
    filter_program.write_text(
        f"#!/bin/sh\ntouch '{marker}'\ncat\n",
        encoding="utf-8",
    )
    filter_program.chmod(0o755)
    global_config = tmp_path / "user.gitconfig"
    global_config.write_text(
        f'[filter "evil"]\n\tsmudge = {filter_program}\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")

    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})

    assert not marker.exists()
    assert (tmp_path / "workspace" / "sources" / "code" / "README.md").is_file()


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"id": "../escape", "role": "implementation", "remote": "/tmp/source"}, "id"),
        ({"id": "code", "role": "", "remote": "/tmp/source"}, "role"),
        ({"id": "code", "role": "unsupported", "remote": "/tmp/source"}, "role"),
        (
            {"id": "code", "role": "implementation", "remote": "ext::sh -c touch /tmp/pwn"},
            "remote",
        ),
        ({"id": "code", "role": "implementation", "remote": "--upload-pack=evil"}, "remote"),
        (
            {
                "id": "code",
                "role": "implementation",
                "remote": "https://alice:secret@example.test/source.git",
            },
            "remote",
        ),
    ],
)
def test_clone_rejects_unsafe_source_identity_role_and_remote(
    tmp_path: Path, payload: dict, message: str
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")

    with pytest.raises(WorkspaceError, match=message) as captured:
        app.clone_source(payload)

    assert "secret" not in str(captured.value)
    assert app.sources()["sources"] == []
    assert not (tmp_path / "sources" / "code").exists()


def test_clone_delegates_user_credentials_while_removing_git_config_injection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    global_config = tmp_path / "user.gitconfig"
    global_config.write_text("[credential]\n\thelper = store\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("SSH_AUTH_SOCK", str(tmp_path / "agent.sock"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.hooksPath")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", str(tmp_path / "hostile-hooks"))
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "hostile-git-dir"))
    monkeypatch.setenv("GIT_EXEC_PATH", str(tmp_path / "hostile-exec"))
    monkeypatch.setenv("LD_PRELOAD", str(tmp_path / "hostile.so"))
    monkeypatch.setenv("DYLD_INSERT_LIBRARIES", str(tmp_path / "hostile.dylib"))
    monkeypatch.setenv("OKF_GATEWAY_API_KEY", "unrelated-secret")
    real_run = source_checkouts_module.subprocess.run
    observed: list[tuple[list[str], dict[str, str]]] = []

    def spy(command, *args, **kwargs):
        observed.append((list(command), dict(kwargs["env"])))
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(source_checkouts_module.subprocess, "run", spy)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})

    clone_command, environment = next(
        (command, environment) for command, environment in observed if "clone" in command
    )
    assert environment["HOME"] == str(tmp_path / "home")
    assert environment["SSH_AUTH_SOCK"] == str(tmp_path / "agent.sock")
    assert environment["GIT_CONFIG_GLOBAL"] == str(global_config)
    assert "GIT_CONFIG_COUNT" not in environment
    assert "GIT_CONFIG_KEY_0" not in environment
    assert "GIT_CONFIG_VALUE_0" not in environment
    assert "GIT_DIR" not in environment
    assert "GIT_EXEC_PATH" not in environment
    assert "LD_PRELOAD" not in environment
    assert "DYLD_INSERT_LIBRARIES" not in environment
    assert "OKF_GATEWAY_API_KEY" not in environment
    assert environment["PATH"] == os.defpath
    assert "secret" not in " ".join(clone_command)


def test_clone_helper_cannot_read_unrelated_process_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    helpers = tmp_path / "helpers"
    helpers.mkdir()
    leak = tmp_path / "leak"
    helper = helpers / "git-remote-https"
    helper.write_text(
        f'#!/bin/sh\nprintf "%s" "$OKF_GATEWAY_API_KEY" > "{leak}"\nexit 1\n',
        encoding="utf-8",
    )
    helper.chmod(0o755)
    monkeypatch.setenv("PATH", f"{helpers}:{os.defpath}")
    monkeypatch.setenv("GIT_EXEC_PATH", str(helpers))
    monkeypatch.setenv("OKF_GATEWAY_API_KEY", "must-not-leak")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")

    with pytest.raises(WorkspaceError) as captured:
        app.clone_source(
            {
                "id": "code",
                "role": "implementation",
                "remote": "https://127.0.0.1:1/source.git",
            }
        )

    assert not leak.exists()
    assert "must-not-leak" not in str(captured.value)


def test_duplicate_source_ids_and_invalid_linked_repositories_are_rejected(tmp_path: Path) -> None:
    source = tmp_path / "source"
    make_source(source)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "docs", "role": "documentation", "checkout": str(source)})

    with pytest.raises(WorkspaceError, match="already has a checkout"):
        app.link_source({"id": "docs", "role": "documentation", "checkout": str(source)})
    with pytest.raises(WorkspaceError, match="usable Git working tree"):
        app.link_source({"id": "other", "role": "contract", "checkout": str(tmp_path)})


def test_removal_never_deletes_linked_or_managed_checkout_and_managed_delete_is_separate(
    tmp_path: Path,
) -> None:
    linked = tmp_path / "linked"
    origin = tmp_path / "origin"
    make_source(linked)
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.link_source({"id": "docs", "role": "documentation", "checkout": str(linked)})
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    managed = workspace / "sources" / "code"

    app.remove_source({"id": "docs"})
    app.remove_source({"id": "code"})

    assert linked.is_dir()
    assert managed.is_dir()
    assert app.sources()["sources"] == []
    with pytest.raises(WorkspaceError, match="confirmation"):
        app.delete_managed_source({"id": "code", "confirmation": "wrong"})
    with pytest.raises(WorkspaceError, match="not a managed checkout"):
        app.delete_managed_source({"id": "docs", "confirmation": "docs"})

    deleted = app.delete_managed_source({"id": "code", "confirmation": "code"})

    assert deleted["deleted"] == "code"
    assert not managed.exists()
    assert linked.is_dir()
    assert app.settings()["local_settings"]["managed_checkouts"] == {}


def test_managed_delete_refuses_symlinked_replaced_and_still_configured_paths(
    tmp_path: Path,
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})

    with pytest.raises(WorkspaceError, match="Remove.*configuration first"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})
    app.remove_source({"id": "code"})
    managed = workspace / "sources" / "code"
    moved = workspace / "sources" / "moved"
    managed.rename(moved)
    managed.symlink_to(moved, target_is_directory=True)
    with pytest.raises(WorkspaceError, match="symlink"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})
    managed.unlink()
    managed.mkdir()
    with pytest.raises(WorkspaceError, match="ownership"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})
    assert managed.is_dir()
    assert moved.is_dir()


def test_managed_delete_quarantines_and_refuses_a_directory_swapped_after_fstat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    target = workspace / "sources" / "code"
    original = workspace / "sources" / "original"
    replacement = workspace / "sources" / "replacement"
    replacement.mkdir()
    (replacement / "keep.txt").write_text("external\n", encoding="utf-8")
    real_rename = source_checkouts_module.os.rename
    swapped = False

    def swap_then_rename(source, destination, *args, **kwargs):
        nonlocal swapped
        if source == "code" and not swapped:
            swapped = True
            real_rename(target, original)
            real_rename(replacement, target)
        return real_rename(source, destination, *args, **kwargs)

    monkeypatch.setattr(source_checkouts_module.os, "rename", swap_then_rename)

    with pytest.raises(WorkspaceError, match="ownership"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})

    assert (target / "keep.txt").read_text(encoding="utf-8") == "external\n"
    assert original.is_dir()
    assert "code" in app.settings()["local_settings"]["managed_checkouts"]


def test_managed_delete_does_not_follow_a_replaced_quarantine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    sources = workspace / "sources"
    target = sources / "code"
    inode = target.stat().st_ino
    displaced = sources / "displaced"
    replacement = sources / "replacement"
    replacement.mkdir()
    (replacement / "KEEP.txt").write_text("external\n", encoding="utf-8")
    real_scandir = source_checkouts_module.os.scandir
    real_rename = source_checkouts_module.os.rename
    swapped = False

    def swap_before_recursive_delete(path):
        nonlocal swapped
        if isinstance(path, int) and os.fstat(path).st_ino == inode and not swapped:
            swapped = True
            with real_scandir(sources) as entries:
                quarantine = next(
                    entry.name for entry in entries if entry.name.startswith(".code.delete-")
                )
            real_rename(sources / quarantine, displaced)
            real_rename(replacement, sources / quarantine)
        return real_scandir(path)

    monkeypatch.setattr(source_checkouts_module.os, "scandir", swap_before_recursive_delete)

    with pytest.raises(WorkspaceError, match="changed during deletion"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})

    quarantines = list(sources.glob(".code.delete-*"))
    assert len(quarantines) == 1
    assert (quarantines[0] / "KEEP.txt").read_text(encoding="utf-8") == "external\n"
    assert "code" in app.settings()["local_settings"]["managed_checkouts"]


def test_managed_delete_quarantines_a_replaced_child_before_unlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    replacement = tmp_path / "replacement.txt"
    replacement.write_text("external\n", encoding="utf-8")
    real_rename = source_checkouts_module.os.rename
    swapped = False

    def swap_before_quarantine(source, destination, *args, **kwargs):
        nonlocal swapped
        if source == "README.md" and str(destination).startswith(".delete-") and not swapped:
            swapped = True
            descriptor = kwargs["src_dir_fd"]
            real_rename(
                "README.md",
                "README.original",
                src_dir_fd=descriptor,
                dst_dir_fd=descriptor,
            )
            real_rename(replacement, "README.md", dst_dir_fd=descriptor)
        return real_rename(source, destination, *args, **kwargs)

    monkeypatch.setattr(source_checkouts_module.os, "rename", swap_before_quarantine)

    with pytest.raises(WorkspaceError, match="changed during deletion"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})

    quarantined = list((workspace / "sources").glob(".code.delete-*/.delete-*"))
    assert any(path.read_text(encoding="utf-8") == "external\n" for path in quarantined)
    assert "code" in app.settings()["local_settings"]["managed_checkouts"]


def test_mount_detection_is_bound_to_the_open_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = tmp_path / "parent"
    child = parent / "child"
    child.mkdir(parents=True)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    parent_descriptor = os.open(parent, flags)
    child_descriptor = os.open(child, flags)
    monkeypatch.setattr(
        source_checkouts_module,
        "_descriptor_mount_id",
        lambda descriptor: 2 if descriptor == child_descriptor else 1,
    )
    try:
        assert source_checkouts_module._is_mounted_descriptor(child_descriptor, parent_descriptor)
    finally:
        os.close(child_descriptor)
        os.close(parent_descriptor)


def test_mount_detection_fails_closed_without_mount_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = tmp_path / "parent"
    child = parent / "child"
    child.mkdir(parents=True)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    parent_descriptor = os.open(parent, flags)
    child_descriptor = os.open(child, flags)
    monkeypatch.setattr(source_checkouts_module, "_descriptor_mount_id", lambda _fd: None)
    try:
        assert source_checkouts_module._is_mounted_descriptor(child_descriptor, parent_descriptor)
    finally:
        os.close(child_descriptor)
        os.close(parent_descriptor)


def test_managed_delete_checks_the_sources_root_mount_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    sources_inode = (workspace / "sources").stat().st_ino
    monkeypatch.setattr(
        source_checkouts_module,
        "_descriptor_mount_id",
        lambda descriptor: 2 if os.fstat(descriptor).st_ino == sources_inode else 1,
    )

    with pytest.raises(WorkspaceError, match="Sources root is an external mount"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})

    assert (workspace / "sources" / "code").is_dir()


@pytest.mark.parametrize("mounted", ["sources", "target"])
def test_managed_delete_refuses_managed_root_and_target_mounts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mounted: str
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    target = workspace / "sources" / "code"
    mount = target.parent if mounted == "sources" else target
    real_ismount = source_checkouts_module.os.path.ismount
    monkeypatch.setattr(
        source_checkouts_module.os.path,
        "ismount",
        lambda path: Path(path) == mount or real_ismount(path),
    )

    with pytest.raises(WorkspaceError, match="external mount"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})

    assert target.is_dir()


@pytest.mark.parametrize("ownership", ["linked", "managed"])
def test_status_redacts_an_origin_changed_to_contain_credentials(
    tmp_path: Path, ownership: str
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    if ownership == "managed":
        app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
        checkout = workspace / "sources" / "code"
    else:
        checkout = origin
        app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
        git(checkout, "remote", "add", "origin", "https://example.test/source.git")
    git(
        checkout,
        "remote",
        "set-url",
        "origin",
        "https://alice:secret@example.test/source.git?token=secret",
    )

    inspected = app.sources()["sources"][0]

    assert "secret" not in json.dumps(inspected)
    assert "repair the origin remote" in inspected["error"]


def test_unbound_shared_sources_can_be_cloned_and_linked_without_definition_changes(
    tmp_path: Path,
) -> None:
    managed_origin = tmp_path / "managed-origin"
    linked_checkout = tmp_path / "linked"
    managed_revision = make_source(managed_origin)
    linked_revision = make_source(linked_checkout)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision": managed_revision,
                    "remote": str(managed_origin),
                },
                {
                    "id": "docs",
                    "role": "documentation",
                    "revision": linked_revision,
                    "remote": "https://example.test/docs.git",
                },
            ],
        },
        {"schema_version": 1},
    )
    definition_before = app.settings()["definition"]
    definition_bytes = app.definition_path.read_bytes()

    app.clone_source({"id": "code"})
    app.link_source({"id": "docs", "checkout": str(linked_checkout)})

    current = app.settings()
    assert current["definition"] == definition_before
    assert app.definition_path.read_bytes() == definition_bytes
    assert current["local_settings"]["checkouts"] == {
        "code": str(workspace / "sources" / "code"),
        "docs": str(linked_checkout),
    }
    assert app.sources()["sources"][0]["commit"] == managed_revision
    with pytest.raises(WorkspaceError, match="already has a checkout"):
        app.clone_source({"id": "code"})


def test_configured_clone_rejects_a_remote_missing_the_declared_revision(tmp_path: Path) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision": "f" * 40,
                    "remote": str(origin),
                }
            ],
        },
        {"schema_version": 1},
    )

    with pytest.raises(WorkspaceError, match="configured revision"):
        app.clone_source({"id": "code"})

    assert not (workspace / "sources" / "code").exists()
    assert app.settings()["local_settings"]["checkouts"] == {}


def test_managed_delete_retry_clears_receipt_after_configuration_write_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin"
    make_source(origin)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.clone_source({"id": "code", "role": "implementation", "remote": str(origin)})
    app.remove_source({"id": "code"})
    real_replace = workspace_module._replace_durable
    failed = False

    def fail_once(source: Path, target: Path) -> None:
        nonlocal failed
        if target == app.settings_path and not failed:
            failed = True
            raise OSError("injected receipt write failure")
        real_replace(source, target)

    monkeypatch.setattr(workspace_module, "_replace_durable", fail_once)
    with pytest.raises(WorkspaceError, match="local settings update failed"):
        app.delete_managed_source({"id": "code", "confirmation": "code"})
    assert not (workspace / "sources" / "code").exists()
    assert "code" in app.settings()["local_settings"]["managed_checkouts"]

    app.delete_managed_source({"id": "code", "confirmation": "code"})

    assert app.settings()["local_settings"]["managed_checkouts"] == {}


def test_cli_source_commands_share_the_application_results(tmp_path: Path) -> None:
    source = tmp_path / "source"
    make_source(source)
    workspace = tmp_path / "workspace"
    WorkspaceApplication(workspace).initialize("catalog")

    linked = cli(
        [
            "workspace",
            "link-source",
            "docs",
            "documentation",
            str(source),
            str(workspace),
        ],
        tmp_path,
    )
    listed = cli(["workspace", "sources", str(workspace)], tmp_path)

    assert listed == linked
    assert listed["sources"][0]["ownership"] == "linked"

    configured_workspace = tmp_path / "configured-workspace"
    configured = WorkspaceApplication(configured_workspace)
    configured.initialize("configured")
    revision = git(source, "rev-parse", "HEAD")
    configured.update(
        {
            "schema_version": 1,
            "project": {"id": "configured", "name": "Configured"},
            "sources": [
                {
                    "id": "configured-docs",
                    "role": "documentation",
                    "revision": revision,
                }
            ],
        },
        {"schema_version": 1},
    )
    configured_link = cli(
        [
            "workspace",
            "link-configured-source",
            "configured-docs",
            str(source),
            str(configured_workspace),
        ],
        tmp_path,
    )
    assert configured_link["sources"][0]["ownership"] == "linked"


def test_clone_failure_cleans_only_its_temporary_checkout(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    sources = workspace / "sources"
    sources.mkdir()
    keep = sources / "keep"
    keep.write_text("user data", encoding="utf-8")

    with pytest.raises(WorkspaceError, match="clone failed"):
        app.clone_source(
            {"id": "missing", "role": "implementation", "remote": str(tmp_path / "absent")}
        )

    assert keep.read_text(encoding="utf-8") == "user data"
    assert not (sources / "missing").exists()
    assert not list(sources.glob(".missing.clone-*"))


def test_clone_failure_does_not_echo_untrusted_git_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    monkeypatch.setattr(source_checkouts_module.shutil, "which", lambda *_args, **_kwargs: "git")
    monkeypatch.setattr(
        source_checkouts_module.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            args=[], returncode=17, stdout="", stderr="credential TOKEN-LEAK"
        ),
    )

    with pytest.raises(WorkspaceError, match="status 17") as captured:
        app.clone_source(
            {
                "id": "code",
                "role": "implementation",
                "remote": "https://example.test/source.git",
            }
        )

    assert "TOKEN-LEAK" not in str(captured.value)


def test_clean_pull_advances_followed_branch_and_keeps_a_pinned_commit(
    tmp_path: Path,
) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    git(checkout, "config", "user.name", "Checkout")
    git(checkout, "config", "user.email", "checkout@example.com")
    branch = git(checkout, "branch", "--show-current")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")

    linked = app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})[
        "sources"
    ][0]

    assert linked["revision_policy"] == "follow_branch"
    assert linked["revision"] == branch
    initial = linked["commit"]

    (upstream / "REMOTE.md").write_text("remote one\n", encoding="utf-8")
    git(upstream, "add", "REMOTE.md")
    git(upstream, "commit", "-qm", "remote one")
    git(upstream, "push", "-q")
    advanced = git(upstream, "rev-parse", "HEAD")

    pulled = app.pull_source({"id": "code"})["sources"][0]

    assert pulled["commit"] == pulled["local_commit"] == advanced
    assert pulled["remote_commit"] == advanced
    assert pulled["revision_policy"] == "follow_branch"
    assert pulled["revision"] == branch

    pinned = app.set_source_revision(
        {
            "id": "code",
            "revision_policy": "pinned_commit",
            "revision": initial,
            "configuration_digest": app.sources()["configuration_digest"],
        }
    )["sources"][0]
    assert pinned["revision"] == initial
    pinned_preflight = app.run_preflight()

    (upstream / "REMOTE-2.md").write_text("remote two\n", encoding="utf-8")
    git(upstream, "add", "REMOTE-2.md")
    git(upstream, "commit", "-qm", "remote two")
    git(upstream, "push", "-q")
    latest = git(upstream, "rev-parse", "HEAD")

    pulled_again = app.pull_source({"id": "code"})["sources"][0]

    assert pulled_again["commit"] == latest
    assert pulled_again["revision_policy"] == "pinned_commit"
    assert pulled_again["revision"] == initial
    assert app.run_preflight()["source_set_digest"] == pinned_preflight["source_set_digest"]


def test_managed_checkout_can_pull_a_clean_followed_branch(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    cloned = app.clone_source({"id": "code", "role": "implementation", "remote": str(remote)})
    assert cloned["sources"][0]["ownership"] == "managed"

    (upstream / "REMOTE.md").write_text("remote\n", encoding="utf-8")
    git(upstream, "add", "REMOTE.md")
    git(upstream, "commit", "-qm", "remote")
    git(upstream, "push", "-q")
    latest = git(upstream, "rev-parse", "HEAD")

    pulled = app.pull_source({"id": "code"})["sources"][0]

    assert pulled["ownership"] == "managed"
    assert pulled["commit"] == latest
    assert pulled["revision_policy"] == "follow_branch"


def test_pull_keeps_a_clean_local_commit_when_the_remote_is_behind(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    git(checkout, "config", "user.name", "Checkout")
    git(checkout, "config", "user.email", "checkout@example.com")
    (checkout / "LOCAL.md").write_text("local\n", encoding="utf-8")
    git(checkout, "add", "LOCAL.md")
    git(checkout, "commit", "-qm", "local")
    local = git(checkout, "rev-parse", "HEAD")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})

    pulled = app.pull_source({"id": "code"})["sources"][0]

    assert pulled["commit"] == local
    assert pulled["ahead"] == 1
    assert pulled["behind"] == 0


def test_configured_follow_branch_clone_checks_out_the_exact_remote_branch(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    git(upstream, "checkout", "-qb", "docs")
    (upstream / "DOCS.md").write_text("docs\n", encoding="utf-8")
    git(upstream, "add", "DOCS.md")
    git(upstream, "commit", "-qm", "docs")
    git(upstream, "push", "-qu", "origin", "docs")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "docs",
                    "role": "documentation",
                    "revision_policy": "follow_branch",
                    "revision": "docs",
                    "remote": str(remote),
                }
            ],
        },
        {"schema_version": 1},
    )

    cloned = app.clone_source({"id": "docs"})["sources"][0]

    assert cloned["branch"] == "docs"
    assert cloned["revision"] == "docs"
    assert cloned["commit"] == git(upstream, "rev-parse", "HEAD")


@pytest.mark.parametrize("dirty_state", ["tracked", "staged", "untracked", "ignored", "conflict"])
def test_pull_refuses_each_dirty_checkout_state(tmp_path: Path, dirty_state: str) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    git(checkout, "config", "user.name", "Checkout")
    git(checkout, "config", "user.email", "checkout@example.com")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    before = git(checkout, "rev-parse", "HEAD")

    if dirty_state == "tracked":
        (checkout / "README.md").write_text("tracked\n", encoding="utf-8")
    elif dirty_state == "staged":
        (checkout / "README.md").write_text("staged\n", encoding="utf-8")
        git(checkout, "add", "README.md")
    elif dirty_state == "untracked":
        (checkout / "LOCAL.md").write_text("untracked\n", encoding="utf-8")
    elif dirty_state == "ignored":
        exclude = Path(git(checkout, "rev-parse", "--git-path", "info/exclude"))
        if not exclude.is_absolute():
            exclude = checkout / exclude
        exclude.write_text("IGNORED.md\n", encoding="utf-8")
        (checkout / "IGNORED.md").write_text("ignored\n", encoding="utf-8")
    else:
        (checkout / "README.md").write_text("local\n", encoding="utf-8")
        git(checkout, "commit", "-am", "local")
        (upstream / "README.md").write_text("remote\n", encoding="utf-8")
        git(upstream, "commit", "-am", "remote")
        git(upstream, "push", "-q")
        git(checkout, "fetch", "-q", "origin")
        subprocess.run(
            ["git", "merge", "origin/" + git(checkout, "branch", "--show-current")],
            cwd=checkout,
            check=False,
            capture_output=True,
        )
        before = git(checkout, "rev-parse", "HEAD")

    with pytest.raises(WorkspaceError, match="Pull blocked"):
        app.pull_source({"id": "code"})

    assert git(checkout, "rev-parse", "HEAD") == before


def test_preflight_resolves_exact_tree_and_build_keeps_immutable_source_snapshot(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    remote = tmp_path / "remote.git"
    first = make_source(source, bare_remote=remote)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "docs", "role": "documentation", "checkout": str(source)})
    tree = subprocess.run(
        ["git", "ls-tree", "-r", "--full-tree", "-z", first],
        cwd=source,
        check=True,
        capture_output=True,
    ).stdout

    preflight = app.run_preflight()

    assert preflight["sources"] == [
        {
            "id": "docs",
            "role": "documentation",
            "revision_policy": "follow_branch",
            "revision": git(source, "branch", "--show-current"),
            "local_commit": first,
            "remote_commit": first,
            "exact_commit": first,
            "tree_digest": hashlib.sha256(tree).hexdigest(),
        }
    ]

    built = cli(["build", "workspace.toml"], app.root)
    (source / "LATER.md").write_text("later\n", encoding="utf-8")
    git(source, "add", "LATER.md")
    git(source, "commit", "-qm", "later")
    later = git(source, "rev-parse", "HEAD")

    with sqlite3.connect(app.database_path) as connection:
        source_set = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (built["run_id"],)
            ).fetchone()[0]
        )

    assert source_set["sources"][0]["revision"] == first
    assert source_set["sources"][0]["revision"] != later
    assert source_set["digest"] == preflight["source_set_digest"]
    assert source_set["workspace_configuration"]["source_snapshots"] == preflight["sources"]


def test_revision_policy_errors_do_not_change_shared_configuration(tmp_path: Path) -> None:
    source = tmp_path / "source"
    make_source(source)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(source)})
    before = app.settings()["definition"]
    digest = app.sources()["configuration_digest"]

    with pytest.raises(WorkspaceError, match="complete Git commit ID"):
        app.set_source_revision(
            {
                "id": "code",
                "revision_policy": "pinned_commit",
                "revision": "abc123",
                "configuration_digest": digest,
            }
        )
    with pytest.raises(WorkspaceError, match="Pinned Commit is unavailable"):
        app.set_source_revision(
            {
                "id": "code",
                "revision_policy": "pinned_commit",
                "revision": "d" * 40,
                "configuration_digest": digest,
            }
        )
    with pytest.raises(WorkspaceError, match="unavailable locally"):
        app.set_source_revision(
            {
                "id": "code",
                "revision_policy": "follow_branch",
                "revision": "missing-branch",
                "configuration_digest": digest,
            }
        )

    assert app.settings()["definition"] == before


def test_pull_reports_a_deleted_remote_without_changing_checkout_or_policy(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    before_commit = git(checkout, "rev-parse", "HEAD")
    before_definition = app.settings()["definition"]
    remote.rename(tmp_path / "deleted-remote.git")

    with pytest.raises(WorkspaceError, match="verify the branch, remote, and your Git credentials"):
        app.pull_source({"id": "code"})

    assert git(checkout, "rev-parse", "HEAD") == before_commit
    assert app.settings()["definition"] == before_definition


def test_follow_branch_never_resolves_a_same_named_tag(tmp_path: Path) -> None:
    origin = tmp_path / "origin"
    revision = make_source(origin)
    git(origin, "tag", "release", revision)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision_policy": "follow_branch",
                    "revision": "release",
                    "remote": str(origin),
                }
            ],
        },
        {"schema_version": 1},
    )

    with pytest.raises(WorkspaceError, match="(?i)followed branch .* unavailable"):
        app.link_source({"id": "code", "checkout": str(origin)})
    with pytest.raises(WorkspaceError, match="remote branch origin/release is unavailable"):
        app.clone_source({"id": "code"})

    assert app.sources()["sources"][0]["ownership"] is None


def test_legacy_named_revision_is_inferred_as_follow_branch(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_source(source)
    branch = git(source, "branch", "--show-current")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [{"id": "code", "role": "implementation", "revision": branch}],
        },
        {"schema_version": 1, "checkouts": {"code": str(source)}},
    )

    listed = app.sources()["sources"][0]
    preflight = app.run_preflight()["sources"][0]

    assert listed["revision_policy"] == "follow_branch"
    assert preflight["exact_commit"] == revision


def test_pull_refuses_detached_unfinished_and_non_fast_forward_states(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    git(checkout, "config", "user.name", "Checkout")
    git(checkout, "config", "user.email", "checkout@example.com")
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    definition = app.settings()["definition"]

    git(checkout, "checkout", "--detach", "-q")
    with pytest.raises(WorkspaceError, match="detached"):
        app.pull_source({"id": "code"})
    branch = definition["sources"][0]["revision"]
    git(checkout, "checkout", "-q", branch)

    git_path = Path(git(checkout, "rev-parse", "--git-path", "rebase-apply"))
    if not git_path.is_absolute():
        git_path = checkout / git_path
    git_path.mkdir(parents=True)
    with pytest.raises(WorkspaceError, match="unfinished Git operation"):
        app.pull_source({"id": "code"})
    git_path.rmdir()

    (checkout / "LOCAL.md").write_text("local\n", encoding="utf-8")
    git(checkout, "add", "LOCAL.md")
    git(checkout, "commit", "-qm", "local")
    local = git(checkout, "rev-parse", "HEAD")
    (upstream / "REMOTE.md").write_text("remote\n", encoding="utf-8")
    git(upstream, "add", "REMOTE.md")
    git(upstream, "commit", "-qm", "remote")
    git(upstream, "push", "-q")

    with pytest.raises(WorkspaceError, match="not a fast-forward"):
        app.pull_source({"id": "code"})

    assert git(checkout, "rev-parse", "HEAD") == local
    assert app.settings()["definition"] == definition


def test_pull_disables_hooks_and_blocks_repository_selected_local_filters(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    hook_marker = tmp_path / "HOOK_RAN"
    hook = Path(git(checkout, "rev-parse", "--git-path", "hooks/post-merge"))
    if not hook.is_absolute():
        hook = checkout / hook
    hook.write_text(f"#!/bin/sh\ntouch '{hook_marker}'\n", encoding="utf-8")
    hook.chmod(0o755)
    (upstream / "SAFE.md").write_text("safe\n", encoding="utf-8")
    git(upstream, "add", "SAFE.md")
    git(upstream, "commit", "-qm", "safe update")
    git(upstream, "push", "-q")

    app.pull_source({"id": "code"})

    assert not hook_marker.exists()

    filter_marker = tmp_path / "FILTER_RAN"
    filter_program = tmp_path / "filter.sh"
    filter_program.write_text(f"#!/bin/sh\ntouch '{filter_marker}'\ncat\n", encoding="utf-8")
    filter_program.chmod(0o755)
    filter_config = tmp_path / "checkout-filter.gitconfig"
    filter_config.write_text(f'[filter "evil"]\n\tsmudge = {filter_program}\n', encoding="utf-8")
    git(checkout, "config", "include.path", str(filter_config))
    (upstream / ".gitattributes").write_text("README.md filter=evil\n", encoding="utf-8")
    (upstream / "README.md").write_text("filtered\n", encoding="utf-8")
    git(upstream, "add", ".gitattributes", "README.md")
    git(upstream, "commit", "-qm", "select filter")
    git(upstream, "push", "-q")
    before = git(checkout, "rev-parse", "HEAD")

    with pytest.raises(WorkspaceError, match="executable filter"):
        app.pull_source({"id": "code"})

    assert git(checkout, "rev-parse", "HEAD") == before
    assert not filter_marker.exists()


def test_pull_delegates_credentials_without_forwarding_unrelated_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    (upstream / "REMOTE.md").write_text("remote\n", encoding="utf-8")
    git(upstream, "add", "REMOTE.md")
    git(upstream, "commit", "-qm", "remote")
    git(upstream, "push", "-q")
    global_config = tmp_path / "user.gitconfig"
    global_config.write_text("[credential]\n\thelper = trusted-test\n", encoding="utf-8")
    git(checkout, "config", "credential.helper", "!malicious-local-helper")
    monkeypatch.setenv("SSH_AUTH_SOCK", str(tmp_path / "agent.sock"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("OKF_GATEWAY_API_KEY", "must-not-leak")
    real_run = source_checkouts_module.subprocess.run
    observed: list[tuple[list[str], dict[str, str]]] = []

    def spy(command, *args, **kwargs):
        observed.append((list(command), dict(kwargs["env"])))
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(source_checkouts_module.subprocess, "run", spy)

    app.pull_source({"id": "code"})

    fetch_command, fetch_environment = next(
        (command, environment) for command, environment in observed if "fetch" in command
    )
    merge_command, merge_environment = next(
        (command, environment) for command, environment in observed if "merge" in command
    )
    assert fetch_environment["SSH_AUTH_SOCK"] == str(tmp_path / "agent.sock")
    assert "OKF_GATEWAY_API_KEY" not in fetch_environment
    assert "OKF_GATEWAY_API_KEY" not in merge_environment
    assert merge_environment["GIT_CONFIG_GLOBAL"] == os.devnull
    assert "protocol.ext.allow=never" in fetch_command
    assert "--no-recurse-submodules" in fetch_command
    assert "credential.helper=" in fetch_command
    assert "credential.helper=trusted-test" in fetch_command
    assert all("malicious-local-helper" not in argument for argument in fetch_command)
    assert "--ff-only" in merge_command
    assert not ({"stash", "reset", "clean", "rebase", "checkout"} & set(merge_command))


def test_pull_refuses_a_branch_switch_at_the_same_commit_during_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    make_source(upstream, bare_remote=remote)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})
    (upstream / "REMOTE.md").write_text("remote\n", encoding="utf-8")
    git(upstream, "add", "REMOTE.md")
    git(upstream, "commit", "-qm", "remote")
    git(upstream, "push", "-q")
    real_mutate = source_checkouts_module._git_mutate
    switched = False

    def switch_after_fetch(path, *arguments, **keywords):
        nonlocal switched
        result = real_mutate(path, *arguments, **keywords)
        if arguments[0] == "fetch" and not switched:
            switched = True
            assert real_mutate(path, "branch", "other", "HEAD").returncode == 0
            assert real_mutate(path, "switch", "other").returncode == 0
        return result

    monkeypatch.setattr(source_checkouts_module, "_git_mutate", switch_after_fetch)

    with pytest.raises(WorkspaceError, match="checked-out branch changed"):
        app.pull_source({"id": "code"})

    assert git(checkout, "branch", "--show-current") == "other"
