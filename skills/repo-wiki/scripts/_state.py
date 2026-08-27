import functools
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import time
from datetime import datetime, timezone

from _files import atomic_json, directory_digest
from _models import PagePlan, ReviewReport, model_errors
from pydantic import ValidationError

VERSION = 1
PHASES = ["survey", "connect", "plan", "write", "review"]
LOCK_TIMEOUT_SEC = 60


class StateError(Exception):
    pass


def _locked(function):
    @functools.wraps(function)
    def wrapper(root: pathlib.Path, *args, **kwargs):
        path = _meta(root) / "state.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR)
        acquired = False
        try:
            _acquire_lock(fd)
            acquired = True
            return function(root, *args, **kwargs)
        finally:
            if acquired:
                _release_lock(fd)
            os.close(fd)

    return wrapper


def _acquire_lock(fd: int) -> None:
    deadline = time.monotonic() + LOCK_TIMEOUT_SEC
    while True:
        try:
            if os.name == "nt":
                import msvcrt

                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except (OSError, BlockingIOError, PermissionError):
            if time.monotonic() >= deadline:
                raise StateError("timed out waiting for the state lock")
            time.sleep(0.05)


def _release_lock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


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
    bak = path.with_suffix(".json.bak")
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        if bak.is_file():
            try:
                state = json.loads(bak.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raise StateError(f"corrupt run state: {exc}") from exc
        else:
            raise StateError(f"corrupt run state: {exc}") from exc
    if state.get("version") != VERSION:
        raise StateError(
            f"unsupported run state version {state.get('version')!r}; this kernel is v{VERSION}"
        )
    return state


def _write(root: pathlib.Path, state: dict) -> None:
    state["updated_at"] = _now()
    path = run_dir(root, state["run_id"]) / "state.json"
    if path.exists():
        shutil.copy2(path, path.with_suffix(".json.bak"))
    atomic_json(path, state)


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


def _slug(name: str) -> str:
    return name.lower()


@_locked
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

    run_id = f"r-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(3)}"
    revisions = []
    catalogs = []
    for source in workspace.sources.values():
        if source.kind == "git":
            record = _workspace.capture_git_revision(root, source)
            _workspace.materialize_pin(root, run_id, source, record)
            revisions.append(record)
        elif source.kind == "files":
            record = _workspace.capture_files_revision(root, source)
            _workspace.materialize_pin(root, run_id, source, record)
            revisions.append(record)
        elif source.kind in ("opengauss", "postgres"):
            catalogs.append(_db.capture_catalog(root, source))
        else:
            raise StateError(f"unsupported source kind: {source.kind}")

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
        "revisions": revisions,
        "catalogs": catalogs,
        "tasks": {},
        "review_attempts": [],
        "publication": None,
    }
    previous = _published_manifest(root)
    previous_run_id = (previous or {}).get("producer_run_id")
    if previous_run_id and (run_dir(root, previous_run_id) / "state.json").is_file():
        state["previous_run_id"] = previous_run_id
    base = run_dir(root, run_id)
    for path in (base / "drafts", base / "candidate", base / "proposals"):
        path.mkdir(parents=True, exist_ok=True)
    for revision in revisions:
        source = workspace.sources[revision["name"]]
        for name, scope in _survey_scopes(root, source, revision):
            _add_task(
                state,
                _task(
                    "survey",
                    name,
                    f"drafts/survey/{name}.json",
                    source=revision["name"],
                    scope=scope,
                ),
            )
            _reuse_task(root, state, state["tasks"][f"survey:{name}"])
    if not state["tasks"]:
        _add_plan_shards(root, state)
        if _phase_complete(state, "plan"):
            _advance(root, state, "plan")
    elif _phase_complete(state, "survey"):
        _advance(root, state, "survey")
    _write(root, state)
    atomic_json(_pointer(root), {"version": VERSION, "run_id": run_id})
    return status(root)


_SURVEY_SCOPE_BUDGET = 200


