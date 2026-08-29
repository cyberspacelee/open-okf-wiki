import functools
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import time
from datetime import datetime, timedelta, timezone

from _files import atomic_json, directory_digest
from _frontmatter import parse_file
from _models import CompositionMap, KnowledgeDossier, KnowledgePlan, ReviewReport

VERSION = 2
CONTRACT = "knowledge-composition-late-bind"
KINDS = {"plan", "page", "review"}
LOCK_TIMEOUT_SEC = 60
MAX_SEARCH_RESULTS = 20
MAX_SEARCH_BYTES = 8 * 1024
MAX_READ_LINES = 200
MAX_READ_BYTES = 64 * 1024
MAX_REVIEW_CHANGES = 2
NAVIGATION_LIMITS = {
    "plan": (32, 128 * 1024, 12, 64 * 1024, 96, 512 * 1024),
    "page": (24, 96 * 1024, 8, 32 * 1024, 48, 192 * 1024),
    "review": (16, 64 * 1024, 4, 32 * 1024, 32, 128 * 1024),
}


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _agent_actor(value: str) -> bool:
    return bool(re.fullmatch(r"[^\s/]+/[^\s/]+", value or ""))


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
    if not path.is_file():
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
        raise StateError(f"invalid current run pointer: {exc}") from exc


def read(root: pathlib.Path) -> dict | None:
    run_id = _read_pointer(root)
    if run_id is None:
        return None
    path = run_dir(root, run_id) / "state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateError(f"invalid run state: {exc}") from exc
    if (
        state.get("version") != VERSION
        or state.get("contract") != CONTRACT
        or not isinstance(state.get("targets"), dict)
        or "tasks" in state
    ):
        raise StateError(
            "legacy or unsupported run state; knowledge-composition-late-bind is required"
        )
    for target_id, target in state["targets"].items():
        if target.get("id") != target_id or target.get("kind") not in KINDS:
            raise StateError(f"invalid target state: {target_id}")
        if (
            target["kind"] == "plan"
            and target.get("spec", {}).get("mode") != "workspace"
        ):
            raise StateError(f"invalid plan target state: {target_id}")
        if target["kind"] == "page" and target.get("spec", {}).get("mode") not in {
            "research",
            "compose",
            "write",
        }:
            raise StateError(f"invalid page target state: {target_id}")
    return state


def _write(root: pathlib.Path, state: dict) -> None:
    state["updated_at"] = _now()
    path = run_dir(root, state["run_id"]) / "state.json"
    atomic_json(path, state)


def _target(kind: str, name: str, artifact: str, *, dependencies=(), **spec) -> dict:
    if kind not in KINDS:
        raise StateError(f"unsupported target kind: {kind}")
    return {
        "id": f"{kind}:{name}",
        "kind": kind,
        "name": name,
        "artifact": artifact,
        "depends_on": list(dependencies),
        "status": "pending",
        "attempts": 0,
        "last_error": None,
        "spec": spec,
    }


def _add_target(state: dict, target: dict) -> None:
    if target["id"] in state["targets"]:
        raise StateError(f"duplicate target id: {target['id']}")
    state["targets"][target["id"]] = target


def _plan_scopes(workspace, catalogs: list[dict]) -> list[dict]:
    scopes = [
        {"source": source.name, "paths": ["."]}
        for source in workspace.sources.values()
        if source.kind in ("git", "files")
    ]
    scopes.extend(
        {
            "source": catalog["name"],
            "paths": [table["page_slug"] for table in catalog.get("tables", [])]
            or ["."],
        }
        for catalog in catalogs
    )
    return scopes


@_locked
def start_run(root: pathlib.Path, producer: str, session: str) -> dict:
    import _db
    import _index
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
    revisions: list[dict] = []
    catalogs: list[dict] = []
    try:
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
    except Exception:
        _workspace.remove_run_pins(root, run_id, workspace.sources)
        raise

    state = {
        "version": VERSION,
        "contract": CONTRACT,
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
        "targets": {},
        "review_attempts": [],
        "review_rounds": {},
        "publication": None,
    }
    base = run_dir(root, run_id)
    for relative in (
        "drafts/index",
        "drafts/plan",
        "drafts/dossiers",
        "drafts/composition",
        "drafts/pages",
        "drafts/review",
        "attempts",
        "candidate",
        "proposals",
    ):
        (base / relative).mkdir(parents=True, exist_ok=True)
    for revision in revisions:
        _index.write_source_index(
            root, run_id, workspace.sources[revision["name"]], revision
        )
    plan_scopes = _plan_scopes(workspace, catalogs)
    _add_target(
        state,
        _target(
            "plan",
            "workspace",
            "drafts/plan/workspace.md",
            mode="workspace",
            scopes=plan_scopes,
        ),
    )
    _write(root, state)
    atomic_json(_pointer(root), {"version": VERSION, "run_id": run_id})
    return status(root)


def _ready(state: dict, target: dict) -> bool:
    return target["status"] in ("pending", "failed") and all(
        state["targets"].get(dependency, {}).get("status") == "complete"
        for dependency in target["depends_on"]
    )


def _assert_completed_artifacts(root: pathlib.Path, state: dict) -> None:
    base = run_dir(root, state["run_id"])
    for target in state["targets"].values():
        if target["status"] != "complete":
            continue
        path = base / target["artifact"]
        actual = _file_digest(path) if path.is_file() else directory_digest(path)
        if not path.exists() or actual != target.get("output_digest"):
            raise StateError(f"completed artifact changed: {target['id']}")


