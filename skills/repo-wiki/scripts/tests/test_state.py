import pathlib
import json
import pytest
import _state
from _state import StateError


# --- helpers ---

def make_ws(tmp_path, num_sources=1):
    from unittest.mock import MagicMock
    ws = MagicMock()
    ws.root = tmp_path
    ws.implicit = num_sources == 1
    sources = {f"src{i}": MagicMock() for i in range(num_sources)}
    ws.sources = sources
    return ws


def patch_workspace(monkeypatch, tmp_path, num_sources=1):
    ws = make_ws(tmp_path, num_sources)
    monkeypatch.setattr("_state._load_workspace", lambda root: ws)
    return ws


def patch_validate(monkeypatch, issues=None):
    if issues is None:
        issues = []
    import types
    mod = types.ModuleType("_validate")
    mod.validate_target = lambda ws, phase, target: issues
    monkeypatch.setitem(__import__("sys").modules, "_validate", mod)


def state_path(tmp_path):
    return tmp_path / ".okf-wiki" / "state.json"


# --- init_run ---

def test_init_run_creates_state(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    s = _state.init_run(tmp_path)
    assert s["phase"] == "inspect"
    assert "inspect" in s["phases"]
    assert state_path(tmp_path).exists()


def test_init_run_second_raises(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    with pytest.raises(StateError, match="already in progress"):
        _state.init_run(tmp_path)


def test_init_run_single_source_skips_synthesize(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 1)
    s = _state.init_run(tmp_path)
    assert "synthesize" not in s["phases"]


def test_init_run_multi_source_has_synthesize(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    s = _state.init_run(tmp_path)
    assert "synthesize" in s["phases"]


# --- status ---

def test_status_no_state(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path)
    assert _state.status(tmp_path) == {"run": None}


def test_status_returns_derived_fields(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    s = _state.status(tmp_path)
    assert s["current_phase"] == "inspect"
    assert "next_actions" in s


# --- start_target ---

def test_start_target_registers(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "docs")
    raw = json.loads(state_path(tmp_path).read_text())
    t = raw["phases"]["inspect"]["targets"]["docs"]
    assert t["status"] == "in_progress"
    assert t["attempts"] == 1


def test_start_target_retry_increments_attempts(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "docs")
    _state.fail_target(tmp_path, "inspect", "docs", "oops")
    _state.start_target(tmp_path, "inspect", "docs")
    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phases"]["inspect"]["targets"]["docs"]["attempts"] == 2


def test_start_target_past_phase_raises(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")
    _state.complete_target(tmp_path, "inspect", "x")
    _state.start_target(tmp_path, "survey", "a")  # advances current to survey
    # inspect is now past; a new inspect target must be rejected
    with pytest.raises(StateError):
        _state.start_target(tmp_path, "inspect", "y")


def test_start_synthesize_requires_survey_complete(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    # complete inspect
    _state.start_target(tmp_path, "inspect", "x")
    _state.complete_target(tmp_path, "inspect", "x")
    # start survey but don't complete
    _state.start_target(tmp_path, "survey", "api")
    with pytest.raises(StateError, match="survey"):
        _state.start_target(tmp_path, "synthesize", "merge")


# --- complete_target ---

def test_complete_target_advances_phase(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")
    _state.complete_target(tmp_path, "inspect", "x")
    # phase marked complete but current stays until the next phase opens:
    # late targets may still join the batch
    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phase"] == "inspect"
    assert raw["phases"]["inspect"]["status"] == "complete"
    _state.start_target(tmp_path, "survey", "a")
    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phase"] == "survey"
    assert raw["phases"]["inspect"]["completed_at"]
    assert raw["phases"]["survey"]["started_at"]


def test_complete_target_blocked_by_error(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch, issues=[{"severity": "error", "code": "E001", "message": "bad"}])
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")
    result = _state.complete_target(tmp_path, "inspect", "x")
    assert result["ok"] is False
    assert result["issues"][0]["code"] == "E001"
    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phases"]["inspect"]["targets"]["x"]["status"] == "in_progress"


def test_complete_target_idempotent(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")
    r1 = _state.complete_target(tmp_path, "inspect", "x")
    r2 = _state.complete_target(tmp_path, "inspect", "x")
    assert r1["ok"] is True
    assert r2["ok"] is True


def test_complete_target_atomic_on_exception(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")

    original_replace = __import__("os").replace
    calls = []

    def bad_replace(src, dst):
        calls.append((src, dst))
        raise OSError("simulated disk failure")

    monkeypatch.setattr("os.replace", bad_replace)
    # patch validate inside complete_target
    import types, sys
    mod = types.ModuleType("_validate")
    mod.validate_target = lambda ws, phase, target: []
    monkeypatch.setitem(sys.modules, "_validate", mod)

    with pytest.raises(OSError):
        _state.complete_target(tmp_path, "inspect", "x")

    # original state.json untouched (target still in_progress)
    monkeypatch.setattr("os.replace", original_replace)
    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phases"]["inspect"]["targets"]["x"]["status"] == "in_progress"


# --- full lifecycle ---

def test_full_lifecycle_multi_source(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    phases = ["inspect", "survey", "synthesize", "write", "derive", "review", "publish"]

    _state.init_run(tmp_path)
    for ph in phases:
        _state.start_target(tmp_path, ph, "t1")
        result = _state.complete_target(tmp_path, ph, "t1")
        assert result["ok"] is True

    raw = json.loads(state_path(tmp_path).read_text())
    assert raw["phases"]["publish"]["targets"]["t1"]["status"] == "complete"


def test_full_lifecycle_single_source_skips_synthesize(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 1)
    patch_validate(monkeypatch)
    phases = ["inspect", "survey", "write", "derive", "review", "publish"]

    _state.init_run(tmp_path)
    for ph in phases:
        _state.start_target(tmp_path, ph, "t1")
        result = _state.complete_target(tmp_path, ph, "t1")
        assert result["ok"] is True


# --- write gate (multi-source requires synthesize complete) ---

def test_write_requires_synthesize_in_multi_source(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    patch_validate(monkeypatch)
    _state.init_run(tmp_path)
    # complete inspect and survey
    for ph in ["inspect", "survey"]:
        _state.start_target(tmp_path, ph, "t1")
        _state.complete_target(tmp_path, ph, "t1")
    # start synthesize but don't complete
    _state.start_target(tmp_path, "synthesize", "merge")
    with pytest.raises(StateError, match="synthesize"):
        _state.start_target(tmp_path, "write", "page")


# --- abandon ---

def test_abandon_removes_state(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    assert state_path(tmp_path).exists()
    _state.abandon(tmp_path)
    assert not state_path(tmp_path).exists()


def test_abandon_noop_when_no_state(monkeypatch, tmp_path):
    _state.abandon(tmp_path)  # should not raise


# --- fail_target ---

def test_fail_target(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    _state.start_target(tmp_path, "inspect", "x")
    _state.fail_target(tmp_path, "inspect", "x", "network timeout")
    raw = json.loads(state_path(tmp_path).read_text())
    t = raw["phases"]["inspect"]["targets"]["x"]
    assert t["status"] == "failed"
    assert t["last_error"] == "network timeout"


# --- corrupt state ---

def test_corrupt_state_raises(monkeypatch, tmp_path):
    patch_workspace(monkeypatch, tmp_path, 2)
    _state.init_run(tmp_path)
    state_path(tmp_path).write_text("{broken json")
    with pytest.raises(StateError, match="corrupt"):
        _state.status(tmp_path)