def _survey_scopes(root: pathlib.Path, source, revision: dict) -> list[tuple[str, list[str]]]:
    import _workspace

    slug = _slug(source.name)
    files = _workspace.tracked_files(source, revision.get("commit"))
    exclude = [item.strip("/") for item in source.survey_exclude if item.strip("/")]
    if exclude:
        files = [
            item
            for item in files
            if not any(item == entry or item.startswith(entry + "/") for entry in exclude)
        ]
    if not files:
        return [(slug, ["."])]
    forced = {item.strip("/") for item in source.survey_split if item.strip("/")}
    scopes = _split_scope(slug, "", files, forced)
    seen: dict[str, int] = {}
    result = []
    for name, scope in scopes:
        count = seen.get(name, 0)
        seen[name] = count + 1
        result.append((f"{name}-{count + 1}" if count else name, scope))
    return result


def _split_scope(
    name: str, prefix: str, files: list[str], forced: set[str]
) -> list[tuple[str, list[str]]]:
    """Partition a subtree into disjoint scopes within the file-count budget."""
    forced_below = any(
        item != prefix and (not prefix or item.startswith(prefix + "/"))
        for item in forced
    )
    if len(files) <= _SURVEY_SCOPE_BUDGET and not forced_below:
        if prefix:
            return [(name, [prefix])]
        return [(name, sorted({item.split("/", 1)[0] for item in files}))]
    start = len(prefix) + 1 if prefix else 0
    groups: dict[str, list[str]] = {}
    loose: list[str] = []
    for item in files:
        head, sep, _ = item[start:].partition("/")
        if sep:
            groups.setdefault(head, []).append(item)
        else:
            loose.append(item)
    result: list[tuple[str, list[str]]] = []
    pending: list[tuple[str, list[str], int]] = []
    for head in sorted(groups):
        child_prefix = f"{prefix}/{head}" if prefix else head
        child_forced = child_prefix in forced or any(
            item.startswith(child_prefix + "/") for item in forced
        )
        if len(groups[head]) > _SURVEY_SCOPE_BUDGET or child_forced:
            result.extend(
                _split_scope(
                    f"{name}/{_slug(head)}", child_prefix, groups[head], forced
                )
            )
        else:
            pending.append((head, [child_prefix], len(groups[head])))
    for item in sorted(loose):
        pending.append((item[start:], [item], 1))
    packed: list[str] = []
    packed_head: str | None = None
    packed_count = 0
    for head, paths, count in pending:
        if packed and packed_count + count > _SURVEY_SCOPE_BUDGET:
            result.append((f"{name}/{_slug(packed_head)}", packed))
            packed, packed_head, packed_count = [], None, 0
        if packed_head is None:
            packed_head = head
        packed.extend(paths)
        packed_count += count
    if packed:
        result.append((f"{name}/{_slug(packed_head)}", packed))
    return result


def _connectable(state: dict) -> list[dict]:
    return [item for item in state["revisions"] if item.get("kind") in ("git", "files")]


def _add_connect_tasks(root: pathlib.Path, state: dict) -> None:
    for item in _connectable(state):
        slug = _slug(item["name"])
        _add_task(
            state,
            _task(
                "connect",
                slug,
                f"drafts/connect/{slug}.json",
                source=item["name"],
            ),
        )
        _reuse_task(root, state, state["tasks"][f"connect:{slug}"])


def _add_plan_shards(root: pathlib.Path, state: dict) -> None:
    owners = [item["name"] for item in state["revisions"]]
    owners.extend(item["name"] for item in state["catalogs"])
    for name in owners:
        slug = _slug(name)
        _add_task(
            state,
            _task("plan", slug, f"drafts/plan/{slug}.json", source=name),
        )
        _reuse_task(root, state, state["tasks"][f"plan:{slug}"])
    _add_task(
        state,
        _task("plan", "workspace", "drafts/plan/workspace.json", source=None),
    )
    _reuse_task(root, state, state["tasks"]["plan:workspace"])


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
    if state["status"] in ("active", "awaiting_review", "reviewing", "paused"):
        _assert_completed_artifacts(root, state)
    current = _phase(state)
    tasks = [task for task in state["tasks"].values() if task["phase"] == current]
    next_actions = []
    if state["status"] == "paused":
        next_actions = ["run resume"]
    else:
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
    return {
        "run_id": state["run_id"],
        "status": state["status"],
        "current_phase": current,
        "tasks": [{"id": task["id"], "status": task["status"]} for task in tasks],
        "next_actions": next_actions,
        "run_dir": str(run_dir(root, state["run_id"])),
    }


