import json
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
            "ownership": "linked",
            "checkout": str(source),
            "remote": str(remote),
            "branch": git(source, "branch", "--show-current"),
            "commit": revision,
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
    assert "secret" not in " ".join(clone_command)


def test_duplicate_source_ids_and_invalid_linked_repositories_are_rejected(tmp_path: Path) -> None:
    source = tmp_path / "source"
    make_source(source)
    app = WorkspaceApplication(tmp_path / "workspace")
    app.initialize("catalog")
    app.link_source({"id": "docs", "role": "documentation", "checkout": str(source)})

    with pytest.raises(WorkspaceError, match="already exists"):
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
    with pytest.raises(WorkspaceError, match="configuration update failed"):
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