def status(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None:
        return {"run": None}
    if state["status"] in ("active", "paused", "approved"):
        _assert_completed_artifacts(root, state)
    ready = [
        target["id"] for target in state["targets"].values() if _ready(state, target)
    ]
    in_progress = [
        target["id"]
        for target in state["targets"].values()
        if target["status"] == "in_progress"
    ]
    if state["status"] == "paused":
        next_actions = ["run resume"]
    elif state["status"] == "approved":
        next_actions = ["publication publish"]
    else:
        next_actions = []
        review_ready = any(item.startswith("review:") for item in ready)
        if review_ready and "review" not in state:
            next_actions.append(
                "review start --actor <producer/version> --session <new-session>"
            )
        next_actions.extend(
            f"task start {target_id}"
            for target_id in ready
            if not target_id.startswith("review:") or "review" in state
        )
        next_actions.extend(
            f"task complete {target_id} --attempt "
            f"{state['targets'][target_id]['active_attempt']['token']}"
            for target_id in in_progress
        )
    return {
        "run_id": state["run_id"],
        "status": state["status"],
        "contract": CONTRACT,
        "ready_targets": ready,
        "in_progress": in_progress,
        "targets": [
            {"id": target["id"], "kind": target["kind"], "status": target["status"]}
            for target in state["targets"].values()
        ],
        "next_actions": next_actions,
        "pause_reason": state.get("pause_reason"),
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


def _reference(target: dict) -> pathlib.Path:
    if target["kind"] == "plan":
        name = "plan.md"
    elif target["kind"] == "page":
        name = {
            "research": "dossier.md",
            "compose": "composition.md",
            "write": "page.md",
        }[target["spec"]["mode"]]
    else:
        name = "review.md"
    return pathlib.Path(__file__).resolve().parent.parent / "references" / name


def _contract() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent / "references/contract.md"


def _template(state: dict, target: dict) -> pathlib.Path | None:
    page = (
        target
        if target["kind"] == "page" and target["spec"].get("mode") == "write"
        else None
    )
    if target["kind"] == "review":
        subject = target["spec"].get("subject", "")
        candidate = state["targets"].get(subject)
        page = (
            candidate
            if candidate and candidate["spec"].get("mode") == "write"
            else None
        )
    if page is None:
        return None
    name = {
        "Overview": "overview.md",
        "Architecture": "architecture.md",
        "Domain": "domain.md",
        "Flow": "flow.md",
        "Lifecycle": "lifecycle.md",
        "DataModel": "data-model.md",
        "Table": "table.md",
    }[page["spec"]["type"]]
    return pathlib.Path(__file__).resolve().parent.parent / "assets/templates" / name


def _scope_digests(root: pathlib.Path, state: dict, target: dict) -> list[dict]:
    import _index
    import _workspace

    workspace = _workspace.load(root)
    revisions = {item["name"]: item for item in state["revisions"]}
    catalogs = {item["name"]: item for item in state["catalogs"]}
    result = []
    for scope in target["spec"].get("scopes", []):
        name = scope["source"]
        paths = scope["paths"]
        revision = revisions.get(name)
        source = workspace.sources.get(name)
        if revision and source and source.kind in ("git", "files"):
            pin = _workspace.pin_dir(root, state["run_id"], name)
            files = _workspace.captured_files(source, pin, revision)
            digest = _index.scope_digest(pin, files, paths)
        elif name in catalogs:
            raw = json.dumps(
                {"content_hash": catalogs[name]["content_hash"], "paths": paths},
                sort_keys=True,
                separators=(",", ":"),
            )
            digest = hashlib.sha256(raw.encode()).hexdigest()
        else:
            raise StateError(f"scope names unknown Source: {name}")
        result.append({"source": name, "paths": paths, "digest": digest})
    return result


def _file_digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _input_digest(root: pathlib.Path, state: dict, target: dict) -> str:
    base = run_dir(root, state["run_id"])
    reference = _reference(target)
    template = _template(state, target)
    dependencies = []
    for target_id in target["depends_on"]:
        dependency = state["targets"].get(target_id)
        if dependency is None or dependency.get("status") != "complete":
            raise StateError(f"target dependency is not complete: {target_id}")
        dependencies.append(
            {
                "id": target_id,
                "output": dependency.get("output_digest"),
                "page_output": dependency.get("page_output_digest"),
                "input": dependency.get("last_attempt", {}).get("input_digest"),
            }
        )
    canonical = base / target["artifact"]
    payload = {
        "spec": target["spec"],
        "scopes": _scope_digests(root, state, target),
        "dependencies": dependencies,
        "language": state["language"],
        "reference": _file_digest(reference),
        "contract": _file_digest(_contract()),
        "template": _file_digest(template) if template else None,
        "prior_output": _file_digest(canonical) if canonical.is_file() else None,
        "prior_checkpoint": target.get("last_attempt", {}).get("checkpoint_digest"),
        "actor": (
            state.get("review", {}).get("actor")
            if target["kind"] == "review"
            else state["producer"]
        ),
        "session": (
            state.get("review", {}).get("session")
            if target["kind"] == "review"
            else state["producer_session"]
        ),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _attempt_file(target: dict, token: str, suffix: str) -> str:
    key = hashlib.sha256(target["id"].encode()).hexdigest()[:16]
    return f"attempts/{key}/{token}{suffix}"


def _attempt_path(target: dict, token: str) -> str:
    suffix = pathlib.PurePosixPath(target["artifact"]).suffix or ".tmp"
    return _attempt_file(target, token, suffix)


def _checkpoint_path(target: dict, token: str) -> str:
    return _attempt_file(target, token, ".checkpoint.md")


def _packet_path(target: dict, token: str) -> str:
    return _attempt_file(target, token, ".packet.json")


def _catalog_inputs(root: pathlib.Path, state: dict, target: dict) -> list[dict]:
    import _db

    selected = {scope["source"] for scope in target["spec"].get("scopes", [])}
    return [
        {
            "role": "catalog_index",
            "source": catalog["name"],
            "path": str(_db.catalog_index_path(root, catalog["content_hash"])),
        }
        for catalog in state["catalogs"]
        if catalog["name"] in selected
    ]


def _dispatch_inputs(root: pathlib.Path, state: dict, target: dict) -> list[dict]:
    base = run_dir(root, state["run_id"])
    result = []
    for target_id in target["depends_on"]:
        dependency = state["targets"][target_id]
        subject = dependency.get("spec", {}).get("subject")
        if dependency["kind"] == "review":
            subject_target = state["targets"][subject]
            result.append(
                {
                    "role": (
                        "subject" if subject == "plan:workspace" else "dependency_page"
                    ),
                    "target": subject,
                    "path": str(base / subject_target["artifact"]),
                }
            )
        elif dependency["kind"] in ("plan", "page"):
            result.append(
                {
                    "role": "subject",
                    "target": dependency["id"],
                    "path": str(base / dependency["artifact"]),
                }
            )
    if target["kind"] == "review":
        subject = state["targets"].get(target["spec"].get("subject"))
        for dependency_id in subject.get("depends_on", []) if subject else []:
            dependency = state["targets"][dependency_id]
            child = dependency.get("spec", {}).get("subject", "")
            if (
                dependency["kind"] == "review"
                and child.startswith("page:")
                and not any(item.get("target") == child for item in result)
            ):
                result.append(
                    {
                        "role": "dependency_page",
                        "target": child,
                        "path": str(base / state["targets"][child]["artifact"]),
                    }
                )
    if target["kind"] == "page" and target["spec"].get("mode") == "write":
        for unit_id in target["spec"].get("units", []):
            dossier = state["targets"].get(f"page:research/{unit_id}")
            if dossier:
                result.append(
                    {
                        "role": "evidence_dossier",
                        "target": dossier["id"],
                        "path": str(base / dossier["artifact"]),
                    }
                )
    canonical = base / target["artifact"]
    if canonical.is_file():
        result.append(
            {
                "role": (
                    "previous_review"
                    if target["kind"] == "review"
                    else "previous_output"
                ),
                "target": target["id"],
                "path": str(canonical),
            }
        )
    checkpoint = target.get("last_attempt", {}).get("checkpoint")
    if checkpoint and (base / checkpoint).is_file():
        result.append(
            {
                "role": "previous_checkpoint",
                "target": target["id"],
                "path": str(base / checkpoint),
            }
        )
    if target["kind"] in ("plan", "review"):
        selected = {scope["source"] for scope in target["spec"].get("scopes", [])}
        result.extend(
            {
                "role": "source_index",
                "source": revision["name"],
                "path": str(base / "drafts/index" / f"{revision['name'].lower()}.md"),
            }
            for revision in state["revisions"]
            if revision["name"] in selected
        )
    result.extend(_catalog_inputs(root, state, target))
    return result


def _dispatch(root: pathlib.Path, state: dict, target: dict) -> dict:
    base = run_dir(root, state["run_id"])
    attempt = target["active_attempt"]
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    inputs = _dispatch_inputs(root, state, target)
    packet = {
        "run_id": state["run_id"],
        "target": {
            "id": target["id"],
            "kind": target["kind"],
            "spec": target["spec"],
            "depends_on": target["depends_on"],
        },
        "attempt": attempt["token"],
        "language": state["language"],
        "reference": str(_reference(target)),
        "contract": str(_contract()),
        "artifact": str(base / attempt["artifact"]),
        "checkpoint": str(base / attempt["checkpoint"]),
        "packet_path": str(base / attempt["packet"]),
        "inputs": inputs,
        "workdir": str(root),
        "complete_command": (
            f"uv run {okf} task complete {target['id']} "
            f"--attempt {attempt['token']} --json"
        ),
        "checkpoint_command": (
            f"uv run {okf} task checkpoint {target['id']} "
            f"--attempt {attempt['token']} --json"
        ),
        "outline_command": (
            f"uv run {okf} task outline {target['id']} --source <source> [path]"
        ),
        "search_command": (
            f"uv run {okf} task search {target['id']} --source <source> "
            "[--path <scope>] <single-literal-query>"
        ),
        "read_command": (f"uv run {okf} task read {target['id']} <source/path#Lx-Ly>"),
        "navigation_budget": dict(
            zip(("calls", "bytes"), _navigation_limits(target), strict=True)
        ),
        "navigation": {"calls_used": 0, "bytes_used": 0},
    }
    template = _template(state, target)
    if template:
        packet["template"] = str(template)
    if target["kind"] == "review":
        subject = target["spec"]["subject"]
        subject_target = state["targets"][subject]
        packet.update(
            {
                "subject": subject,
                "subject_digest": subject_target["output_digest"],
                "review_mode": (
                    "follow_up"
                    if any(item["role"] == "previous_review" for item in inputs)
                    else "initial"
                ),
                "actor": state["review"]["actor"],
                "session": state["review"]["session"],
            }
        )
    return packet


@_locked
def task_start(root: pathlib.Path, target_id: str) -> dict:
    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    target = state["targets"].get(target_id)
    if target is None:
        raise StateError(f"unknown target: {target_id}")
    if not _ready(state, target):
        raise StateError("target is not ready")
    if target["kind"] == "review" and "review" not in state:
        raise StateError("call review start before starting a review target")
    token = f"a{target['attempts'] + 1}-{secrets.token_hex(8)}"
    input_digest = _input_digest(root, state, target)
    target["status"] = "in_progress"
    target["attempts"] += 1
    target["last_error"] = None
    target["active_attempt"] = {
        "token": token,
        "artifact": _attempt_path(target, token),
        "checkpoint": _checkpoint_path(target, token),
        "packet": _packet_path(target, token),
        "input_digest": input_digest,
        "started_at": _now(),
        "navigation": {"calls": 0, "bytes": 0},
    }
    _write(root, state)
    packet = _dispatch(root, state, target)
    atomic_json(
        run_dir(root, state["run_id"]) / target["active_attempt"]["packet"], packet
    )
    return packet


@_locked
def task_packet(root: pathlib.Path, target_id: str, attempt: str) -> dict:
    state = _require_run(root, {"active", "paused"})
    target = state["targets"].get(target_id)
    active = target.get("active_attempt") if target else None
    if not active or active["token"] != attempt:
        raise StateError("stale or inactive target attempt")
    path = run_dir(root, state["run_id"]) / active["packet"]
    try:
        packet = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateError(f"invalid dispatch packet: {exc}") from exc
    packet["navigation"] = {
        "calls_used": active["navigation"]["calls"],
        "bytes_used": active["navigation"]["bytes"],
    }
    return packet


@_locked
def task_checkpoint(root: pathlib.Path, target_id: str, attempt: str) -> dict:
    state = _require_run(root, {"active", "paused"})
    target = state["targets"].get(target_id)
    active = target.get("active_attempt") if target else None
    if not active or active["token"] != attempt:
        raise StateError("stale or inactive target attempt")
    path = run_dir(root, state["run_id"]) / active["checkpoint"]
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError(f"invalid checkpoint: {exc}") from exc
    if len(raw.encode("utf-8")) > MAX_READ_BYTES:
        raise StateError("checkpoint exceeds 64 KiB")
    required = {
        "## Completed",
        "## Findings",
        "## Hypotheses",
        "## Gaps",
        "## Next actions",
    }
    missing = sorted(required - set(raw.splitlines()))
    if missing:
        raise StateError(f"checkpoint is missing headings: {missing}")
    active["checkpoint_digest"] = _file_digest(path)
    active["checkpointed_at"] = _now()
    _write(root, state)
    return {
        "ok": True,
        "target": target_id,
        "checkpoint": str(path),
        "digest": active["checkpoint_digest"],
    }


def _attempt_target(target: dict) -> dict:
    return {**target, "artifact": target["active_attempt"]["artifact"]}


def _render_page_attempt(root: pathlib.Path, state: dict, target: dict) -> None:
    import _validate

    path = run_dir(root, state["run_id"]) / target["active_attempt"]["artifact"]
    if not path.is_file():
        return
    rendered = _validate.render_generated_page(
        root, state, _attempt_target(target), path
    )
    if rendered is not None:
        path.write_text(rendered, encoding="utf-8", newline="\n")


def _promote(root: pathlib.Path, state: dict, target: dict) -> pathlib.Path:
    base = run_dir(root, state["run_id"])
    source = base / target["active_attempt"]["artifact"]
    destination = base / target["artifact"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)
    return destination


def _research_target(unit, *, depth: int = 0) -> dict:
    spec = unit.model_dump(mode="json")
    return _target(
        "page",
        f"research/{unit.id}",
        f"drafts/dossiers/{unit.id}.md",
        dependencies=["review:plan"],
        mode="research",
        unit_id=unit.id,
        unit_kind=unit.kind,
        depth=depth,
        **{key: value for key, value in spec.items() if key not in {"id", "kind"}},
    )


def _materialize_knowledge_plan(
    root: pathlib.Path, state: dict, plan: KnowledgePlan
) -> None:
    keep = {"plan:workspace"}
    desired = {
        "review:plan": _target(
            "review",
            "plan",
            "drafts/review/plan.json",
            dependencies=["plan:workspace"],
            subject="plan:workspace",
            scopes=state["targets"]["plan:workspace"]["spec"]["scopes"],
        ),
        **{f"page:research/{unit.id}": _research_target(unit) for unit in plan.units},
    }
    _replace_downstream(root, state, keep, desired)


def _materialize_dossier_children(
    root: pathlib.Path,
    state: dict,
    target: dict,
    dossier: KnowledgeDossier,
) -> None:
    if dossier.disposition != "split":
        return
    depth = target["spec"]["depth"] + 1
    if depth > 3:
        raise StateError("knowledge dossier split depth exceeds 3")
    target["spec"]["superseded"] = True
    for unit in dossier.children:
        child = _research_target(unit, depth=depth)
        if child["id"] in state["targets"]:
            raise StateError(f"duplicate dossier child target: {child['id']}")
        _add_target(state, child)
    if (
        sum(
            item["spec"].get("mode") == "research"
            for item in state["targets"].values()
            if item["kind"] == "page"
        )
        > 96
    ):
        raise StateError("knowledge dossier count exceeds 96")


def _sync_composition_target(state: dict) -> None:
    research = [
        target
        for target in state["targets"].values()
        if target["kind"] == "page" and target["spec"].get("mode") == "research"
    ]
    if not research or any(target["status"] != "complete" for target in research):
        return
    target_id = "page:compose"
    dependencies = [target["id"] for target in research]
    current = state["targets"].get(target_id)
    desired = _target(
        "page",
        "compose",
        "drafts/composition/map.md",
        dependencies=dependencies,
        mode="compose",
        scopes=state["targets"]["plan:workspace"]["spec"]["scopes"],
    )
    if current is None:
        _add_target(state, desired)
    elif current["depends_on"] != dependencies:
        current["depends_on"] = dependencies
        _reset_target(current)


def _composition_targets(plan: CompositionMap) -> dict[str, dict]:
    targets = {
        "review:composition": _target(
            "review",
            "composition",
            "drafts/review/composition.json",
            dependencies=["page:compose"],
            subject="page:compose",
            scopes=[],
        )
    }
    for page in plan.pages:
        spec = page.model_dump(mode="json")
        page_target = f"page:write/{page.id}"
        targets[page_target] = _target(
            "page",
            f"write/{page.id}",
            f"drafts/pages/{page.id}.md",
            dependencies=[
                "review:composition",
                *[f"review:{dependency}" for dependency in page.depends_on],
            ],
            mode="write",
            **spec,
        )
        targets[f"review:{page.id}"] = _target(
            "review",
            page.id,
            f"drafts/review/pages/{page.id}.json",
            dependencies=[page_target, "review:composition"],
            subject=page_target,
            owner=page.owner,
            scopes=[scope.model_dump(mode="json") for scope in page.scopes],
        )
    return targets


def _materialize_composition(
    root: pathlib.Path, state: dict, plan: CompositionMap
) -> None:
    keep = {
        target_id
        for target_id, target in state["targets"].items()
        if target["kind"] == "plan"
        or target_id == "review:plan"
        or target["spec"].get("mode") in {"research", "compose"}
    }
    replacements = _composition_targets(plan)
    for page in plan.pages:
        target_id = f"page:write/{page.id}"
        previous = state["targets"].get(target_id)
        desired = replacements[target_id]
        if previous is None or _target_definition(previous) == _target_definition(
            desired
        ):
            continue
        changes = {
            key
            for key in set(previous["spec"]) | set(desired["spec"])
            if previous["spec"].get(key) != desired["spec"].get(key)
        }
        if changes != {"path"}:
            review = state["targets"].get(f"review:{page.id}")
            if review:
                _discard_attempt(root, state, review)
                _reset_target(review)
    _replace_downstream(root, state, keep, replacements, preserve_moves=True)


def _target_definition(target: dict) -> dict:
    return {
        key: target[key]
        for key in ("id", "kind", "name", "artifact", "depends_on", "spec")
    }


def _dependent_closure(targets: dict[str, dict], seeds: set[str]) -> set[str]:
    affected = set(seeds)
    while True:
        dependents = {
            target_id
            for target_id, target in targets.items()
            if affected.intersection(target["depends_on"])
        }
        if dependents <= affected:
            return affected
        affected.update(dependents)


def _discard_attempt(root: pathlib.Path, state: dict, target: dict) -> None:
    active = target.get("active_attempt")
    if active:
        base = run_dir(root, state["run_id"])
        (base / active["artifact"]).unlink(missing_ok=True)
        if active.get("packet"):
            (base / active["packet"]).unlink(missing_ok=True)


def _replace_downstream(
    root: pathlib.Path,
    state: dict,
    keep: set[str],
    replacements: dict[str, dict],
    *,
    preserve_moves: bool = False,
) -> None:
    old = state["targets"]
    desired = {target_id: old[target_id] for target_id in keep if target_id in old}
    desired.update(replacements)
    base = run_dir(root, state["run_id"])
    for target_id in set(old) - set(desired):
        _discard_attempt(root, state, old[target_id])
        (base / old[target_id]["artifact"]).unlink(missing_ok=True)
    reconciled = {
        target_id: desired[target_id] for target_id in keep if target_id in desired
    }
    for target_id, target in replacements.items():
        previous = old.get(target_id)
        if previous is not None and _target_definition(previous) == _target_definition(
            target
        ):
            reconciled[target_id] = previous
            continue
        spec_changes = (
            {
                key
                for key in set(previous["spec"]) | set(target["spec"])
                if previous["spec"].get(key) != target["spec"].get(key)
            }
            if previous
            else set()
        )
        if (
            preserve_moves
            and previous
            and previous["kind"] == "page"
            and previous["spec"].get("mode") == "write"
            and previous["status"] == "complete"
            and spec_changes
            and spec_changes <= {"path", "title", "description", "tags"}
            and previous["depends_on"] == target["depends_on"]
        ):
            previous["spec"].update(target["spec"])
            if spec_changes - {"path"}:
                import _validate

                path = base / previous["artifact"]
                rendered = _validate.render_generated_page(root, state, previous, path)
                if rendered is None:
                    raise StateError(
                        f"cannot refresh composed metadata for {target_id}"
                    )
                path.write_text(rendered, encoding="utf-8", newline="\n")
                previous["output_digest"] = _file_digest(path)
            reconciled[target_id] = previous
            continue
        if previous is not None:
            _discard_attempt(root, state, previous)
            (base / previous["artifact"]).unlink(missing_ok=True)
        reconciled[target_id] = target
    state["targets"] = reconciled


def _reset_target(target: dict) -> None:
    target["status"] = "pending"
    target["last_error"] = None
    target.pop("active_attempt", None)
    target.pop("completed_at", None)
    target.pop("output_digest", None)
    target.pop("page_output_digest", None)


def _invalidate_targets(root: pathlib.Path, state: dict, seeds: set[str]) -> None:
    for target_id in _dependent_closure(state["targets"], seeds):
        target = state["targets"].get(target_id)
        if target is not None and target["kind"] != "plan":
            _discard_attempt(root, state, target)
            _reset_target(target)


def _reopen_plan(root: pathlib.Path, state: dict) -> None:
    plan = state["targets"]["plan:workspace"]
    _discard_attempt(root, state, plan)
    _reset_target(plan)
    _replace_downstream(root, state, {"plan:workspace"}, {})


def _reopen_composition(root: pathlib.Path, state: dict) -> None:
    for target_id in ("page:compose", "review:composition"):
        target = state["targets"].get(target_id)
        if target:
            _discard_attempt(root, state, target)
            _reset_target(target)


def _reopen_research(root: pathlib.Path, state: dict, target_id: str) -> None:
    target = state["targets"][target_id]
    _discard_attempt(root, state, target)
    _reset_target(target)
    keep = {
        item_id
        for item_id, item in state["targets"].items()
        if item["kind"] == "plan"
        or item_id == "review:plan"
        or item["spec"].get("mode") == "research"
    }
    _replace_downstream(root, state, keep, {})


def _stamp_reviewed_page(
    root: pathlib.Path, state: dict, target: dict, actor: str
) -> str:
    from _frontmatter import parse_file, render

    page_target = state["targets"][target["depends_on"][0]]
    path = run_dir(root, state["run_id"]) / page_target["artifact"]
    parsed = parse_file(path)
    if parsed.errors:
        raise StateError(f"cannot stamp invalid page: {parsed.errors[0]}")
    now = datetime.now(timezone.utc)
    verified = parsed.meta.get("verified", [])
    if isinstance(verified, dict):
        verified = [verified]
    verified = [item for item in verified if item.get("by") != actor]
    verified.append({"by": actor, "at": now})
    parsed.meta["verified"] = verified
    parsed.meta["status"] = "stable"
    parsed.meta["stale_after"] = (now + timedelta(days=state["freshness_days"])).date()
    path.write_text(render(parsed.meta, parsed.body), encoding="utf-8", newline="\n")
    digest = _file_digest(path)
    page_target["output_digest"] = digest
    return digest


def _finish_review(
    root: pathlib.Path, state: dict, target: dict, report: ReviewReport
) -> dict:
    subject = target["spec"]["subject"]
    subject_target = state["targets"][subject]
    if report.subject != subject or report.subject_digest != subject_target.get(
        "output_digest"
    ):
        raise StateError("review report does not match the current subject digest")
    state["review_attempts"].append(
        {
            "actor": state["review"]["actor"],
            "session": state["review"]["session"],
            "submitted_at": _now(),
            **report.model_dump(mode="json"),
        }
    )
    if report.verdict == "changes_requested":
        rounds = state["review_rounds"].get(subject, 0) + 1
        state["review_rounds"][subject] = rounds
        reopened = {issue.reopen_target for issue in report.issues}
        if "plan:workspace" in reopened:
            _reopen_plan(root, state)
        elif "page:compose" in reopened:
            _reopen_composition(root, state)
            if subject.startswith("page:write/"):
                _reset_target(target)
        elif any(item.startswith("page:research/") for item in reopened):
            for item in reopened:
                if item.startswith("page:research/"):
                    _reopen_research(root, state, item)
        else:
            _invalidate_targets(root, state, reopened)
        if rounds >= MAX_REVIEW_CHANGES:
            state["status"] = "paused"
            state["pause_reason"] = {
                "code": "review-convergence-limit",
                "subject": subject,
                "rounds": rounds,
            }
        return {
            "verdict": report.verdict,
            "ok": True,
            "review_round": rounds,
            "paused": state["status"] == "paused",
        }
    state["review_rounds"].pop(subject, None)
    if subject.startswith("page:write/"):
        target["page_output_digest"] = _stamp_reviewed_page(
            root, state, target, state["review"]["actor"]
        )
    return {"verdict": report.verdict, "ok": True}


def _maybe_approve(root: pathlib.Path, state: dict) -> None:
    import _validate

    if not state["targets"] or not all(
        target["status"] == "complete" for target in state["targets"].values()
    ):
        return
    _bind_candidate(root, state)
    issues = _validate.validate_candidate(root, state, published=False)
    errors = [item for item in issues if item.severity == "error"]
    if errors:
        raise StateError(
            f"candidate validation failed: {[item.to_dict() for item in errors[:3]]}"
        )
    state["approved_digest"] = directory_digest(candidate_dir(root, state))
    state["approved_at"] = _now()
    state["status"] = "approved"


_LOGICAL_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\[([a-z0-9][a-z0-9.-]*)\]")


def _markdown_model(path: pathlib.Path, model):
    parsed = parse_file(path)
    if parsed.errors:
        raise StateError(f"invalid Markdown artifact {path}: {parsed.errors[0]}")
    return model.model_validate(parsed.meta, strict=True)


def _composition(root: pathlib.Path, state: dict) -> CompositionMap:
    path = run_dir(root, state["run_id"]) / state["targets"]["page:compose"]["artifact"]
    return _markdown_model(path, CompositionMap)


def _bind_candidate(root: pathlib.Path, state: dict) -> None:
    from _frontmatter import render

    base = run_dir(root, state["run_id"])
    candidate = candidate_dir(root, state)
    shutil.rmtree(candidate, ignore_errors=True)
    candidate.mkdir(parents=True)
    plan = _composition(root, state)
    paths = {page.id: page.path for page in plan.pages}

    def resolve(match: re.Match) -> str:
        label, page_id = match.groups()
        path = paths.get(page_id)
        if path is None:
            raise StateError(f"unknown logical page link: {page_id}")
        return f"[{label}](/{path})"

    for page in plan.pages:
        source = base / state["targets"][f"page:write/{page.id}"]["artifact"]
        parsed = parse_file(source)
        if parsed.errors:
            raise StateError(f"cannot bind invalid page {page.id}: {parsed.errors[0]}")
        body = _LOGICAL_LINK.sub(resolve, parsed.body)
        destination = candidate / page.path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            render(parsed.meta, body), encoding="utf-8", newline="\n"
        )


@_locked
def task_complete(root: pathlib.Path, target_id: str, attempt: str) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    target = state["targets"].get(target_id)
    if target is None:
        raise StateError(f"unknown target: {target_id}")
    active = target.get("active_attempt")
    if target["status"] != "in_progress" or not active or active["token"] != attempt:
        raise StateError("stale or inactive target attempt")
    if _input_digest(root, state, target) != active["input_digest"]:
        raise StateError("target inputs changed during the attempt")
    if target["kind"] == "page" and target["spec"].get("mode") == "write":
        _render_page_attempt(root, state, target)
    if target["kind"] == "plan" or (
        target["kind"] == "page" and target["spec"].get("mode") == "compose"
    ):
        checkpoint = active.get("checkpoint_digest")
        checkpoint_path = run_dir(root, state["run_id"]) / active["checkpoint"]
        if (
            not checkpoint
            or not checkpoint_path.is_file()
            or _file_digest(checkpoint_path) != checkpoint
        ):
            raise StateError(
                "plan and composition attempts require a current checkpoint"
            )
    attempt_target = _attempt_target(target)
    issues = _validate.validate_task(root, state, attempt_target)
    errors = [item for item in issues if item.severity == "error"]
    if errors:
        return {"ok": False, "issues": [item.to_dict() for item in errors]}

    attempt_path = run_dir(root, state["run_id"]) / active["artifact"]
    report = None
    value = None
    if target["kind"] == "plan":
        value = _markdown_model(attempt_path, KnowledgePlan)
    elif target["kind"] == "page" and target["spec"].get("mode") == "research":
        value = _markdown_model(attempt_path, KnowledgeDossier)
    elif target["kind"] == "page" and target["spec"].get("mode") == "compose":
        value = _markdown_model(attempt_path, CompositionMap)
    elif target["kind"] == "review":
        report = ReviewReport.model_validate_json(
            attempt_path.read_text(encoding="utf-8"), strict=True
        )
    canonical = _promote(root, state, target)
    if active.get("packet"):
        (run_dir(root, state["run_id"]) / active["packet"]).unlink(missing_ok=True)
    target["status"] = "complete"
    target["completed_at"] = _now()
    target["output_digest"] = _file_digest(canonical)
    target["last_attempt"] = active
    target.pop("active_attempt", None)
    result = {"ok": True}
    if isinstance(value, KnowledgePlan):
        _materialize_knowledge_plan(root, state, value)
    elif isinstance(value, KnowledgeDossier):
        _materialize_dossier_children(root, state, target, value)
        _sync_composition_target(state)
    elif isinstance(value, CompositionMap):
        _materialize_composition(root, state, value)
    elif report is not None:
        result.update(_finish_review(root, state, target, report))
    _maybe_approve(root, state)
    _write(root, state)
    result["state"] = status(root)
    return result


@_locked
def task_fail(
    root: pathlib.Path, target_id: str, reason: str, attempt: str | None = None
) -> dict:
    state = _require_run(root, {"active"})
    target = state["targets"].get(target_id)
    if target is None:
        raise StateError(f"unknown target: {target_id}")
    active = target.get("active_attempt")
    if target["status"] != "in_progress" or not active:
        raise StateError("only an in-progress target can fail")
    if attempt is not None and active["token"] != attempt:
        raise StateError("stale target attempt")
    _discard_attempt(root, state, target)
    target["status"] = "failed"
    target["last_error"] = reason
    target["last_attempt"] = active
    target.pop("active_attempt", None)
    _write(root, state)
    return status(root)


@_locked
def review_start(root: pathlib.Path, actor: str, session: str) -> dict:
    state = _require_run(root, {"active"})
    if not _agent_actor(actor):
        raise StateError("reviewer must follow <producer>/<version>")
    if not session or session == state["producer_session"]:
        raise StateError("review session must be distinct from the producer session")
    current = state.get("review")
    if (
        current
        and current != {"actor": actor, "session": session}
        and any(
            target["kind"] == "review" and target["status"] == "in_progress"
            for target in state["targets"].values()
        )
    ):
        raise StateError("cannot replace a reviewer with review attempts in progress")
    state["review"] = {"actor": actor, "session": session}
    _write(root, state)
    ready = [
        target["id"]
        for target in state["targets"].values()
        if target["kind"] == "review" and _ready(state, target)
    ]
    return {
        "run_id": state["run_id"],
        "actor": actor,
        "session": session,
        "ready_targets": ready,
        "start_commands": [f"task start {target_id}" for target_id in ready],
        "workdir": str(root),
    }


def _target_scopes(target: dict, source: str) -> list[str]:
    return [
        path
        for scope in target["spec"].get("scopes", [])
        if scope["source"] == source
        for path in scope["paths"]
    ]


def _navigation_context(
    root: pathlib.Path, target_id: str, source_name: str
) -> tuple[dict, dict, pathlib.Path, list[str], list[str]]:
    import _workspace

    state = _require_run(root, {"active"})
    target = state["targets"].get(target_id)
    if target is None or target["status"] != "in_progress":
        raise StateError("navigation requires an in-progress target")
    roots = _target_scopes(target, source_name)
    if not roots:
        raise StateError(f"Source is outside target scope: {source_name}")
    workspace = _workspace.load(root)
    source = workspace.sources.get(source_name)
    revision = next(
        (item for item in state["revisions"] if item["name"] == source_name), None
    )
    if source is None or revision is None or source.kind not in ("git", "files"):
        raise StateError(f"navigation requires a Git/files Source: {source_name}")
    pin = _workspace.pin_dir(root, state["run_id"], source_name)
    files = _workspace.captured_files(source, pin, revision)
    scoped = _workspace.scoped_files(files, roots)
    return state, target, pin, scoped, roots


def _normalized_path(value: str) -> str:
    pure = pathlib.PurePosixPath(value)
    windows = pathlib.PureWindowsPath(value)
    if (
        not value
        or "\\" in value
        or pure.is_absolute()
        or bool(windows.drive)
        or ".." in pure.parts
        or (value != "." and pure.as_posix() != value)
    ):
        raise StateError("path must be a normalized relative POSIX path")
    return value


def _inside_roots(path: str, roots: list[str]) -> bool:
    return any(
        root == "." or path == root or path.startswith(root.rstrip("/") + "/")
        for root in roots
    )


def _navigation_limits(target: dict) -> tuple[int, int]:
    base_calls, base_bytes, source_calls, source_bytes, max_calls, max_bytes = (
        NAVIGATION_LIMITS[target["kind"]]
    )
    source_count = len({scope["source"] for scope in target["spec"].get("scopes", [])})
    return (
        min(max_calls, base_calls + source_calls * source_count),
        min(max_bytes, base_bytes + source_bytes * source_count),
    )


def _finish_navigation(
    root: pathlib.Path, state: dict, target: dict, result: dict
) -> dict:
    calls_limit, bytes_limit = _navigation_limits(target)
    usage = target["active_attempt"]["navigation"]
    response_bytes = len(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    if (
        usage["calls"] + 1 > calls_limit
        or usage["bytes"] + response_bytes > bytes_limit
    ):
        raise StateError(
            "navigation budget exhausted; finish from gathered evidence or fail the target"
        )
    usage["calls"] += 1
    usage["bytes"] += response_bytes
    result["navigation"] = {
        "calls_used": usage["calls"],
        "calls_limit": calls_limit,
        "bytes_used": usage["bytes"],
        "bytes_limit": bytes_limit,
    }
    _write(root, state)
    return result


@_locked
def task_outline(
    root: pathlib.Path,
    target_id: str,
    source: str,
    path: str = ".",
    after: str | None = None,
) -> dict:
    import _index

    state, target, _, files, roots = _navigation_context(root, target_id, source)
    path = _normalized_path(path)
    if not _inside_roots(path, roots):
        raise StateError(f"path is outside target scope: {path}")
    try:
        result = _index.list_directory(source, path, files, after=after)
    except ValueError as exc:
        raise StateError(str(exc)) from exc
    return _finish_navigation(root, state, target, result)


@_locked
def task_search(
    root: pathlib.Path,
    target_id: str,
    source: str,
    query: str,
    path: str = ".",
) -> dict:
    import _workspace

    state, target, pin, files, roots = _navigation_context(root, target_id, source)
    path = _normalized_path(path)
    if not query or len(query) > 256:
        raise StateError("query must contain 1..256 characters")
    if not _inside_roots(path, roots):
        raise StateError(f"path is outside target scope: {path}")
    selected = [
        rel
        for rel in files
        if path == "." or rel == path or rel.startswith(path.rstrip("/") + "/")
    ]
    results = []
    used = 0
    for rel in selected:
        disk = _workspace.resolve_pin_file(pin, rel)
        if disk is None:
            continue
        try:
            with disk.open(encoding="utf-8") as handle:
                for line_no, line in enumerate(handle, 1):
                    if query not in line:
                        continue
                    text = line.rstrip("\r\n")[:500]
                    size = len((rel + text).encode("utf-8"))
                    if (
                        len(results) >= MAX_SEARCH_RESULTS
                        or used + size > MAX_SEARCH_BYTES
                    ):
                        return _finish_navigation(
                            root,
                            state,
                            target,
                            {"results": results, "truncated": True},
                        )
                    results.append(
                        {"locator": f"{source}/{rel}#L{line_no}", "text": text}
                    )
                    used += size
        except (OSError, UnicodeDecodeError):
            continue
    return _finish_navigation(
        root, state, target, {"results": results, "truncated": False}
    )


@_locked
def task_read(
    root: pathlib.Path,
    target_id: str,
    locator: str,
) -> dict:
    import _workspace
    from _validate import parse_resource

    parsed = parse_resource(locator)
    if parsed is None:
        raise StateError("read requires a canonical source/path#Lx-Ly locator")
    source, path, start, end = parsed
    state, target, pin, files, roots = _navigation_context(root, target_id, source)
    if path not in files or not _inside_roots(path, roots):
        raise StateError(f"file is outside target scope: {path}")
    start = start or 1
    if end is not None and end < start:
        raise StateError("end must not precede start")
    end = min(start + MAX_READ_LINES - 1, end if end is not None else start + 39)
    disk = _workspace.resolve_pin_file(pin, path)
    if disk is None:
        raise StateError(f"file is not a regular file inside the Pin: {path}")
    try:
        lines = disk.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError(f"file is not readable UTF-8 text: {path}") from exc
    numbered = [
        f"{index}|{lines[index - 1][:500]}"
        for index in range(start, min(end, len(lines)) + 1)
    ]
    text = "\n".join(numbered)
    raw = text.encode("utf-8")
    truncated = end < len(lines)
    if len(raw) > MAX_READ_BYTES:
        text = raw[:MAX_READ_BYTES].decode("utf-8", errors="ignore")
        truncated = True
    actual_end = min(end, len(lines))
    result = {
        "locator": (
            f"{source}/{path}#L{start}-L{actual_end}"
            if actual_end >= start
            else f"{source}/{path}"
        ),
        "source": source,
        "path": path,
        "start": start,
        "end": actual_end,
        "text": text + ("\n" if text else ""),
        "truncated": truncated,
    }
    return _finish_navigation(root, state, target, result)


@_locked
def pause(root: pathlib.Path) -> dict:
    state = _require_run(root, {"active"})
    state["status"] = "paused"
    _write(root, state)
    return status(root)


@_locked
def resume(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None or state["status"] != "paused":
        raise StateError("run is not paused")
    assert_revisions_current(root, state)
    reason = state.pop("pause_reason", None)
    if isinstance(reason, dict) and reason.get("code") == "review-convergence-limit":
        state["review_rounds"].pop(reason.get("subject"), None)
    state["status"] = "active"
    _write(root, state)
    return status(root)


@_locked
def refresh_source(root: pathlib.Path, name: str) -> dict:
    import _index
    import _workspace

    state = _require_run(root, {"active", "paused", "approved"})
    workspace = _workspace.load(root)
    source = workspace.sources.get(name)
    if source is None or source.kind not in ("git", "files"):
        raise StateError(f"refresh requires a Git/files Source: {name}")
    record = (
        _workspace.capture_git_revision(root, source)
        if source.kind == "git"
        else _workspace.capture_files_revision(root, source)
    )
    previous = next(item for item in state["revisions"] if item["name"] == name)
    if record == previous:
        return status(root)
    try:
        _workspace.remove_pin(root, state["run_id"], source)
        _workspace.materialize_pin(root, state["run_id"], source, record)
        state["revisions"] = [
            record if item["name"] == name else item for item in state["revisions"]
        ]
        _index.write_source_index(root, state["run_id"], source, record)
        _reopen_plan(root, state)
        state["status"] = "active" if state["status"] != "paused" else "paused"
        state.pop("approved_digest", None)
        state.pop("approved_at", None)
        _write(root, state)
    except Exception:
        _workspace.remove_pin(root, state["run_id"], source)
        _workspace.materialize_pin(root, state["run_id"], source, previous)
        _index.write_source_index(root, state["run_id"], source, previous)
        raise
    return status(root)


@_locked
def propose_start(root: pathlib.Path) -> dict:
    state = read(root)
    if state is None or state["status"] != "published":
        raise StateError("propose runs against a published run")
    proposals = run_dir(root, state["run_id"]) / "proposals"
    proposals.mkdir(parents=True, exist_ok=True)
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    return {
        "run_id": state["run_id"],
        "language": state["language"],
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references" / "propose.md"
        ),
        "artifact": str(proposals),
        "candidate": _publication_path(root),
        "inputs": [str(run_dir(root, state["run_id"]) / "drafts/plan/workspace.md")],
        "complete_command": f"uv run {okf} propose complete --json",
        "workdir": str(root),
    }


def _publication_path(root: pathlib.Path) -> str:
    import _publish

    current = _publish.current(root)
    if current is None:
        raise StateError("nothing has been published")
    return current["path"]


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
    for source in workspace.sources.values():
        if source.kind == "git":
            _workspace.remove_pin(root, state["run_id"], source)
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