def assert_revisions_current(root: pathlib.Path, state: dict) -> None:
    import _workspace

    workspace = _workspace.load(root)
    for record in state["revisions"]:
        source = workspace.sources.get(record["name"])
        if source is None or source.kind not in ("git", "files"):
            raise StateError(f"source missing during run: {record['name']}")
        _workspace.assert_pin_current(root, state["run_id"], source, record)


@_locked
def task_start(root: pathlib.Path, task_id: str) -> dict:
    state = _require_run(root, {"active", "reviewing"})
    assert_revisions_current(root, state)
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
    return _dispatch(root, state, task)


def _pin_sources(root: pathlib.Path, state: dict, selected: str | None) -> dict[str, str]:
    import _workspace

    workspace = _workspace.load(root)
    result = {}
    for name, source in workspace.sources.items():
        if source.kind not in ("git", "files") or not source.path:
            continue
        if selected and name != selected:
            continue
        pin = _workspace.pin_dir(root, state["run_id"], name)
        result[name] = str(pin if pin.is_dir() else source.path)
    return result


def _catalog_paths(root: pathlib.Path, state: dict, task: dict) -> list[str]:
    import _db

    phase = task["phase"]
    spec = task["spec"]
    paths: list[pathlib.Path] = []
    if phase == "plan":
        selected = spec.get("source")
        for catalog in state["catalogs"]:
            if selected is None or catalog["name"] == selected:
                paths.append(_db.catalog_index_path(root, catalog["content_hash"]))
    elif phase == "write":
        if spec.get("type") == "DataModel" or task["name"] == "data-model.md":
            for catalog in state["catalogs"]:
                paths.append(_db.catalog_index_path(root, catalog["content_hash"]))
        elif spec.get("type") == "Table":
            for catalog in state["catalogs"]:
                for table in catalog["tables"]:
                    if (
                        f"data/{catalog['name'].lower()}/{table['page_slug']}.md"
                        == task["name"]
                    ):
                        paths.append(
                            _db.catalog_table_path(
                                root, catalog["content_hash"], table["page_slug"]
                            )
                        )
    return [str(path) for path in paths if path.exists()]


def _page_catalog_hash(state: dict, page) -> str | None:
    if page.type == "DataModel":
        hashes = [item["content_hash"] for item in state["catalogs"]]
        return ",".join(sorted(hashes)) if hashes else None
    if page.type != "Table":
        return None
    for catalog in state["catalogs"]:
        prefix = f"data/{catalog['name'].lower()}/"
        if page.path.startswith(prefix) or page.owner == catalog["name"]:
            return catalog["content_hash"]
    return None


