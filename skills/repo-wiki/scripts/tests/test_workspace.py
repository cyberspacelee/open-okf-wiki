import pathlib
import subprocess
import pytest
import _workspace
from _workspace import WorkspaceError


def make_git_repo(path: pathlib.Path) -> pathlib.Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", str(path)], capture_output=True, check=True)
    return path


# --- load: implicit workspace ---

def test_load_implicit(tmp_path):
    make_git_repo(tmp_path)
    ws = _workspace.load(tmp_path)
    assert ws.implicit is True
    assert ws.language == "en"
    assert "self" in ws.sources
    assert ws.sources["self"].origin == "self"
    assert ws.sources["self"].path == tmp_path


def test_load_no_git_no_config_raises(tmp_path):
    with pytest.raises(WorkspaceError):
        _workspace.load(tmp_path)


# --- init ---

def test_init_creates_config(tmp_path):
    ws = _workspace.init(tmp_path, language="zh")
    assert ws.implicit is False
    assert ws.language == "zh"
    assert ws.sources == {}
    config = tmp_path / ".okf-wiki" / "workspace.json"
    assert config.exists()


def test_init_idempotent_raises(tmp_path):
    _workspace.init(tmp_path)
    with pytest.raises(WorkspaceError):
        _workspace.init(tmp_path)


# --- add_source: link ---

def test_add_link(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    _workspace.init(ws_root)
    src = _workspace.add_source(ws_root, str(other), name="other")
    assert src.origin == "link"
    assert src.path == other.resolve()
    assert src.name == "other"


def test_add_link_reloads(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    _workspace.init(ws_root)
    _workspace.add_source(ws_root, str(other), name="other")
    ws = _workspace.load(ws_root)
    assert "other" in ws.sources


def test_add_link_non_git_raises(tmp_path):
    ws_root = tmp_path / "ws"
    plain = tmp_path / "plain"
    plain.mkdir()
    _workspace.init(ws_root)
    with pytest.raises(WorkspaceError):
        _workspace.add_source(ws_root, str(plain), name="plain")


def test_add_source_duplicate_name_raises(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    _workspace.init(ws_root)
    _workspace.add_source(ws_root, str(other), name="repo")
    other2 = tmp_path / "other2"
    make_git_repo(other2)
    with pytest.raises(WorkspaceError):
        _workspace.add_source(ws_root, str(other2), name="repo")


def test_add_source_invalid_name_raises(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    _workspace.init(ws_root)
    with pytest.raises(WorkspaceError):
        _workspace.add_source(ws_root, str(other), name="Bad_Name!")


# --- add_source: clone (file:// avoids network) ---

def test_add_clone(tmp_path):
    ws_root = tmp_path / "ws"
    origin = tmp_path / "origin_repo"
    make_git_repo(origin)
    _workspace.init(ws_root)
    src = _workspace.add_source(ws_root, f"file://{origin}", name="cloned")
    assert src.origin == "clone"
    assert (ws_root / ".okf-wiki" / "sources" / "cloned").is_dir()


def test_add_clone_appears_after_load(tmp_path):
    ws_root = tmp_path / "ws"
    origin = tmp_path / "origin_repo"
    make_git_repo(origin)
    _workspace.init(ws_root)
    _workspace.add_source(ws_root, f"file://{origin}", name="cloned")
    ws = _workspace.load(ws_root)
    assert "cloned" in ws.sources
    assert ws.sources["cloned"].origin == "clone"


# --- load: missing link target ---

def test_load_missing_link_target_raises(tmp_path):
    ws_root = tmp_path / "ws"
    _workspace.init(ws_root)
    import json
    config = ws_root / ".okf-wiki" / "workspace.json"
    data = json.loads(config.read_text())
    data["sources"].append({"name": "gone", "origin": "link", "target": "/nonexistent/path/xyz"})
    config.write_text(json.dumps(data))
    with pytest.raises(WorkspaceError):
        _workspace.load(ws_root)


# --- resolve_locator ---

def test_resolve_locator_implicit_no_prefix(tmp_path):
    make_git_repo(tmp_path)
    (tmp_path / "foo.py").write_text("x=1")
    ws = _workspace.load(tmp_path)
    result = ws.resolve_locator("foo.py")
    assert result == (tmp_path / "foo.py").resolve()


def test_resolve_locator_implicit_with_anchor(tmp_path):
    make_git_repo(tmp_path)
    (tmp_path / "foo.py").write_text("x=1")
    ws = _workspace.load(tmp_path)
    result = ws.resolve_locator("foo.py#L12")
    assert result == (tmp_path / "foo.py").resolve()


def test_resolve_locator_explicit_with_prefix(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    (other / "main.ts").write_text("export {}")
    _workspace.init(ws_root)
    _workspace.add_source(ws_root, str(other), name="api")
    ws = _workspace.load(ws_root)
    result = ws.resolve_locator("api/main.ts")
    assert result == (other / "main.ts").resolve()


def test_resolve_locator_explicit_with_anchor(tmp_path):
    ws_root = tmp_path / "ws"
    other = tmp_path / "other_repo"
    make_git_repo(other)
    (other / "src.py").write_text("")
    _workspace.init(ws_root)
    _workspace.add_source(ws_root, str(other), name="lib")
    ws = _workspace.load(ws_root)
    result = ws.resolve_locator("lib/src.py#L5")
    assert result == (other / "src.py").resolve()


def test_resolve_locator_path_escape_rejected(tmp_path):
    make_git_repo(tmp_path)
    ws = _workspace.load(tmp_path)
    result = ws.resolve_locator("../outside.py")
    assert result is None


def test_resolve_locator_unknown_source_returns_none(tmp_path):
    ws_root = tmp_path / "ws"
    _workspace.init(ws_root)
    ws = _workspace.load(ws_root)
    result = ws.resolve_locator("nonexistent/file.py")
    assert result is None
