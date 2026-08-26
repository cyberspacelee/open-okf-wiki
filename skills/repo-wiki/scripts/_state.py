import json
import os
import pathlib
import secrets
import tempfile
from datetime import datetime, timezone

_CONFIG_DIR = ".okf-wiki"
_STATE_FILE = "state.json"
_PHASES = ["inspect", "survey", "synthesize", "write", "derive", "review", "publish"]


class StateError(Exception): ...


def _state_path(root: pathlib.Path) -> pathlib.Path:
    return root / _CONFIG_DIR / _STATE_FILE


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read(root: pathlib.Path) -> dict | None:
    p = _state_path(root)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        raise StateError(f"corrupt state file: {p}")


def _write(root: pathlib.Path, state: dict) -> None:
    p = _state_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_workspace(root: pathlib.Path):
    import _workspace
    return _workspace.load(root)


def _phase_list(root: pathlib.Path) -> list[str]:
    ws = _load_workspace(root)
    if len(ws.sources) == 1:
        return [p for p in _PHASES if p != "synthesize"]
    return list(_PHASES)


def _is_complete(phase_data: dict) -> bool:
    return phase_data.get("status") == "complete"


def _all_targets_complete(phase_data: dict) -> bool:
    targets = phase_data.get("targets", {})
    return bool(targets) and all(t["status"] == "complete" for t in targets.values())


def _make_phase_entry(status: str = "pending") -> dict:
    return {"status": status}


def _derive_status(state: dict, phases: list[str]) -> dict:
    result = dict(state)
    current = state.get("phase")
    result["current_phase"] = current

    for ph in phases:
        pd = state["phases"].get(ph, {})
        targets = pd.get("targets", {})
        counts = {
            "total": len(targets),
            "complete": sum(1 for t in targets.values() if t["status"] == "complete"),
            "failed": sum(1 for t in targets.values() if t["status"] == "failed"),
            "pending": sum(1 for t in targets.values() if t["status"] == "pending"),
            "in_progress": sum(1 for t in targets.values() if t["status"] == "in_progress"),
        }
        result["phases"][ph] = dict(pd) | {"counts": counts}

    actions = []
    if current:
        pd = state["phases"].get(current, {})
        targets = pd.get("targets", {})
        for name, t in targets.items():
            if t["status"] in ("pending", "failed"):
                actions.append(f"Start target '{name}' in phase '{current}'")
            elif t["status"] == "in_progress":
                actions.append(f"Complete or fail target '{name}' in phase '{current}'")
        if not targets:
            actions.append(f"Register targets for phase '{current}'")
    result["next_actions"] = actions
    return result


def init_run(root: pathlib.Path) -> dict:
    existing = _read(root)
    if existing is not None:
        ph = existing.get("phase", "unknown")
        raise StateError(
            f"a run is already in progress (phase={ph}). "
            "Use 'state status' to inspect or 'state abandon' to discard it."
        )
    phases = _phase_list(root)
    first = phases[0]
    phases_data: dict = {}
    for ph in phases:
        phases_data[ph] = _make_phase_entry("pending" if ph != first else "pending")
    run_id = f"r-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(3)}"
    state = {
        "version": 1,
        "run_id": run_id,
        "started_at": _now(),
        "phase": first,
        "phases": phases_data,
    }
    _write(root, state)
    return state


def status(root: pathlib.Path) -> dict:
    state = _read(root)
    if state is None:
        return {"run": None}
    phases = _phase_list(root)
    return _derive_status(state, phases)


def start_target(root: pathlib.Path, phase: str, target: str) -> dict:
    state = _read(root)
    if state is None:
        raise StateError("no active run; call init_run first")
    phases = _phase_list(root)
    current = state["phase"]

    if phase not in phases:
        raise StateError(f"unknown phase '{phase}'")

    phase_idx = phases.index(phase)
    current_idx = phases.index(current)

    if phase_idx < current_idx:
        raise StateError(f"phase '{phase}' is already past (current={current})")

    if phase_idx > current_idx:
        # Can only advance one phase at a time; all preceding phases must be complete
        for prev in phases[:phase_idx]:
            prev_data = state["phases"].get(prev, {})
            if prev_data.get("status") != "complete":
                raise StateError(
                    f"cannot start phase '{phase}': phase '{prev}' is not complete"
                )
        # Advance current phase
        state["phase"] = phase
        current = phase

    pd = state["phases"].setdefault(phase, {"status": "pending"})
    # Reopen a phase marked complete: a new target joins the batch.
    if phase_idx == current_idx and pd.get("status") == "complete":
        pd["status"] = "in_progress"

    # Validate synthesize gate
    if phase == "synthesize":
        survey_data = state["phases"].get("survey", {})
        if not _all_targets_complete(survey_data):
            raise StateError("cannot start 'synthesize': not all 'survey' targets are complete")

    # Validate write gate (multi-source)
    if phase == "write" and "synthesize" in phases:
        synth_data = state["phases"].get("synthesize", {})
        if synth_data.get("status") != "complete":
            raise StateError("cannot start 'write': 'synthesize' phase is not complete")

    targets = pd.setdefault("targets", {})
    if target in targets:
        t = targets[target]
        if t["status"] == "in_progress":
            t["attempts"] = t.get("attempts", 1) + 1
        elif t["status"] == "failed":
            t["status"] = "in_progress"
            t["attempts"] = t.get("attempts", 0) + 1
            t["last_error"] = None
        # if complete, retry still bumps attempts
        elif t["status"] == "complete":
            t["attempts"] = t.get("attempts", 1) + 1
        else:
            t["status"] = "in_progress"
            t["attempts"] = t.get("attempts", 0) + 1
    else:
        targets[target] = {"status": "in_progress", "attempts": 1, "last_error": None}

    pd["status"] = "in_progress"
    _write(root, state)
    return state


def complete_target(root: pathlib.Path, phase: str, target: str) -> dict:
    state = _read(root)
    if state is None:
        raise StateError("no active run")
    phases = _phase_list(root)

    pd = state["phases"].get(phase, {})
    targets = pd.get("targets", {})
    t = targets.get(target)

    if t is None:
        raise StateError(f"target '{target}' not found in phase '{phase}'")

    if t["status"] == "complete":
        return {"ok": True, "state": state}

    import _validate
    issues = _validate.validate_target(_load_workspace(root), phase, target)
    errors = [i for i in issues if i.get("severity") == "error"]
    if errors:
        return {"ok": False, "issues": errors}

    t["status"] = "complete"
    t["last_error"] = None

    # Mark the phase complete when its known targets all pass, but never
    # advance the run phase here: more targets may still be registered.
    # Advancement happens when start_target opens the next phase and its
    # gate re-checks completeness.
    if _all_targets_complete(pd):
        pd["status"] = "complete"
    _write(root, state)
    return {"ok": True, "state": state}


def fail_target(root: pathlib.Path, phase: str, target: str, reason: str) -> dict:
    state = _read(root)
    if state is None:
        raise StateError("no active run")
    pd = state["phases"].get(phase, {})
    targets = pd.get("targets", {})
    if target not in targets:
        raise StateError(f"target '{target}' not found in phase '{phase}'")
    t = targets[target]
    t["status"] = "failed"
    t["last_error"] = reason
    _write(root, state)
    return state


def abandon(root: pathlib.Path) -> None:
    p = _state_path(root)
    if p.exists():
        p.unlink()