def _dispatch(root: pathlib.Path, state: dict, task: dict) -> dict:
    base = run_dir(root, state["run_id"])
    phase = task["phase"]
    inputs: list[pathlib.Path] = []
    if phase in ("connect", "plan", "write"):
        inputs.extend(sorted((base / "drafts" / "survey").rglob("*.json")))
        inputs.extend(sorted((base / "drafts" / "connect").glob("*.json")))
        if phase == "write":
            inputs.extend(sorted((base / "drafts" / "plan").glob("*.json")))
    elif phase == "review":
        inputs.append(base / "candidate")
    selected = task["spec"].get("source")
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    reference = "review.md" if phase == "review" else f"{phase}.md"
    packet = {
        "run_id": state["run_id"],
        "task": {"id": task["id"], "phase": phase, "spec": task["spec"]},
        "language": state["language"],
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references" / reference
        ),
        "artifact": str(_artifact(root, state, task)),
        "sources": _pin_sources(root, state, selected if phase == "survey" else None),
        "inputs": [str(path) for path in inputs if path.exists()],
        "complete_command": f"uv run {okf} task complete {task['id']} --json",
        "workdir": str(root),
    }
    catalogs = _catalog_paths(root, state, task)
    if catalogs:
        packet["catalogs"] = catalogs
    if phase == "review":
        packet["candidate"] = str(candidate_dir(root, state))
        packet["candidate_digest"] = state["review"]["candidate_digest"]
        packet["pages"] = task["spec"].get("pages", [])
        packet["actor"] = state["review"]["actor"]
        packet["session"] = state["review"]["session"]
    return packet


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


@_locked
def task_complete(root: pathlib.Path, task_id: str) -> dict:
    import _validate

    state = _require_run(root, {"active", "reviewing"})
    assert_revisions_current(root, state)
    task = state["tasks"].get(task_id)
    if task is None:
        raise StateError(f"unknown target: {task_id}")
    if task["status"] == "complete":
        return {"ok": True, "state": status(root)}
    if task["status"] != "in_progress":
        raise StateError("target must be started before completion")
    if task["phase"] == "write":
        artifact = _artifact(root, state, task)
        rendered = _validate.render_generated_page(root, state, task, artifact)
        if rendered is not None:
            artifact.write_text(rendered, encoding="utf-8", newline="\n")
    issues = _validate.validate_task(root, state, task)
    errors = [issue for issue in issues if issue.severity == "error"]
    if errors:
        return {"ok": False, "issues": [issue.to_dict() for issue in errors]}
    if task["phase"] == "review":
        return _finish_review_batch(root, state, task)
    artifact = _artifact(root, state, task)
    task["status"] = "complete"
    task["completed_at"] = _now()
    task["artifact_digest"] = (
        _file_digest(artifact) if artifact.is_file() else directory_digest(artifact)
    )
    _advance(root, state, task["phase"])
    _write(root, state)
    return {"ok": True, "state": status(root)}


@_locked
def task_fail(root: pathlib.Path, task_id: str, reason: str) -> dict:
    state = _require_run(root, {"active", "reviewing"})
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
    connectable = _connectable(state)
    if phase == "survey":
        if len(connectable) > 1:
            _add_connect_tasks(root, state)
        else:
            _add_plan_shards(root, state)
    elif phase == "connect":
        _add_plan_shards(root, state)
    elif phase == "plan":
        _compose_plan(root, state)
    elif phase == "write":
        state["status"] = "awaiting_review"
    next_phase = {
        "survey": "connect" if len(connectable) > 1 else "plan",
        "connect": "plan",
        "plan": "write",
    }.get(phase)
    if next_phase and _phase_complete(state, next_phase):
        _advance(root, state, next_phase)


def _compose_plan(root: pathlib.Path, state: dict) -> None:
    import _validate

    issues = _validate.validate_composed_plan(root, state)
    errors = [item for item in issues if item.severity == "error"]
    if errors:
        raise StateError(
            f"composed page plan is invalid: {[item.to_dict() for item in errors[:3]]}"
        )
    pages = _composed_pages(root, state)
    candidate = candidate_dir(root, state)
    keep = {page.path for page in pages}
    if candidate.exists():
        for path in list(candidate.rglob("*.md")):
            rel = path.relative_to(candidate).as_posix()
            if rel not in keep:
                path.unlink()
    else:
        candidate.mkdir(parents=True, exist_ok=True)
    existing_writes = {
        task_id: task
        for task_id, task in state["tasks"].items()
        if task["phase"] == "write"
    }
    wanted = {f"write:{page.path}" for page in pages}
    for task_id in list(existing_writes):
        if task_id not in wanted:
            del state["tasks"][task_id]
    for page in pages:
        task_id = f"write:{page.path}"
        spec = {
            "owner": page.owner,
            "type": page.type,
            "title": page.title,
            "description": page.description,
            "tags": page.tags,
            "finding_ids": page.finding_ids,
            "connection_ids": page.connection_ids,
        }
        catalog_hash = _page_catalog_hash(state, page)
        if catalog_hash:
            spec["catalog_hash"] = catalog_hash
        if task_id in state["tasks"]:
            old = state["tasks"][task_id]
            if old.get("spec") == spec and old.get("status") == "complete":
                continue
            old["spec"] = spec
            old["status"] = "pending"
            old.pop("artifact_digest", None)
            continue
        _add_task(
            state,
            _task(
                "write",
                page.path,
                f"candidate/{page.path}",
                **spec,
            ),
        )
        _reuse_page(root, state, state["tasks"][task_id])


