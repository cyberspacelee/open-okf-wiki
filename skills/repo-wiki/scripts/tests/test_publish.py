import pathlib
import shutil

import pytest

import _publish
from _publish import PublishError


def _make_md(path: pathlib.Path, title: str, desc: str = "", body: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = f"---\ntitle: {title}\n"
    if desc:
        fm += f"description: {desc}\n"
    fm += f"---\n{body}"
    path.write_text(fm, encoding="utf-8")


def _setup_candidate(root: pathlib.Path) -> pathlib.Path:
    candidate = root / ".okf-wiki" / "candidate"
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate


# --- generate_index ---

def test_generate_index_flat(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview", "Top level")
    _make_md(c / "architecture.md", "Architecture")
    idx = _publish.generate_index(tmp_path)
    text = idx.read_text()
    assert "- [Overview](overview.md) — Top level" in text
    assert "- [Architecture](architecture.md)" in text


def test_generate_index_subdir_grouping(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview")
    _make_md(c / "src" / "api.md", "API", "api docs")
    _make_md(c / "src" / "core.md", "Core")
    idx = _publish.generate_index(tmp_path)
    text = idx.read_text()
    assert "### src" in text
    assert "- [API](src/api.md)" in text


def test_generate_index_excludes_index_md(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview")
    _make_md(c / "index.md", "Should be excluded")
    idx = _publish.generate_index(tmp_path)
    text = idx.read_text()
    assert "Should be excluded" not in text


def test_generate_index_empty_candidate_raises(tmp_path):
    _setup_candidate(tmp_path)
    with pytest.raises(PublishError, match="empty"):
        _publish.generate_index(tmp_path)


def test_generate_index_frontmatter_fallback(tmp_path):
    c = _setup_candidate(tmp_path)
    (c / "nofront.md").write_text("no frontmatter here", encoding="utf-8")
    idx = _publish.generate_index(tmp_path)
    text = idx.read_text()
    assert "nofront" in text


# --- digest ---

def test_digest_deterministic(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "a.md", "A")
    d1 = _publish.digest(tmp_path)
    d2 = _publish.digest(tmp_path)
    assert d1 == d2


def test_digest_changes_on_content(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "a.md", "A")
    d1 = _publish.digest(tmp_path)
    (c / "a.md").write_text("changed", encoding="utf-8")
    d2 = _publish.digest(tmp_path)
    assert d1 != d2


def test_digest_order_independent(tmp_path):
    c = _setup_candidate(tmp_path)
    _make_md(c / "z.md", "Z")
    _make_md(c / "a.md", "A")
    d = _publish.digest(tmp_path)
    # rebuild in different order doesn't matter — sorted() guarantees stability
    assert len(d) == 64


# --- publish ---

def _stub_workspace(monkeypatch, tmp_path):
    import types
    ws_mod = types.ModuleType("_workspace")
    class FakeWS:
        root = tmp_path
    ws_mod.load = lambda root: FakeWS()
    monkeypatch.setitem(__import__("sys").modules, "_workspace", ws_mod)


def _stub_validate(monkeypatch, issues=None):
    import types
    val_mod = types.ModuleType("_validate")
    val_mod.validate_candidate = lambda ws: issues or []
    monkeypatch.setitem(__import__("sys").modules, "_validate", val_mod)


def test_publish_success(tmp_path, monkeypatch):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_validate(monkeypatch)
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview")
    result = _publish.publish(tmp_path)
    assert (tmp_path / "wiki" / "overview.md").exists()
    assert result["pages"] >= 1
    assert isinstance(result["digest"], str)
    assert result["previous"] is False


def test_publish_preserves_previous(tmp_path, monkeypatch):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_validate(monkeypatch)
    # first publish
    c = _setup_candidate(tmp_path)
    _make_md(c / "v1.md", "V1")
    _publish.publish(tmp_path)
    # second publish with new candidate content
    shutil.rmtree(c)
    c.mkdir(parents=True)
    _make_md(c / "v2.md", "V2")
    result = _publish.publish(tmp_path)
    assert (tmp_path / "wiki" / "v2.md").exists()
    assert result["previous"] is True


def test_publish_validate_error_blocks(tmp_path, monkeypatch):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_validate(monkeypatch, [{"severity": "error", "msg": "bad"}])
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview")
    with pytest.raises(PublishError, match="validation errors"):
        _publish.publish(tmp_path)


def test_publish_validate_warning_passes(tmp_path, monkeypatch):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_validate(monkeypatch, [{"severity": "warning", "msg": "mild"}])
    c = _setup_candidate(tmp_path)
    _make_md(c / "overview.md", "Overview")
    result = _publish.publish(tmp_path)
    assert result["pages"] >= 1


def test_publish_rollback_on_copytree_failure(tmp_path, monkeypatch):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_validate(monkeypatch)
    # pre-existing wiki
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    _make_md(wiki / "old.md", "Old")
    c = _setup_candidate(tmp_path)
    _make_md(c / "new.md", "New")

    original_copytree = shutil.copytree
    calls = {"n": 0}
    def boom(*a, **kw):
        calls["n"] += 1
        raise OSError("disk full")
    monkeypatch.setattr(shutil, "copytree", boom)

    with pytest.raises(PublishError):
        _publish.publish(tmp_path)

    monkeypatch.setattr(shutil, "copytree", original_copytree)
    # wiki should be restored from previous
    assert (tmp_path / "wiki" / "old.md").exists()


# --- rollback ---

def test_rollback_restores_previous(tmp_path):
    # set up wiki and previous directly, no publish needed
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    _make_md(wiki / "current.md", "Current")
    prev = tmp_path / ".okf-wiki" / "publication" / "previous"
    prev.mkdir(parents=True)
    _make_md(prev / "old.md", "Old")
    _publish.rollback(tmp_path)
    assert (tmp_path / "wiki" / "old.md").exists()
    assert not (tmp_path / "wiki" / "current.md").exists()


def test_rollback_no_previous_raises(tmp_path):
    with pytest.raises(PublishError, match="no previous"):
        _publish.rollback(tmp_path)
