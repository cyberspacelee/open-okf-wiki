import functools
import hashlib
import json
import os
import pathlib
import re
import shutil
import time
from datetime import datetime, timedelta, timezone

from _files import atomic_json, directory_digest
from _frontmatter import parse_file, parse_page, render
from _models import CompositionMap, KnowledgePlan, ReviewReport

VERSION = 3
CONTRACT = "artifact-loop-late-bind"
LOCK_TIMEOUT_SEC = 60
MAX_SEARCH_RESULTS = 20
MAX_SEARCH_BYTES = 8 * 1024
MAX_READ_LINES = 200
MAX_READ_BYTES = 64 * 1024


class StateError(Exception):
    pass


def _meta(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki"


def _pointer(root: pathlib.Path) -> pathlib.Path:
    return _meta(root) / "current-run.json"


def run_dir(root: pathlib.Path, run_id: str) -> pathlib.Path:
    return _meta(root) / "runs" / run_id


def work_dir(root: pathlib.Path, state: dict) -> pathlib.Path:
    return run_dir(root, state["run_id"]) / "work"


def candidate_dir(root: pathlib.Path, state: dict) -> pathlib.Path:
    return run_dir(root, state["run_id"]) / "candidate"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _read_pointer(root: pathlib.Path) -> str | None:
    path = _pointer(root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        run_id = data["run_id"]
        if data.get("version") != VERSION or not re.fullmatch(
            r"r-\d{8}T\d{12}Z", run_id
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
        or "targets" in state
        or "tasks" in state
    ):
        raise StateError(f"legacy or unsupported run state; {CONTRACT} is required")
    return state


def _write(root: pathlib.Path, state: dict) -> None:
    state["updated_at"] = _now()
    atomic_json(run_dir(root, state["run_id"]) / "state.json", state)


def _artifact_paths(root: pathlib.Path, state: dict) -> dict[str, str]:
    work = work_dir(root, state)
    base = run_dir(root, state["run_id"])
    return {
        "plan": str(work / "plan.md"),
        "progress": str(work / "progress.md"),
        "evidence": str(work / "evidence"),
        "composition": str(work / "composition.md"),
        "drafts": str(work / "drafts"),
        "review": str(work / "review.json"),
        "candidate": str(base / "candidate"),
        "indexes": str(base / "index"),
    }


@_locked
def start_run(root: pathlib.Path) -> dict:
    import _db
    import _index
    import _workspace

    existing = read(root)
    if existing and existing["status"] not in ("published", "abandoned"):
        raise StateError(f"run {existing['run_id']} is still {existing['status']}")
    workspace = _workspace.load(root)
    if not workspace.sources:
        raise StateError("at least one source is required")

    run_id = datetime.now(timezone.utc).strftime("r-%Y%m%dT%H%M%S%fZ")
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

    started = _now()
    state = {
        "version": VERSION,
        "contract": CONTRACT,
        "run_id": run_id,
        "status": "active",
        "started_at": started,
        "updated_at": started,
        "language": workspace.language,
        "freshness_days": workspace.freshness_days,
        "revisions": revisions,
        "catalogs": catalogs,
    }
    base = run_dir(root, run_id)
    for relative in ("index", "work/evidence", "work/drafts", "candidate", "proposals"):
        (base / relative).mkdir(parents=True, exist_ok=True)
    for revision in revisions:
        _index.write_source_index(
            root, run_id, workspace.sources[revision["name"]], revision
        )
    _write(root, state)
    atomic_json(_pointer(root), {"version": VERSION, "run_id": run_id})
    return status(root)


def _errors(items) -> list[dict]:
    return [item.to_dict() for item in items if item.severity == "error"]


def _work_digest(root: pathlib.Path, state: dict) -> str:
    work = work_dir(root, state)
    files = [
        work / "plan.md",
        work / "composition.md",
        *sorted((work / "drafts").glob("*.md")),
    ]
    payload = {
        "artifacts": [
            {
                "path": path.relative_to(work).as_posix(),
                "digest": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in files
        ],
        "revisions": state["revisions"],
        "catalogs": [
            {"name": item["name"], "content_hash": item["content_hash"]}
            for item in state["catalogs"]
        ],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _status_payload(
    root: pathlib.Path,
    state: dict,
    phase: str,
    next_actions: list[str],
    *,
    issues: list[dict] | None = None,
) -> dict:
    return {
        "run_id": state["run_id"],
        "status": state["status"],
        "phase": phase,
        "contract": CONTRACT,
        "artifacts": _artifact_paths(root, state),
        "issues": (issues or [])[:50],
        "next_actions": next_actions,
        "block_reason": state.get("block_reason"),
        "run_dir": str(run_dir(root, state["run_id"])),
    }


def status(root: pathlib.Path) -> dict:
    import _validate

    state = read(root)
    if state is None:
        return {"run": None, "next_actions": ["run start"]}
    if state["status"] == "published":
        return _status_payload(root, state, "done", [])
    if state["status"] == "abandoned":
        return _status_payload(root, state, "done", [])
    if state["status"] == "blocked":
        return _status_payload(root, state, "blocked", ["run resume"])
    if state["status"] == "approved":
        return _status_payload(root, state, "publish", ["publication publish"])

    assert_revisions_current(root, state)
    paths = _artifact_paths(root, state)
    plan, plan_issues = _validate.validate_plan_artifact(
        root, state, pathlib.Path(paths["plan"])
    )
    errors = _errors(plan_issues)
    if errors:
        return _status_payload(
            root, state, "plan", ["repair work/plan.md"], issues=errors
        )

    composition, composition_issues = _validate.validate_composition_artifact(
        pathlib.Path(paths["composition"]), plan
    )
    errors = _errors(composition_issues)
    if errors:
        return _status_payload(
            root, state, "write", ["repair work/composition.md"], issues=errors
        )

    draft_issues = _validate.validate_drafts(
        root, state, plan, composition, pathlib.Path(paths["drafts"])
    )
    errors = _errors(draft_issues)
    if errors:
        return _status_payload(
            root, state, "write", ["repair work/drafts"], issues=errors
        )

    current_work = _work_digest(root, state)
    candidate = pathlib.Path(paths["candidate"])
    if (
        state.get("candidate_inputs_digest") != current_work
        or not candidate.is_dir()
        or state.get("candidate_digest") != directory_digest(candidate)
    ):
        return _status_payload(root, state, "review", ["review prepare"])

    report, review_issues = _validate.validate_review(
        pathlib.Path(paths["review"]),
        state["review_subject_digest"],
        {page.id for page in composition.pages},
    )
    errors = _errors(review_issues)
    if errors:
        return _status_payload(root, state, "review", ["review prepare"], issues=errors)
    if report.verdict == "changes_requested":
        return _status_payload(
            root,
            state,
            "repair",
            ["repair the issues in work/review.json", "review prepare"],
            issues=[item.model_dump(mode="json") for item in report.issues],
        )
    return _status_payload(root, state, "review", ["review complete"])


def assert_revisions_current(root: pathlib.Path, state: dict) -> None:
    import _workspace

    workspace = _workspace.load(root)
    for record in state["revisions"]:
        source = workspace.sources.get(record["name"])
        if source is None or source.kind not in ("git", "files"):
            raise StateError(f"source missing during run: {record['name']}")
        _workspace.assert_pin_current(root, state["run_id"], source, record)


def _markdown_model(path: pathlib.Path, model):
    parsed = parse_file(path)
    if parsed.errors:
        raise StateError(f"invalid Markdown artifact {path}: {parsed.errors[0]}")
    return model.model_validate(parsed.meta, strict=True)


_LOGICAL_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\[([a-z0-9][a-z0-9.-]*)\]")


def _bind_candidate(
    root: pathlib.Path,
    state: dict,
    plan: KnowledgePlan,
    composition: CompositionMap,
) -> None:
    import _validate

    work = work_dir(root, state)
    paths = {page.id: page.path for page in composition.pages}
    candidate = candidate_dir(root, state)
    shutil.rmtree(candidate, ignore_errors=True)
    candidate.mkdir(parents=True)

    def resolve(match: re.Match) -> str:
        label, page_id = match.groups()
        path = paths.get(page_id)
        if path is None:
            raise StateError(f"unknown logical page link: {page_id}")
        return f"[{label}](/{path})"

    for page in composition.pages:
        draft = work / "drafts" / f"{page.id}.md"
        spec = _validate.page_spec(plan, page)
        rendered = _validate.render_generated_page(root, state, spec, draft)
        if rendered is None:
            raise StateError(f"cannot bind invalid page draft: {page.id}")
        parsed = parse_page(rendered)
        if parsed.errors:
            raise StateError(f"cannot bind invalid rendered page: {parsed.errors[0]}")
        body = _LOGICAL_LINK.sub(resolve, parsed.body)
        destination = candidate / page.path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            render(parsed.meta, body), encoding="utf-8", newline="\n"
        )


def _review_subject_digest(root: pathlib.Path, state: dict) -> str:
    payload = (
        f"{_work_digest(root, state)}:{directory_digest(candidate_dir(root, state))}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


@_locked
def review_prepare(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    errors = _errors(issues)
    if plan is not None:
        composition, composition_issues = _validate.validate_composition_artifact(
            work / "composition.md", plan
        )
        errors.extend(_errors(composition_issues))
    else:
        composition = None
    if plan is not None and composition is not None:
        errors.extend(
            _errors(
                _validate.validate_drafts(
                    root, state, plan, composition, work / "drafts"
                )
            )
        )
    if errors:
        return {"ok": False, "issues": errors[:50], "state": status(root)}

    review_path = work / "review.json"
    previous_review = None
    if review_path.is_file():
        try:
            report = ReviewReport.model_validate_json(
                review_path.read_text(encoding="utf-8"), strict=True
            )
            if report.verdict == "changes_requested":
                previous_review = {
                    "artifact": str(review_path),
                    "issue_count": len(report.issues),
                }
        except (OSError, ValueError):
            pass

    _bind_candidate(root, state, plan, composition)
    candidate_issues = _validate.validate_candidate(root, state, published=False)
    errors = _errors(candidate_issues)
    if errors:
        return {"ok": False, "issues": errors[:50], "state": status(root)}

    state["candidate_inputs_digest"] = _work_digest(root, state)
    state["candidate_digest"] = directory_digest(candidate_dir(root, state))
    state["review_subject_digest"] = _review_subject_digest(root, state)
    _write(root, state)
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    packet = {
        "ok": True,
        "subject_digest": state["review_subject_digest"],
        "artifact": str(review_path),
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/review.md"
        ),
        "contract": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/contract.md"
        ),
        "inputs": {
            "plan": str(work / "plan.md"),
            "composition": str(work / "composition.md"),
            "evidence": str(work / "evidence"),
            "candidate": str(candidate_dir(root, state)),
        },
        "complete_command": f"uv run {okf} review complete --json",
        "workdir": str(root),
    }
    if previous_review:
        packet["previous_review"] = previous_review
    return packet


def _stamp_candidate(root: pathlib.Path, state: dict) -> None:
    now = datetime.now(timezone.utc)
    stale_after = (now + timedelta(days=state["freshness_days"])).date()
    for path in sorted(candidate_dir(root, state).rglob("*.md")):
        parsed = parse_file(path)
        if parsed.errors:
            raise StateError(f"cannot stamp invalid candidate page: {path}")
        meta = dict(parsed.meta)
        meta["verified"] = [{"by": "agent:repo-wiki-review", "at": now}]
        meta["status"] = "stable"
        meta["stale_after"] = stale_after
        path.write_text(render(meta, parsed.body), encoding="utf-8", newline="\n")


@_locked
def review_complete(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    if state.get("candidate_inputs_digest") != _work_digest(root, state):
        raise StateError("working artifacts changed; run 'review prepare' again")
    candidate = candidate_dir(root, state)
    if state.get("candidate_digest") != directory_digest(candidate):
        raise StateError("candidate changed; run 'review prepare' again")
    composition = _markdown_model(
        work_dir(root, state) / "composition.md", CompositionMap
    )
    report, issues = _validate.validate_review(
        work_dir(root, state) / "review.json",
        state["review_subject_digest"],
        {page.id for page in composition.pages},
    )
    errors = _errors(issues)
    if errors:
        return {"ok": False, "issues": errors[:50], "state": status(root)}
    if report.verdict == "changes_requested":
        return {
            "ok": True,
            "verdict": report.verdict,
            "issues": [item.model_dump(mode="json") for item in report.issues],
            "state": status(root),
        }
    _stamp_candidate(root, state)
    errors = _errors(_validate.validate_candidate(root, state, published=True))
    if errors:
        raise StateError(f"approved candidate is invalid: {errors[:3]}")
    state["status"] = "approved"
    state["approved_at"] = _now()
    state["approved_digest"] = directory_digest(candidate)
    state["approved_review_digest"] = hashlib.sha256(
        (work_dir(root, state) / "review.json").read_bytes()
    ).hexdigest()
    _write(root, state)
    return {"ok": True, "verdict": "approved", "state": status(root)}


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


def _navigation_context(
    root: pathlib.Path, source_name: str
) -> tuple[dict, pathlib.Path, list[str]]:
    import _workspace

    state = _require_run(root, {"active"})
    workspace = _workspace.load(root)
    source = workspace.sources.get(source_name)
    revision = next(
        (item for item in state["revisions"] if item["name"] == source_name), None
    )
    if source is None or revision is None or source.kind not in ("git", "files"):
        raise StateError(
            f"evidence navigation requires a Git/files Source: {source_name}"
        )
    pin = _workspace.pin_dir(root, state["run_id"], source_name)
    files = _workspace.captured_files(source, pin, revision)
    return state, pin, files


def evidence_outline(
    root: pathlib.Path,
    source: str,
    path: str = ".",
    after: str | None = None,
) -> dict:
    import _index

    _, _, files = _navigation_context(root, source)
    path = _normalized_path(path)
    try:
        return _index.list_directory(source, path, files, after=after)
    except ValueError as exc:
        raise StateError(str(exc)) from exc


def evidence_search(
    root: pathlib.Path, source: str, query: str, path: str = "."
) -> dict:
    import _workspace

    _, pin, files = _navigation_context(root, source)
    path = _normalized_path(path)
    if not query or len(query) > 256:
        raise StateError("query must contain 1..256 characters")
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
                        return {"results": results, "truncated": True}
                    results.append(
                        {"locator": f"{source}/{rel}#L{line_no}", "text": text}
                    )
                    used += size
        except (OSError, UnicodeDecodeError):
            continue
    return {"results": results, "truncated": False}


def evidence_read(root: pathlib.Path, locator: str) -> dict:
    import _workspace
    from _validate import parse_resource

    parsed = parse_resource(locator)
    if parsed is None:
        raise StateError("read requires a canonical source/path#Lx-Ly locator")
    source, path, start, end = parsed
    _, pin, files = _navigation_context(root, source)
    if path not in files:
        raise StateError(f"file is outside the captured Source: {path}")
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
    return {
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


@_locked
def block(root: pathlib.Path, reason: str) -> dict:
    state = _require_run(root, {"active"})
    if not reason.strip():
        raise StateError("block reason is required")
    state["status"] = "blocked"
    state["block_reason"] = reason.strip()
    _write(root, state)
    return status(root)


@_locked
def resume(root: pathlib.Path) -> dict:
    state = _require_run(root, {"blocked"})
    assert_revisions_current(root, state)
    state["status"] = "active"
    state.pop("block_reason", None)
    _write(root, state)
    return status(root)


@_locked
def propose_start(root: pathlib.Path) -> dict:
    state = _require_run(root, {"published"})
    proposals = run_dir(root, state["run_id"]) / "proposals"
    proposals.mkdir(parents=True, exist_ok=True)
    okf = pathlib.Path(__file__).resolve().parent / "okf.py"
    return {
        "language": state["language"],
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/propose.md"
        ),
        "artifact": str(proposals),
        "candidate": _publication_path(root),
        "inputs": [str(work_dir(root, state) / "plan.md")],
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

    state = _require_run(root, {"published"})
    path = run_dir(root, state["run_id"]) / "proposals"
    issues = _validate.validate_proposals(root, state, path)
    errors = _errors(issues)
    return (
        {"ok": False, "issues": errors}
        if errors
        else {"ok": True, "files": sorted(item.name for item in path.glob("*.md"))}
    )


@_locked
def mark_published(root: pathlib.Path) -> dict:
    import _workspace

    state = _require_run(root, {"approved"})
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
    return {"abandoned": True}


def _require_run(root: pathlib.Path, statuses: set[str]) -> dict:
    state = read(root)
    if state is None:
        raise StateError("no run; call 'run start'")
    if state["status"] not in statuses:
        raise StateError(f"run is {state['status']}, not {'/'.join(sorted(statuses))}")
    return state