def _composed_pages(root: pathlib.Path, state: dict):
    pages = []
    for path in sorted(
        (run_dir(root, state["run_id"]) / "drafts" / "plan").glob("*.json")
    ):
        plan = PagePlan.model_validate_json(path.read_text(encoding="utf-8"), strict=True)
        pages.extend(plan.pages)
    return pages


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
    def _key(item: dict) -> str | None:
        return item.get("commit") or item.get("content_hash")

    current = next((item for item in state["revisions"] if item["name"] == source), None)
    old = next((item for item in previous["revisions"] if item["name"] == source), None)
    if current and old:
        return _key(current) == _key(old)
    current_cat = next(
        (item for item in state["catalogs"] if item["name"] == source), None
    )
    old_cat = next(
        (item for item in previous["catalogs"] if item["name"] == source), None
    )
    return bool(
        current_cat
        and old_cat
        and current_cat.get("content_hash") == old_cat.get("content_hash")
    )


def _all_sources_unchanged(state: dict, previous: dict) -> bool:
    def index(items: list[dict], key: str) -> dict:
        return {item["name"]: item.get(key) or item.get("content_hash") for item in items}

    current = index(state["revisions"], "commit")
    current.update(index(state["catalogs"], "content_hash"))
    old = index(previous["revisions"], "commit")
    old.update(index(previous["catalogs"], "content_hash"))
    return current == old


