import hashlib
import json
import pathlib
import re
import secrets
import shutil
from datetime import datetime, timezone

from _files import atomic_json, directory_digest
from _models import Inspection, PagePlan, ReviewReport, Survey, Synthesis, model_errors
from pydantic import ValidationError

VERSION = 3
PHASES = ["inspect", "survey", "synthesize", "plan", "write", "derive", "review"]


class StateError(Exception):
    pass


def _agent_actor(value: str) -> bool:
    parts = value.split("/", 1)
    return len(parts) == 2 and all(parts)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _meta(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki"


def _pointer(root: pathlib.Path) -> pathlib.Path:
    return _meta(root) / "current-run.json"


def run_dir(root: pathlib.Path, run_id: str) -> pathlib.Path:
    return _meta(root) / "runs" / run_id


def candidate_dir(root: pathlib.Path, state: dict) -> pathlib.Path:
    return run_dir(root, state["run_id"]) / "candidate"


def drafts_dir(root: pathlib.Path, state: dict) -> pathlib.Path:
    return run_dir(root, state["run_id"]) / "drafts"


def _read_pointer(root: pathlib.Path) -> str | None:
    path = _pointer(root)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        run_id = data["run_id"]
        if data.get("version") != VERSION or not re.fullmatch(
            r"r-\d{8}-[0-9a-f]{6}", run_id
        ):
            raise ValueError("pointer fields are invalid")
        return run_id
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as exc:
        raise StateError(f"corrupt current-run pointer: {exc}") from exc


def read(root: pathlib.Path) -> dict | None:
    run_id = _read_pointer(root)
    if run_id is None:
        return None
    path = run_dir(root, run_id) / "state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateError(f"corrupt run state: {exc}") from exc
    if state.get("version") != VERSION:
        raise StateError("unsupported run state; abandon and create a v3 run")
    return state


def _write(root: pathlib.Path, state: dict) -> None:
    state["updated_at"] = _now()
    atomic_json(run_dir(root, state["run_id"]) / "state.json", state)


def _task(phase: str, name: str, artifact: str, **spec) -> dict:
    return {
        "id": f"{phase}:{name}",
        "phase": phase,
        "name": name,
        "artifact": artifact,
        "status": "pending",
        "attempts": 0,
        "last_error": None,
        "spec": spec,
    }


def _add_task(state: dict, task: dict) -> None:
    if task["id"] in state["tasks"]:
        raise StateError(f"duplicate target id: {task['id']}")
    state["tasks"][task["id"]] = task


def start_run(root: pathlib.Path, producer: str, session: str) -> dict:
    import _db
    import _workspace

    existing = read(root)
    if existing and existing["status"] not in ("published", "abandoned"):
        raise StateError(f"run {existing['run_id']} is still {existing['status']}")
    if not _agent_actor(producer):
        raise StateError("producer must follow <producer>/<version>")
    if not session:
        raise StateError("session id is required")
    workspace = _workspace.load(root)
    if not workspace.sources:
        raise StateError("at least one source is required")

    snapshots = []
    for source in workspace.sources.values():
        if source.kind == "git":
            snapshots.append(_workspace.snapshot_git(root, source))
        else:
            snapshots.append(_db.snapshot_source(root, source))

    run_id = f"r-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(3)}"
    state = {
        "version": VERSION,
        "run_id": run_id,
        "status": "active",
        "started_at": _now(),
        "updated_at": _now(),
        "producer": producer,
        "producer_session": session,
        "language": workspace.language,
        "freshness_days": workspace.freshness_days,
        "snapshots": snapshots,
        "tasks": {},
        "review_attempts": [],
        "publication": None,
    }
    previous = _published_manifest(root)
    previous_run_id = (previous or {}).get("producer_run_id") or (previous or {}).get(
        "run_id"
    )
    if previous_run_id and (run_dir(root, previous_run_id) / "state.json").is_file():
        state["previous_run_id"] = previous_run_id
    base = run_dir(root, run_id)
    for path in (
        base / "drafts",
        base / "candidate",
        base / "proposals",
        base / "receipts",
    ):
        path.mkdir(parents=True, exist_ok=True)
    for snapshot in snapshots:
        if snapshot["kind"] != "git":
            continue
        source = snapshot["name"]
        _add_task(
            state,
            _task(
                "inspect",
                source,
                f"drafts/inspect/{source}.json",
                source=source,
            ),
        )
        _reuse_task(root, state, state["tasks"][f"inspect:{source}"])
    if not state["tasks"]:
        _add_task(state, _task("plan", "wiki", "drafts/plan.json"))
        _reuse_task(root, state, state["tasks"]["plan:wiki"])
        if _phase_complete(state, "plan"):
            _advance(root, state, "plan")
    elif _phase_complete(state, "inspect"):
        _advance(root, state, "inspect")
    _write(root, state)
    atomic_json(_pointer(root), {"version": VERSION, "run_id": run_id})
    return status(root)


def _phase(state: dict) -> str | None:
    for phase in PHASES:
        if any(
            task["phase"] == phase and task["status"] != "complete"
            for task in state["tasks"].values()
        ):
            return phase
    if state["status"] == "awaiting_review":
        return "review"
    return None


def status(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None:
        return {"run": None}
    if state["status"] in ("active", "awaiting_review", "reviewing"):
        _assert_completed_artifacts(root, state)
    current = _phase(state)
    tasks = [task for task in state["tasks"].values() if task["phase"] == current]
    next_actions = []
    for task in tasks:
        if task["status"] in ("pending", "failed"):
            next_actions.append(f"task start {task['id']}")
        elif task["status"] == "in_progress":
            next_actions.append(f"task complete {task['id']}")
    if state["status"] == "awaiting_review":
        next_actions = [
            "review start --actor <producer/version> --session <new-session>"
        ]
    elif state["status"] == "approved":
        next_actions = ["publication publish"]
    result = dict(state)
    result["current_phase"] = current
    result["next_actions"] = next_actions
    result["run_dir"] = str(run_dir(root, state["run_id"]))
    return result


def task_start(root: pathlib.Path, task_id: str) -> dict:
    state = _require_active(root)
    task = state["tasks"].get(task_id)
    if task is None:
        raise StateError(f"unknown target: {task_id}")
    current = _phase(state)
    if task["phase"] != current:
        raise StateError(
            f"target belongs to phase {task['phase']}; current phase is {current}"
        )
    if task["status"] == "complete":
        raise StateError(
            "completed target cannot be restarted unless review reopens it"
        )
    if task["status"] == "in_progress":
        raise StateError("target is already in progress")
    task["status"] = "in_progress"
    task["attempts"] += 1
    task["started_at"] = _now()
    task["last_error"] = None
    _write(root, state)
    return status(root)


def _artifact(root: pathlib.Path, state: dict, task: dict) -> pathlib.Path:
    return run_dir(root, state["run_id"]) / task["artifact"]


def _file_digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _assert_completed_artifacts(root: pathlib.Path, state: dict) -> None:
    for task in state["tasks"].values():
        if task["status"] != "complete":
            continue
        artifact = _artifact(root, state, task)
        actual = (
            _file_digest(artifact) if artifact.is_file() else directory_digest(artifact)
        )
        if not artifact.exists() or actual != task.get("artifact_digest"):
            raise StateError(f"completed artifact changed: {task['id']}")


def task_complete(root: pathlib.Path, task_id: str) -> dict:
    import _validate

    state = _require_active(root)
    task = state["tasks"].get(task_id)
    if task is None:
        raise StateError(f"unknown target: {task_id}")
    if task["status"] == "complete":
        return {"ok": True, "state": status(root)}
    if task["status"] != "in_progress":
        raise StateError("target must be started before completion")
    if task["phase"] == "write":
        _validate.stamp_generated_page(root, state, task, _artifact(root, state, task))
    issues = _validate.validate_task(root, state, task)
    errors = [issue for issue in issues if issue["severity"] == "error"]
    if errors:
        return {"ok": False, "issues": errors}
    artifact = _artifact(root, state, task)
    task["status"] = "complete"
    task["completed_at"] = _now()
    task["artifact_digest"] = (
        _file_digest(artifact) if artifact.is_file() else directory_digest(artifact)
    )
    _advance(root, state, task["phase"])
    _write(root, state)
    return {"ok": True, "state": status(root)}


def task_fail(root: pathlib.Path, task_id: str, reason: str) -> dict:
    state = _require_active(root)
    task = state["tasks"].get(task_id)
    if task is None:
        raise StateError(f"unknown target: {task_id}")
    if task["status"] != "in_progress":
        raise StateError("only an in-progress target can fail")
    task["status"] = "failed"
    task["last_error"] = reason
    _write(root, state)
    return status(root)


def _phase_complete(state: dict, phase: str) -> bool:
    tasks = [task for task in state["tasks"].values() if task["phase"] == phase]
    return bool(tasks) and all(task["status"] == "complete" for task in tasks)


def _advance(root: pathlib.Path, state: dict, phase: str) -> None:
    if not _phase_complete(state, phase):
        return
    base = run_dir(root, state["run_id"])
    git_sources = [item["name"] for item in state["snapshots"] if item["kind"] == "git"]
    if phase == "inspect":
        for source in git_sources:
            path = base / "drafts" / "inspect" / f"{source}.json"
            inspection = Inspection.model_validate_json(
                path.read_text(encoding="utf-8"), strict=True
            )
            for target in inspection.survey_targets:
                _add_task(
                    state,
                    _task(
                        "survey",
                        target.id,
                        f"drafts/survey/{target.id}.json",
                        source=target.source,
                        scope=target.scope,
                    ),
                )
                _reuse_task(root, state, state["tasks"][f"survey:{target.id}"])
    elif phase == "survey":
        if len(git_sources) > 1:
            _add_task(state, _task("synthesize", "workspace", "drafts/synthesize.json"))
            _reuse_task(root, state, state["tasks"]["synthesize:workspace"])
        else:
            _add_task(state, _task("plan", "wiki", "drafts/plan.json"))
            _reuse_task(root, state, state["tasks"]["plan:wiki"])
    elif phase == "synthesize":
        _add_task(state, _task("plan", "wiki", "drafts/plan.json"))
        _reuse_task(root, state, state["tasks"]["plan:wiki"])
    elif phase == "plan":
        plan_path = base / "drafts" / "plan.json"
        plan = PagePlan.model_validate_json(
            plan_path.read_text(encoding="utf-8"), strict=True
        )
        candidate = base / "candidate"
        shutil.rmtree(candidate, ignore_errors=True)
        candidate.mkdir()
        for page in plan.pages:
            _add_task(
                state,
                _task(
                    "write",
                    page.path,
                    f"candidate/{page.path}",
                    owner=page.owner,
                    type=page.type,
                    title=page.title,
                    description=page.description,
                    tags=page.tags,
                    finding_ids=page.finding_ids,
                    connection_ids=page.connection_ids,
                ),
            )
            _reuse_page(root, state, state["tasks"][f"write:{page.path}"])
    elif phase == "write":
        _add_task(state, _task("derive", "proposals", "proposals"))
    elif phase == "derive":
        state["status"] = "awaiting_review"
    next_phase = {
        "inspect": "survey",
        "survey": "synthesize" if len(git_sources) > 1 else "plan",
        "synthesize": "plan",
        "plan": "write",
        "write": "derive",
    }.get(phase)
    if next_phase and _phase_complete(state, next_phase):
        _advance(root, state, next_phase)


def _published_manifest(root: pathlib.Path) -> dict | None:
    pointer = root / ".okf-wiki" / "publication" / "current.json"
    if not pointer.is_file():
        return None
    try:
        generation = json.loads(pointer.read_text(encoding="utf-8"))["generation"]
        path = (
            root
            / ".okf-wiki"
            / "publication"
            / "generations"
            / generation
            / ".okf-manifest.json"
        )
        return json.loads(path.read_text(encoding="utf-8"))
    except (KeyError, OSError, json.JSONDecodeError):
        return None


def _previous_state(root: pathlib.Path, state: dict) -> dict | None:
    run_id = state.get("previous_run_id")
    if not run_id:
        return None
    try:
        return json.loads(
            (run_dir(root, run_id) / "state.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError):
        return None


def _source_unchanged(state: dict, previous: dict, source: str) -> bool:
    current_snapshot = next(
        (item for item in state["snapshots"] if item["name"] == source), None
    )
    old_snapshot = next(
        (item for item in previous["snapshots"] if item["name"] == source), None
    )
    return bool(
        current_snapshot
        and old_snapshot
        and current_snapshot["content_hash"] == old_snapshot["content_hash"]
    )


def _all_sources_unchanged(state: dict, previous: dict) -> bool:
    current = {
        (item["name"], item["kind"]): item["content_hash"]
        for item in state["snapshots"]
    }
    old = {
        (item["name"], item["kind"]): item["content_hash"]
        for item in previous["snapshots"]
    }
    return current == old


def _reuse_task(root: pathlib.Path, state: dict, task: dict) -> None:
    previous = _previous_state(root, state)
    if previous is None:
        return
    old = previous.get("tasks", {}).get(task["id"])
    if not old or old.get("status") != "complete" or old.get("spec") != task["spec"]:
        return
    if task["phase"] in ("inspect", "survey"):
        source = task["spec"]["source"]
        if not _source_unchanged(state, previous, source):
            return
    elif task["phase"] in ("synthesize", "plan") and not _all_sources_unchanged(
        state, previous
    ):
        return
    source_path = run_dir(root, previous["run_id"]) / old["artifact"]
    target_path = run_dir(root, state["run_id"]) / task["artifact"]
    if not source_path.is_file():
        return
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)
    task.update(
        {
            "status": "complete",
            "reused_from": previous["run_id"],
            "completed_at": _now(),
            "artifact_digest": _file_digest(target_path),
        }
    )


def _reuse_page(root: pathlib.Path, state: dict, task: dict) -> None:
    import _validate
    from _frontmatter import parse_file, render

    manifest = _published_manifest(root)
    previous = _previous_state(root, state)
    page_info = (manifest or {}).get("pages", {}).get(task["name"])
    if (
        previous is None
        or not page_info
        or page_info.get("plan") != task["spec"]
        or page_info.get("input_digest")
        != page_input_digest(run_dir(root, state["run_id"]), task["spec"])
    ):
        return
    snapshots = {item["name"]: item for item in state["snapshots"]}
    for key, expected in page_info.get("source_files", {}).items():
        source, _, rel = key.partition("/")
        if not rel or snapshots.get(source, {}).get("files", {}).get(rel) != expected:
            return
    pointer = json.loads(
        (root / ".okf-wiki" / "publication" / "current.json").read_text(
            encoding="utf-8"
        )
    )
    source_path = (
        root
        / ".okf-wiki"
        / "publication"
        / "generations"
        / pointer["generation"]
        / task["name"]
    )
    if not source_path.is_file():
        return
    parsed = parse_file(source_path)
    stale_after = parsed.meta.get("stale_after") if not parsed.errors else None
    if (
        not stale_after
        or str(stale_after) < datetime.now(timezone.utc).date().isoformat()
    ):
        return
    for source in parsed.meta.get("sources", []):
        resource = source.get("resource", "")
        parsed_resource = _validate.parse_resource(resource)
        if parsed_resource and parsed_resource[0] in snapshots:
            name, _, rel, lo, hi = parsed_resource
            source["resource"] = (
                f"okf-source://{name}/{snapshots[name]['commit']}/{rel}#L{lo}"
                + (f"-L{hi}" if hi != lo else "")
            )
    target_path = run_dir(root, state["run_id"]) / task["artifact"]
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(
        render(parsed.meta, parsed.body), encoding="utf-8", newline="\n"
    )
    _validate.stamp_generated_page(root, state, task, target_path)
    if any(
        item["severity"] == "error"
        for item in _validate.validate_page(
            root,
            state,
            target_path,
            owner=task["spec"]["owner"],
            published=False,
        )
    ):
        target_path.unlink()
        return
    task.update(
        {
            "status": "complete",
            "reused_from": previous["run_id"],
            "completed_at": _now(),
            "artifact_digest": _file_digest(target_path),
        }
    )


def page_input_digest(base: pathlib.Path, spec: dict) -> str:
    findings = {}
    for path in sorted((base / "drafts" / "survey").glob("*.json")):
        survey = Survey.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
        findings.update(
            {item.id: item.model_dump(mode="json") for item in survey.findings}
        )
    connections = {}
    synthesis_path = base / "drafts" / "synthesize.json"
    if synthesis_path.is_file():
        synthesis = Synthesis.model_validate_json(
            synthesis_path.read_text(encoding="utf-8"), strict=True
        )
        connections = {
            item.id: item.model_dump(mode="json") for item in synthesis.connections
        }
    inputs = {
        "findings": [
            findings[item] for item in spec.get("finding_ids", []) if item in findings
        ],
        "connections": [
            connections[item]
            for item in spec.get("connection_ids", [])
            if item in connections
        ],
    }
    raw = json.dumps(inputs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def review_start(root: pathlib.Path, actor: str, session: str) -> dict:
    state = read(root)
    if state is None or state["status"] != "awaiting_review":
        raise StateError("run is not awaiting review")
    _assert_completed_artifacts(root, state)
    if not _agent_actor(actor):
        raise StateError("review actor must follow <producer>/<version>")
    if session == state["producer_session"]:
        raise StateError("review requires a session distinct from the producer")
    if not session:
        raise StateError("review session id is required")
    digest = directory_digest(candidate_dir(root, state))
    packet = {
        "run_id": state["run_id"],
        "candidate_digest": digest,
        "actor": actor,
        "session": session,
        "created_at": _now(),
        "pages": sorted(
            path.relative_to(candidate_dir(root, state)).as_posix()
            for path in candidate_dir(root, state).rglob("*.md")
        ),
    }
    packet_path = drafts_dir(root, state) / "review" / "packet.json"
    atomic_json(packet_path, packet)
    state["review"] = packet
    state["status"] = "reviewing"
    _write(root, state)
    return {"packet": str(packet_path), **packet}


def review_submit(root: pathlib.Path, report_path: pathlib.Path) -> dict:
    import _validate

    state = read(root)
    if state is None or state["status"] != "reviewing":
        raise StateError("review has not been started")
    try:
        report = ReviewReport.model_validate_json(
            report_path.read_text(encoding="utf-8"), strict=True
        )
    except (OSError, ValidationError) as exc:
        raise StateError(
            "invalid review report: " + "; ".join(model_errors(exc))
        ) from exc
    current_digest = directory_digest(candidate_dir(root, state))
    if (
        report.candidate_digest != state["review"]["candidate_digest"]
        or report.candidate_digest != current_digest
    ):
        raise StateError("candidate changed after review packet creation")
    attempt = {
        "actor": state["review"]["actor"],
        "session": state["review"]["session"],
        "submitted_at": _now(),
        **report.model_dump(mode="json"),
    }
    state["review_attempts"].append(attempt)
    if report.verdict == "changes_requested":
        if any(issue.reopen == "plan" for issue in report.issues):
            _remove_phases(state, {"plan", "write", "derive", "review"})
            _add_task(state, _task("plan", "wiki", "drafts/plan.json"))
        else:
            targets = {issue.target for issue in report.issues}
            for path in targets:
                task = state["tasks"].get(f"write:{path}")
                if task is None:
                    raise StateError(f"review references unknown page: {path}")
                task["status"] = "pending"
                task.pop("artifact_digest", None)
            _remove_phases(state, {"derive", "review"})
        state.pop("review", None)
        state["status"] = "active"
        _write(root, state)
        return {"verdict": "changes_requested", "state": status(root)}

    _validate.stamp_approved_pages(root, state, state["review"]["actor"])
    issues = _validate.validate_candidate(root, state, published=False)
    errors = [issue for issue in issues if issue["severity"] == "error"]
    if errors:
        raise StateError(f"approved candidate failed validation: {errors[:3]}")
    state["approved_digest"] = directory_digest(candidate_dir(root, state))
    state["approved_at"] = _now()
    state["status"] = "approved"
    _write(root, state)
    return {"verdict": "approved", "digest": state["approved_digest"]}


def _remove_phases(state: dict, phases: set[str]) -> None:
    state["tasks"] = {
        task_id: task
        for task_id, task in state["tasks"].items()
        if task["phase"] not in phases
    }


def mark_published(root: pathlib.Path, publication: dict) -> dict:
    state = read(root)
    if state is None or state["status"] != "approved":
        raise StateError("run is not approved")
    state["publication"] = publication
    state["status"] = "published"
    state["published_at"] = _now()
    _write(root, state)
    return status(root)


def abandon(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None:
        return {"abandoned": False}
    if state["status"] == "published":
        raise StateError("published runs cannot be abandoned")
    state["status"] = "abandoned"
    state["abandoned_at"] = _now()
    _write(root, state)
    return {"abandoned": True, "run_id": state["run_id"]}


def _require_active(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None:
        raise StateError("no run; call 'run start'")
    if state["status"] != "active":
        raise StateError(f"run is {state['status']}, not active")
    _assert_completed_artifacts(root, state)
    return state