def _reuse_task(root: pathlib.Path, state: dict, task: dict) -> None:
    previous = _previous_state(root, state)
    if previous is None:
        return
    old = previous.get("tasks", {}).get(task["id"])
    if not old or old.get("status") != "complete" or old.get("spec") != task["spec"]:
        return
    if task["phase"] == "survey":
        if not _source_unchanged(state, previous, task["spec"]["source"]):
            return
    elif task["phase"] == "connect":
        if not _all_sources_unchanged(state, previous):
            return
    elif task["phase"] == "plan":
        source = task["spec"].get("source")
        if source:
            if not _source_unchanged(state, previous, source):
                return
        elif not _all_sources_unchanged(state, previous):
            return
    else:
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
    import _workspace
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
    workspace = _workspace.load(root)
    revisions = {item["name"]: item for item in state["revisions"]}
    for key, expected in page_info.get("source_blobs", {}).items():
        source, _, rel = key.partition("/")
        revision = revisions.get(source)
        registered = workspace.sources.get(source)
        if not rel or revision is None or registered is None:
            return
        if registered.kind == "git":
            if _workspace.git_blob_oid(registered, revision["commit"], rel) != expected:
                return
        elif registered.kind == "files":
            blob = _workspace.files_blob(registered, rel)
            if blob is None or hashlib.sha256(blob).hexdigest() != expected:
                return
        else:
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
    target_path = run_dir(root, state["run_id"]) / task["artifact"]
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(
        render(parsed.meta, parsed.body), encoding="utf-8", newline="\n"
    )
    rendered = _validate.render_generated_page(root, state, task, target_path)
    if rendered is not None:
        target_path.write_text(rendered, encoding="utf-8", newline="\n")
    if any(
        item.severity == "error"
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
    from _models import Connect, Survey

    findings = {}
    survey_dir = base / "drafts" / "survey"
    if survey_dir.is_dir():
        for path in sorted(survey_dir.rglob("*.json")):
            survey = Survey.model_validate_json(
                path.read_text(encoding="utf-8"), strict=True
            )
            findings.update(
                {item.id: item.model_dump(mode="json") for item in survey.findings}
            )
    connections = {}
    connect_dir = base / "drafts" / "connect"
    if connect_dir.is_dir():
        for path in sorted(connect_dir.glob("*.json")):
            connect = Connect.model_validate_json(
                path.read_text(encoding="utf-8"), strict=True
            )
            connections.update(
                {item.id: item.model_dump(mode="json") for item in connect.connections}
            )
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


@_locked
def review_start(root: pathlib.Path, actor: str, session: str) -> dict:
    state = read(root)
    if state is None or state["status"] != "awaiting_review":
        raise StateError("run is not awaiting review")
    assert_revisions_current(root, state)
    if not _agent_actor(actor):
        raise StateError("reviewer must follow <producer>/<version>")
    if session == state["producer_session"]:
        raise StateError("review session must be distinct from the producer session")
    if not session:
        raise StateError("review session id is required")
    digest = directory_digest(candidate_dir(root, state))
    pages_by_owner: dict[str, list[str]] = {}
    for page in _composed_pages(root, state):
        pages_by_owner.setdefault(page.owner, []).append(page.path)
    state["review"] = {
        "actor": actor,
        "session": session,
        "candidate_digest": digest,
        "created_at": _now(),
    }
    for owner, pages in sorted(pages_by_owner.items()):
        slug = "workspace" if owner == "workspace" else _slug(owner)
        _add_task(
            state,
            _task(
                "review",
                slug,
                f"drafts/review/{slug}.json",
                owner=owner,
                pages=sorted(pages),
            ),
        )
    state["status"] = "reviewing"
    _write(root, state)
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    packet = {
        "run_id": state["run_id"],
        "candidate_digest": digest,
        "actor": actor,
        "session": session,
        "language": state["language"],
        "created_at": state["review"]["created_at"],
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references" / "review.md"
        ),
        "candidate": str(candidate_dir(root, state)),
        "sources": _pin_sources(root, state, None),
        "batches": [
            {
                "id": f"review:{'workspace' if owner == 'workspace' else _slug(owner)}",
                "owner": owner,
                "pages": sorted(pages),
            }
            for owner, pages in sorted(pages_by_owner.items())
        ],
        "workdir": str(root),
        "complete_command": f"uv run {okf} task complete <review-id> --json",
    }
    return packet


def _finish_review_batch(root: pathlib.Path, state: dict, task: dict) -> dict:
    import _validate

    report_path = _artifact(root, state, task)
    try:
        report = ReviewReport.model_validate_json(
            report_path.read_text(encoding="utf-8"), strict=True
        )
    except (OSError, ValidationError) as exc:
        raise StateError(
            "invalid review report: " + "; ".join(model_errors(exc))
        ) from exc
    expected_batch = task["spec"].get("owner") or task["name"]
    if report.batch not in {task["name"], expected_batch, task["spec"].get("owner")}:
        raise StateError(
            f"review batch {report.batch!r} does not match target {task['id']}"
        )
    current_digest = directory_digest(candidate_dir(root, state))
    if (
        report.candidate_digest != state["review"]["candidate_digest"]
        or report.candidate_digest != current_digest
    ):
        raise StateError("candidate changed after review packet creation")
    attempt = {
        "actor": state["review"]["actor"],
        "session": state["review"]["session"],
        "batch": report.batch,
        "submitted_at": _now(),
        **report.model_dump(mode="json"),
    }
    state["review_attempts"].append(attempt)
    if report.verdict == "changes_requested":
        _apply_reopen(root, state, report)
        _write(root, state)
        return {"verdict": "changes_requested", "state": status(root), "ok": True}

    task["status"] = "complete"
    task["completed_at"] = _now()
    task["artifact_digest"] = _file_digest(report_path)
    if _phase_complete(state, "review"):
        for path, text in _validate.render_approved_pages(
            root, state, state["review"]["actor"]
        ):
            path.write_text(text, encoding="utf-8", newline="\n")
        issues = _validate.validate_candidate(root, state, published=False)
        errors = [issue for issue in issues if issue.severity == "error"]
        if errors:
            raise StateError(
                f"approved candidate failed validation: {[issue.to_dict() for issue in errors[:3]]}"
            )
        state["approved_digest"] = directory_digest(candidate_dir(root, state))
        state["approved_at"] = _now()
        state["status"] = "approved"
        state.pop("review", None)
    _write(root, state)
    return {"verdict": "approved", "ok": True, "state": status(root)}


def _apply_reopen(root: pathlib.Path, state: dict, report: ReviewReport) -> None:
    plan_issues = [issue for issue in report.issues if issue.reopen == "plan"]
    page_issues = [issue for issue in report.issues if issue.reopen == "page"]
    _remove_phases(state, {"review"})
    state.pop("review", None)
    state["status"] = "active"
    if plan_issues:
        shards = {issue.target for issue in plan_issues}
        for target in shards:
            slug = "workspace" if target in {"workspace", "plan:workspace"} else _slug(
                target.removeprefix("plan:")
            )
            task = state["tasks"].get(f"plan:{slug}")
            if task is None:
                raise StateError(f"review references unknown plan shard: {target}")
            owned = {
                page.path
                for page in _composed_pages(root, state)
                if (page.owner == "workspace" and slug == "workspace")
                or _slug(page.owner) == slug
            }
            for path in owned:
                write = state["tasks"].get(f"write:{path}")
                if write:
                    del state["tasks"][f"write:{path}"]
                    artifact = candidate_dir(root, state) / path
                    if artifact.exists():
                        artifact.unlink()
            task["status"] = "pending"
            task.pop("artifact_digest", None)
        return
    for path in {issue.target for issue in page_issues}:
        task = state["tasks"].get(f"write:{path}")
        if task is None:
            raise StateError(f"review references unknown page: {path}")
        task["status"] = "pending"
        task.pop("artifact_digest", None)


def _remove_phases(state: dict, phases: set[str]) -> None:
    state["tasks"] = {
        task_id: task
        for task_id, task in state["tasks"].items()
        if task["phase"] not in phases
    }


@_locked
def pause(root: pathlib.Path) -> dict:
    state = _require_run(root, {"active", "awaiting_review", "reviewing"})
    state["status"] = "paused"
    state["paused_from"] = _phase(state)
    _write(root, state)
    return status(root)


@_locked
def resume(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None or state["status"] != "paused":
        raise StateError("run is not paused")
    assert_revisions_current(root, state)
    has_review = any(t["phase"] == "review" for t in state["tasks"].values())
    write_done = _phase_complete(state, "write")
    if has_review:
        state["status"] = "reviewing" if write_done else "active"
    elif write_done:
        state["status"] = "awaiting_review"
    else:
        state["status"] = "active"
    state.pop("paused_from", None)
    _write(root, state)
    return status(root)


@_locked
def refresh_source(root: pathlib.Path, name: str) -> dict:
    import _workspace

    state = _require_run(root, {"active", "paused", "awaiting_review", "reviewing"})
    workspace = _workspace.load(root)
    source = workspace.sources.get(name)
    if source is None or source.kind not in ("git", "files"):
        raise StateError(f"refresh requires a git or files source: {name}")
    if source.kind == "git":
        record = _workspace.capture_git_revision(root, source)
    else:
        record = _workspace.capture_files_revision(root, source)
    _workspace.remove_pin(root, state["run_id"], source)
    _workspace.materialize_pin(root, state["run_id"], source, record)
    state["revisions"] = [
        record if item["name"] == name else item for item in state["revisions"]
    ]
    _invalidate_source(root, state, name)
    if state["status"] in ("awaiting_review", "reviewing", "approved"):
        state["status"] = "active"
    _write(root, state)
    return status(root)


def _invalidate_source(root: pathlib.Path, state: dict, name: str) -> None:
    slug = _slug(name)
    _remove_phases(state, {"review"})
    state.pop("review", None)
    for task in state["tasks"].values():
        depends = False
        if task["phase"] == "survey" and task["spec"].get("source") == name:
            depends = True
        elif task["phase"] == "connect":
            depends = True
        elif task["phase"] == "plan" and task["spec"].get("source") in {name, None}:
            depends = True
        elif task["phase"] == "write" and task["spec"].get("owner") in {name, "workspace"}:
            depends = True
        if depends and task["status"] != "pending":
            task["status"] = "pending"
            task.pop("artifact_digest", None)
            artifact = _artifact(root, state, task)
            if artifact.is_file():
                artifact.unlink()


@_locked
def propose_start(root: pathlib.Path) -> dict:
    import _workspace

    state = read(root)
    if state is None or state["status"] != "published":
        raise StateError("propose runs against a published run")
    assert_revisions_current(root, state)
    workspace = _workspace.load(root)
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    proposals = run_dir(root, state["run_id"]) / "proposals"
    proposals.mkdir(parents=True, exist_ok=True)
    return {
        "run_id": state["run_id"],
        "language": state["language"],
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references" / "propose.md"
        ),
        "artifact": str(proposals),
        "candidate": _publication_path(root),
        "sources": _pin_sources(root, state, None),
        "inputs": [
            str(path)
            for path in sorted(
                (run_dir(root, state["run_id"]) / "drafts" / "plan").glob("*.json")
            )
        ],
        "complete_command": f"uv run {okf} propose complete --json",
        "workdir": str(root),
    }


def _publication_path(root: pathlib.Path) -> str:
    pointer = json.loads(
        (root / ".okf-wiki" / "publication" / "current.json").read_text(encoding="utf-8")
    )
    return str(
        root / ".okf-wiki" / "publication" / "generations" / pointer["generation"]
    )


@_locked
def propose_complete(root: pathlib.Path) -> dict:
    import _validate

    state = read(root)
    if state is None or state["status"] != "published":
        raise StateError("propose runs against a published run")
    path = run_dir(root, state["run_id"]) / "proposals"
    issues = _validate.validate_proposals(root, state, path)
    errors = [item for item in issues if item.severity == "error"]
    if errors:
        return {"ok": False, "issues": [item.to_dict() for item in errors]}
    return {"ok": True, "files": sorted(item.name for item in path.glob("*.md"))}


@_locked
def mark_published(root: pathlib.Path, publication: dict) -> dict:
    import _workspace

    state = read(root)
    if state is None or state["status"] != "approved":
        raise StateError("run is not approved")
    state["publication"] = publication
    state["status"] = "published"
    state["published_at"] = _now()
    _write(root, state)
    workspace = _workspace.load(root)
    _workspace.remove_run_pins(root, state["run_id"], workspace.sources)
    return status(root)


@_locked
def abandon(root: pathlib.Path) -> dict:
    import _workspace

    state = read(root)
    if state is None:
        return {"abandoned": False}
    if state["status"] == "published":
        raise StateError("published runs cannot be abandoned")
    state["status"] = "abandoned"
    state["abandoned_at"] = _now()
    _write(root, state)
    workspace = _workspace.load(root)
    _workspace.remove_run_pins(root, state["run_id"], workspace.sources)
    return {"abandoned": True, "run_id": state["run_id"]}


def _require_run(root: pathlib.Path, statuses: set[str]) -> dict:
    state = read(root)
    if state is None:
        raise StateError("no run; call 'run start'")
    if state["status"] not in statuses:
        raise StateError(f"run is {state['status']}, not {'/'.join(sorted(statuses))}")
    _assert_completed_artifacts(root, state)
    return state
