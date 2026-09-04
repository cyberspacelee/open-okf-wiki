import functools
import hashlib
import json
import os
import pathlib
import re
import shutil
import time
from datetime import datetime, timedelta, timezone

from _files import atomic_json, compact_json_size, directory_digest
from _frontmatter import parse_file, parse_page, render
from _models import (
    CompositionMap,
    CompositionReviewReport,
    KnowledgePlan,
    PlanReviewReport,
    ReviewReport,
    RunPolicy,
    model_errors,
)
from pydantic import ValidationError

VERSION = 1
CONTRACT = "compiled-plan-evidence-registry"
LOCK_TIMEOUT_SEC = 60
MAX_STATUS_ISSUES = 10


class StateError(Exception):
    pass


def _meta(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki"


def _pointer(root: pathlib.Path) -> pathlib.Path:
    return _meta(root) / "current-run.json"


def run_dir(root: pathlib.Path, run_id: str) -> pathlib.Path:
    return _meta(root) / "runs" / run_id


def _skill_bundle_digest() -> str:
    skill = pathlib.Path(__file__).resolve().parent.parent
    files = [skill / "SKILL.md"]
    files.extend(sorted((skill / "references").glob("*.md")))
    files.extend(sorted((skill / "scripts").glob("*.py")))
    files.extend(sorted((skill / "assets").rglob("*.md")))
    digest = hashlib.sha256()
    for path in files:
        if not path.is_file():
            continue
        digest.update(path.relative_to(skill).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


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
    catalogs = state.get("catalogs")
    if not isinstance(catalogs, list) or any(
        not isinstance(item, dict)
        or set(item) != {"name", "content_hash", "storage_key"}
        or not all(isinstance(item[key], str) and item[key] for key in item)
        for item in catalogs
    ):
        raise StateError(
            "legacy or unsupported run state; thin Catalog pointers are required"
        )
    try:
        RunPolicy.model_validate(state.get("policy"), strict=True)
    except ValidationError as exc:
        raise StateError(
            f"legacy or unsupported run policy: {'; '.join(model_errors(exc))}"
        ) from exc
    bundle_digest = state.get("skill_bundle_digest", "")
    if not isinstance(bundle_digest, str) or not re.fullmatch(
        r"[0-9a-f]{64}", bundle_digest
    ):
        raise StateError("legacy or unsupported skill bundle digest")
    if (
        state.get("status")
        not in (
            "published",
            "abandoned",
        )
        and bundle_digest != _skill_bundle_digest()
    ):
        raise StateError("skill bundle changed during the run; abandon and start again")
    return state


def _write(root: pathlib.Path, state: dict) -> None:
    state["updated_at"] = _now()
    atomic_json(run_dir(root, state["run_id"]) / "state.json", state)


def _artifact_paths(root: pathlib.Path, state: dict) -> dict[str, str]:
    work = work_dir(root, state)
    base = run_dir(root, state["run_id"])
    return {
        "plan": str(work / "plan.md"),
        "plan_intent": str(work / "plan-intent.json"),
        "plan_ledger": str(work / "plan-ledger.json"),
        "progress": str(work / "progress.md"),
        "evidence": str(work / "evidence"),
        "plan_review": str(work / "plan-review.json"),
        "composition": str(work / "composition.md"),
        "composition_requirements": str(work / "composition-requirements.json"),
        "composition_review": str(work / "composition-review.json"),
        "reference_map": str(work / "reference-map.json"),
        "page_packets": str(work / "page-packets"),
        "evidence_cache": str(work / "evidence-cache"),
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
            elif source.kind == "opengauss":
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
        "policy": workspace.policy.model_dump(mode="json"),
        "skill_bundle_digest": _skill_bundle_digest(),
        "revisions": revisions,
        "catalogs": catalogs,
    }
    base = run_dir(root, run_id)
    for relative in (
        "index",
        "work/evidence",
        "work/evidence-cache",
        "work/drafts",
        "work/page-packets",
        "candidate",
        "proposals",
    ):
        (base / relative).mkdir(parents=True, exist_ok=True)
    (base / "work/progress.md").write_text(
        "# Progress\n\n<!-- repo-wiki-progress:initial -->\n"
        "Run started; replace this note after evidence synthesis.\n",
        encoding="utf-8",
        newline="\n",
    )
    for revision in revisions:
        _index.write_source_index(
            root, run_id, workspace.sources[revision["name"]], revision
        )
    _write(root, state)
    atomic_json(_pointer(root), {"version": VERSION, "run_id": run_id})
    return status(root)


def _errors(items) -> list[dict]:
    return [item.to_dict() for item in items if item.severity == "error"]


def _open_review_issues(report) -> list[dict]:
    return [
        item.model_dump(mode="json") for item in report.issues if item.status == "open"
    ]


def _previous_review(path: pathlib.Path, model) -> dict | None:
    if not path.is_file():
        return None
    try:
        report = model.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
    except (OSError, ValueError):
        return None
    if report.verdict != "changes_requested":
        return None
    return {"artifact": str(path), **report.model_dump(mode="json")}


def _work_digest(root: pathlib.Path, state: dict) -> str:
    work = work_dir(root, state)
    files = [
        work / "plan.md",
        work / "plan-intent.json",
        work / "plan-ledger.json",
        work / "plan-review.json",
        work / "composition-requirements.json",
        work / "composition.md",
        work / "composition-review.json",
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


def _plan_subject_digest(root: pathlib.Path, state: dict) -> str:
    work = work_dir(root, state)
    payload = {
        "plan": hashlib.sha256((work / "plan.md").read_bytes()).hexdigest(),
        "plan_intent": hashlib.sha256(
            (work / "plan-intent.json").read_bytes()
        ).hexdigest(),
        "plan_ledger": hashlib.sha256(
            (work / "plan-ledger.json").read_bytes()
        ).hexdigest(),
        "revisions": state["revisions"],
        "catalogs": [
            {"name": item["name"], "content_hash": item["content_hash"]}
            for item in state["catalogs"]
        ],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _composition_subject_digest(root: pathlib.Path, state: dict) -> str:
    work = work_dir(root, state)
    payload = {
        "plan_subject_digest": _plan_subject_digest(root, state),
        "plan_review": hashlib.sha256(
            (work / "plan-review.json").read_bytes()
        ).hexdigest(),
        "composition_requirements": hashlib.sha256(
            (work / "composition-requirements.json").read_bytes()
        ).hexdigest(),
        "composition": hashlib.sha256(
            (work / "composition.md").read_bytes()
        ).hexdigest(),
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
    all_issues = [
        {
            **item,
            "phase": item.get("phase") or phase,
            "applicability": "blocking",
            "next_action": next_actions[0] if next_actions else None,
        }
        for item in (issues or [])
    ]
    issue_counts = {}
    for item in all_issues:
        code = item.get("code", "unknown")
        issue_counts[code] = issue_counts.get(code, 0) + 1
    return {
        "run_id": state["run_id"],
        "status": state["status"],
        "phase": phase,
        "contract": CONTRACT,
        "language": state["language"],
        "policy": state["policy"],
        "sources": [item["name"] for item in state["revisions"]]
        + [item["name"] for item in state["catalogs"]],
        "artifacts": _artifact_paths(root, state),
        "issues": all_issues[:MAX_STATUS_ISSUES],
        "issue_counts": issue_counts,
        "issues_truncated": max(0, len(all_issues) - MAX_STATUS_ISSUES),
        "artifact_counts": _artifact_counts(root, state),
        "next_actions": next_actions,
        "block_reason": state.get("block_reason"),
        "run_dir": str(run_dir(root, state["run_id"])),
    }


def _artifact_counts(root: pathlib.Path, state: dict) -> dict:
    work = work_dir(root, state)
    result = {
        "knowledge_units": None,
        "pages": None,
        "authored_pages": None,
        "reference_pages": 0,
        "drafts_written": len(list((work / "drafts").glob("*.md"))),
        "drafts_missing": None,
    }
    try:
        plan = KnowledgePlan.model_validate_json(
            (work / "plan-ledger.json").read_text(encoding="utf-8"), strict=True
        )
        result["knowledge_units"] = len(plan.effective_units)
    except (OSError, StateError, ValidationError):
        pass
    try:
        composition = _markdown_model(work / "composition.md", CompositionMap)
        expected = {page.id for page in composition.pages}
        present = {path.stem for path in (work / "drafts").glob("*.md")}
        result["pages"] = len(composition.pages)
        result["authored_pages"] = len(composition.pages)
        result["drafts_missing"] = len(expected - present)
    except (OSError, StateError, ValidationError):
        pass
    try:
        reference_map = json.loads(
            (work / "reference-map.json").read_text(encoding="utf-8")
        )
        if reference_map["subject_digest"] != _composition_subject_digest(root, state):
            raise ValueError
        reference_pages = reference_map["pages"]
        result["reference_pages"] = len(reference_pages)
        if result["pages"] is not None:
            result["pages"] += len(reference_pages)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return result


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
        derived = {"plan-compile-required", "plan-ledger-stale"}
        next_actions = (
            ["plan compile"]
            if {item["code"] for item in errors} <= derived
            else ["repair work/plan.md and work/plan-intent.json", "plan inspect"]
        )
        return _status_payload(
            root,
            state,
            "plan",
            next_actions,
            issues=errors,
        )

    progress_issues = _validate.validate_progress_artifact(
        pathlib.Path(paths["progress"])
    )
    errors = _errors(progress_issues)
    if errors:
        return _status_payload(
            root, state, "plan", ["update work/progress.md"], issues=errors
        )

    plan_review, plan_review_issues = _validate.validate_plan_review(
        pathlib.Path(paths["plan_review"]),
        _plan_subject_digest(root, state),
        {unit.id for unit in plan.effective_units},
    )
    errors = _errors(plan_review_issues)
    if errors:
        return _status_payload(
            root, state, "plan-review", ["review plan"], issues=errors
        )
    if plan_review.verdict == "changes_requested":
        return _status_payload(
            root,
            state,
            "plan",
            ["repair the issues in work/plan-review.json", "review plan"],
            issues=_open_review_issues(plan_review),
        )

    requirements = _validate.composition_requirements(
        plan, _plan_subject_digest(root, state)
    )
    requirement_issues = _validate.validate_composition_requirements(
        pathlib.Path(paths["composition_requirements"]), requirements
    )
    errors = _errors(requirement_issues)
    if errors:
        return _status_payload(
            root, state, "composition", ["composition prepare"], issues=errors
        )

    composition, composition_issues = _validate.validate_composition_artifact(
        pathlib.Path(paths["composition"]), plan
    )
    errors = _errors(composition_issues)
    if errors:
        return _status_payload(
            root, state, "composition", ["repair work/composition.md"], issues=errors
        )

    composition_review, composition_review_issues = (
        _validate.validate_composition_review(
            pathlib.Path(paths["composition_review"]),
            _composition_subject_digest(root, state),
            {page.id for page in composition.pages},
        )
    )
    errors = _errors(composition_review_issues)
    if errors:
        return _status_payload(
            root,
            state,
            "composition-review",
            ["review composition"],
            issues=errors,
        )
    if composition_review.verdict == "changes_requested":
        return _status_payload(
            root,
            state,
            "composition",
            [
                "repair the issues in work/composition-review.json",
                "review composition",
            ],
            issues=_open_review_issues(composition_review),
        )

    draft_issues = _validate.validate_drafts(
        root, state, plan, composition, pathlib.Path(paths["drafts"])
    )
    errors = _errors(draft_issues)
    if errors:
        prepare = [
            f"page prepare {pathlib.Path(item['path']).stem}"
            for item in errors
            if item["code"] in {"page-prepare-required", "page-packet-stale"}
        ]
        prepare = prepare[: state["policy"]["agents"]["max_active_children"]]
        return _status_payload(
            root,
            state,
            "write",
            list(dict.fromkeys(prepare)) or ["repair work/drafts"],
            issues=errors,
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
        _candidate_page_ids(root, state),
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
            issues=_open_review_issues(report),
        )
    return _status_payload(root, state, "review", ["review complete"])


@_locked
def plan_compile(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.compile_plan_sources(root, state, work / "plan.md")
    errors = _errors(issues)
    if plan is None or errors:
        return {"ok": False, "issues": errors, "state": status(root)}
    target = work / "plan-ledger.json"
    atomic_json(target, plan.model_dump(mode="json", exclude_defaults=True))
    return {
        "ok": True,
        "artifact": str(target),
        "intent_digest": plan.intent_digest,
        "counts": {
            "domains": len(plan.domains),
            "concepts": len(plan.concepts),
            "authored_units": len(plan.units),
            "derived_units": len(plan.effective_units) - len(plan.units),
            "catalog_tables": len(plan.table_dispositions),
        },
        "state": status(root),
    }


def plan_inspect(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.compile_plan_sources(root, state, work / "plan.md")
    diagnostics = [item.to_dict() for item in issues]
    categories: dict[str, int] = {}
    for item in diagnostics:
        category = item.get("category") or "content"
        categories[category] = categories.get(category, 0) + 1
    result = {
        "ok": plan is not None and not _errors(issues),
        "diagnostics": diagnostics,
        "diagnostic_counts": categories,
        "skipped_checks": [],
    }
    if any(
        item["code"] in {"plan-intent-missing", "schema-invalid"}
        for item in diagnostics
    ):
        result["skipped_checks"] = [
            "semantic-compilation",
            "intent-environment",
            "compiled-ledger-validation",
            "plan-narrative-alignment",
        ]
    elif plan is None:
        result["skipped_checks"] = [
            "compiled-ledger-validation",
            "plan-narrative-alignment",
        ]
    if plan is not None:
        result["derived"] = {
            "domains": len(plan.domains),
            "concepts": len(plan.concepts),
            "authored_units": len(plan.units),
            "derived_units": [
                unit.id
                for unit in plan.effective_units
                if unit.id not in {x.id for x in plan.units}
            ],
            "catalog_tables": len(plan.table_dispositions),
        }
    return result


@_locked
def composition_prepare(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    errors = _errors(issues)
    if plan is not None:
        review, review_issues = _validate.validate_plan_review(
            work / "plan-review.json",
            _plan_subject_digest(root, state),
            {unit.id for unit in plan.effective_units},
        )
        errors.extend(_errors(review_issues))
        if review is not None and review.verdict != "approved":
            errors.append(
                {
                    "severity": "error",
                    "code": "plan-review-rejected",
                    "path": str(work / "plan-review.json"),
                    "line": None,
                    "message": "obtain Plan approval before preparing Composition",
                }
            )
    if plan is None or errors:
        return {"ok": False, "issues": errors, "state": status(root)}
    target = work / "composition-requirements.json"
    requirements = _validate.composition_requirements(
        plan, _plan_subject_digest(root, state)
    )
    atomic_json(target, requirements)
    return {
        "ok": True,
        "artifact": str(target),
        "effective_units": len(requirements["effective_units"]),
        "required_slots": len(requirements["required_slots"]),
        "state": status(root),
    }


def assert_revisions_current(root: pathlib.Path, state: dict) -> None:
    import _workspace

    workspace = _workspace.load(root)
    for record in state["revisions"]:
        source = workspace.sources.get(record["name"])
        if source is None or source.kind not in ("git", "files"):
            raise StateError(f"source missing during run: {record['name']}")
        _workspace.assert_pin_current(root, state["run_id"], source, record)


def _write_reference_map(
    root: pathlib.Path,
    state: dict,
    plan: KnowledgePlan,
    composition: CompositionMap,
) -> list[dict]:
    import _reference

    pages = _reference.derive_pages(root, state, plan, composition)
    atomic_json(
        work_dir(root, state) / "reference-map.json",
        {
            "subject_digest": _composition_subject_digest(root, state),
            "pages": [
                {
                    key: page.get(key)
                    for key in ("id", "path", "type", "source", "table")
                }
                for page in pages
            ],
        },
    )
    return pages


def _candidate_page_ids(root: pathlib.Path, state: dict) -> set[str]:
    return {
        parsed.meta["id"]
        for path in candidate_dir(root, state).rglob("*.md")
        if path.name not in ("index.md", "log.md")
        and not (parsed := parse_file(path)).errors
        and isinstance(parsed.meta.get("id"), str)
    }


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
    import _publish
    import _validate

    work = work_dir(root, state)
    generated = _write_reference_map(root, state, plan, composition)
    paths = {page.id: page.path for page in composition.pages}
    for page in generated:
        if page["id"] in paths or page["path"] in paths.values():
            raise StateError(f"generated page conflicts with Composition: {page['id']}")
        paths[page["id"]] = page["path"]
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
        packet, packet_issues = _validate.page_packet(root, state, plan, page)
        if packet is None:
            raise StateError(
                f"cannot bind page without valid packet: {page.id}: "
                f"{packet_issues[0].message}"
            )
        spec = {**_validate.page_spec(plan, page), "evidence": packet["evidence"]}
        rendered = _validate.render_generated_page(
            root, state, spec, draft, plan=plan, page=page
        )
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
    for page in generated:
        meta = {
            key: page[key]
            for key in (
                "id",
                "type",
                "title",
                "description",
                "tags",
                "diagrams",
                "sources",
            )
        }
        meta.update(
            {
                "coverage": "full",
                "language": state["language"],
                "status": "draft",
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
            }
        )
        body = _LOGICAL_LINK.sub(resolve, page["body"])
        destination = candidate / page["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(render(meta, body), encoding="utf-8", newline="\n")
    _publish._write_generated(
        candidate, _publish.render_indexes(candidate, state["language"])
    )


def _review_subject_digest(root: pathlib.Path, state: dict) -> str:
    payload = (
        f"{_work_digest(root, state)}:{directory_digest(candidate_dir(root, state))}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


@_locked
def plan_review_prepare(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    _, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    issues.extend(_validate.validate_progress_artifact(work / "progress.md"))
    errors = _errors(issues)
    if errors:
        return {"ok": False, "issues": errors, "state": status(root)}

    review_path = work / "plan-review.json"
    previous_review = _previous_review(review_path, PlanReviewReport)

    packet = {
        "ok": True,
        "subject_digest": _plan_subject_digest(root, state),
        "artifact": str(review_path),
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/plan-review.md"
        ),
        "contract": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/contract.md"
        ),
        "inputs": {
            "plan": str(work / "plan.md"),
            "plan_intent": str(work / "plan-intent.json"),
            "plan_ledger": str(work / "plan-ledger.json"),
            "evidence": str(work / "evidence"),
            "sources": [item["name"] for item in state["revisions"]]
            + [item["name"] for item in state["catalogs"]],
        },
        "workdir": str(root),
    }
    if previous_review:
        packet["previous_review"] = previous_review
    return packet


@_locked
def composition_review_prepare(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    errors = _errors(issues)
    if plan is not None:
        plan_review, plan_review_issues = _validate.validate_plan_review(
            work / "plan-review.json",
            _plan_subject_digest(root, state),
            {unit.id for unit in plan.effective_units},
        )
        errors.extend(_errors(plan_review_issues))
        if plan_review is not None and plan_review.verdict != "approved":
            errors.append(
                {
                    "severity": "error",
                    "code": "plan-review-rejected",
                    "path": str(work / "plan-review.json"),
                    "line": None,
                    "message": "repair the Knowledge Plan and obtain approval",
                }
            )
        requirements = _validate.composition_requirements(
            plan, _plan_subject_digest(root, state)
        )
        errors.extend(
            _errors(
                _validate.validate_composition_requirements(
                    work / "composition-requirements.json", requirements
                )
            )
        )
        composition, composition_issues = _validate.validate_composition_artifact(
            work / "composition.md", plan
        )
        errors.extend(_errors(composition_issues))
    else:
        composition = None
    if errors:
        return {"ok": False, "issues": errors, "state": status(root)}

    _write_reference_map(root, state, plan, composition)

    review_path = work / "composition-review.json"
    previous_review = _previous_review(review_path, CompositionReviewReport)

    packet = {
        "ok": True,
        "subject_digest": _composition_subject_digest(root, state),
        "artifact": str(review_path),
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent
            / "references/composition-review.md"
        ),
        "contract": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/contract.md"
        ),
        "inputs": {
            "plan": str(work / "plan.md"),
            "plan_ledger": str(work / "plan-ledger.json"),
            "plan_review": str(work / "plan-review.json"),
            "composition_requirements": str(work / "composition-requirements.json"),
            "composition": str(work / "composition.md"),
            "reference_map": str(work / "reference-map.json"),
        },
        "workdir": str(root),
    }
    if previous_review:
        packet["previous_review"] = previous_review
    return packet


def _evidence_cache_payload(root: pathlib.Path, state: dict, resource: str) -> dict:
    import _db
    import _validate

    evidence_id = f"ev-{hashlib.sha256(resource.encode()).hexdigest()[:16]}"
    catalog_value = None
    source_name = None
    binding = None
    kind = "source"
    for record in state["catalogs"]:
        catalog = _db.load_index(root, record["storage_key"])
        if resource == catalog["resource"]:
            source_name = catalog["name"]
            catalog_value = {
                "source": catalog["name"],
                "schema": catalog["schema"],
                "count": len(catalog["tables"]),
                "tables": [
                    {
                        key: table.get(key)
                        for key in (
                            "name",
                            "comment",
                            "column_count",
                            "foreign_key_count",
                            "index_count",
                        )
                    }
                    for table in catalog["tables"]
                ],
            }
        else:
            entry = next(
                (table for table in catalog["tables"] if table["resource"] == resource),
                None,
            )
            if entry is not None:
                source_name = catalog["name"]
                catalog_value = _db.compact_table(
                    _db.load_table(root, record["storage_key"], entry["page_slug"])
                )
        if catalog_value is not None:
            binding = record["content_hash"]
            kind = "catalog"
            break

    if catalog_value is None:
        parsed = _validate.parse_resource(resource)
        if parsed is None:
            raise StateError(f"invalid evidence resource: {resource}")
        source_name = parsed[0]
        catalog_value = evidence_read(root, resource, frozen_state=state)
        revision = next(
            (item for item in state["revisions"] if item["name"] == source_name), None
        )
        if revision is None:
            raise StateError(
                f"evidence source is not frozen in this run: {source_name}"
            )
        binding = revision.get("commit") or revision.get("content_hash")

    cache = {
        "kind": "page-evidence",
        "id": evidence_id,
        "seed": resource,
        "resource": catalog_value.get("returned_locator", resource),
        "source": source_name,
        "source_kind": kind,
        "binding": binding,
        "content": catalog_value,
    }
    raw = json.dumps(cache, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    cache["content_digest"] = hashlib.sha256(raw.encode()).hexdigest()
    return cache


def _cached_evidence(
    root: pathlib.Path, state: dict, resource: str
) -> tuple[dict, pathlib.Path] | None:
    evidence_id = f"ev-{hashlib.sha256(resource.encode()).hexdigest()[:16]}"
    target = work_dir(root, state) / "evidence-cache" / f"{evidence_id}.json"
    try:
        cache = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = None
    if not isinstance(cache, dict):
        return None
    digest = cache.pop("content_digest", None)
    actual_digest = hashlib.sha256(
        json.dumps(
            cache, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    cache["content_digest"] = digest
    records = (
        state["catalogs"]
        if cache.get("source_kind") == "catalog"
        else state["revisions"]
    )
    record = next(
        (item for item in records if item["name"] == cache.get("source")), None
    )
    binding = (
        record.get("content_hash")
        if cache.get("source_kind") == "catalog" and record
        else record and (record.get("commit") or record.get("content_hash"))
    )
    valid = (
        cache.get("kind") == "page-evidence"
        and cache.get("source_kind") in {"catalog", "source"}
        and record is not None
        and cache.get("id") == evidence_id
        and cache.get("seed") == resource
        and digest == actual_digest
        and cache.get("binding") == binding
    )
    return (cache, target) if valid else None


def _prepared_evidence(root: pathlib.Path, state: dict, resource: str) -> dict:
    cached = _cached_evidence(root, state, resource)
    if cached is None:
        cache = _evidence_cache_payload(root, state, resource)
        target = work_dir(root, state) / "evidence-cache" / f"{cache['id']}.json"
        atomic_json(target, cache)
    else:
        cache, target = cached
    return {
        key: cache[key]
        for key in (
            "id",
            "seed",
            "resource",
            "source",
            "source_kind",
            "binding",
            "content_digest",
        )
    } | {"cache_path": str(target)}


@_locked
def page_prepare(root: pathlib.Path, page_id: str) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    if plan is None or _errors(issues):
        return {"ok": False, "issues": _errors(issues), "state": status(root)}
    plan_review, review_issues = _validate.validate_plan_review(
        work / "plan-review.json",
        _plan_subject_digest(root, state),
        {unit.id for unit in plan.effective_units},
    )
    requirements = _validate.composition_requirements(
        plan, _plan_subject_digest(root, state)
    )
    requirement_issues = _validate.validate_composition_requirements(
        work / "composition-requirements.json", requirements
    )
    composition, composition_issues = _validate.validate_composition_artifact(
        work / "composition.md", plan
    )
    errors = [
        *_errors(review_issues),
        *_errors(requirement_issues),
        *_errors(composition_issues),
    ]
    if plan_review is not None and plan_review.verdict != "approved":
        errors.append(
            {
                "severity": "error",
                "code": "plan-review-rejected",
                "path": str(work / "plan-review.json"),
                "line": None,
                "message": "repair the Knowledge Plan and obtain approval",
            }
        )
    if composition is None:
        return {"ok": False, "issues": errors, "state": status(root)}
    composition_review, composition_review_issues = (
        _validate.validate_composition_review(
            work / "composition-review.json",
            _composition_subject_digest(root, state),
            {page.id for page in composition.pages},
        )
    )
    errors.extend(_errors(composition_review_issues))
    if composition_review is not None and composition_review.verdict != "approved":
        errors.append(
            {
                "severity": "error",
                "code": "composition-review-rejected",
                "path": str(work / "composition-review.json"),
                "line": None,
                "message": "repair the Composition and obtain approval",
            }
        )
    page = next((item for item in composition.pages if item.id == page_id), None)
    if page is None:
        errors.append(
            {
                "severity": "error",
                "code": "page-id-invalid",
                "path": str(work / "composition.md"),
                "line": None,
                "message": f"unknown authored page id: {page_id}",
            }
        )
    if errors:
        return {"ok": False, "issues": errors, "state": status(root)}

    reference_pages = _write_reference_map(root, state, plan, composition)
    units = {unit.id: unit for unit in plan.effective_units}
    owned_units = [units[unit_id] for unit_id in page.units]
    projection_units = _validate.page_projection_units(plan, page)
    domain_ids = {domain_id for unit in owned_units for domain_id in unit.domain_ids}
    selected_concepts = {
        concept.id
        for concept in plan.concepts
        if concept.id in {item for unit in owned_units for item in unit.concept_ids}
        or (page.type == "Domain" and concept.domain_id in domain_ids)
    }
    relationships = [
        item
        for item in plan.relationships
        if item.from_concept_id in selected_concepts
        or item.to_concept_id in selected_concepts
    ]
    selected_concepts.update(
        endpoint
        for relationship in relationships
        for endpoint in (relationship.from_concept_id, relationship.to_concept_id)
    )
    concepts = [item for item in plan.concepts if item.id in selected_concepts]
    model_tables = {
        (table.source, table.table)
        for concept in concepts
        for table in concept.model_basis.catalog_tables
    }
    catalog_sources = {source for source, _table in model_tables}

    page_domains = {
        candidate.id: {
            domain_id
            for unit_id in candidate.units
            for domain_id in units[unit_id].domain_ids
        }
        for candidate in composition.pages
    }
    related_pages = [
        candidate.model_dump(mode="json", exclude_none=True)
        for candidate in composition.pages
        if candidate.id != page.id and page_domains[candidate.id] & domain_ids
    ]
    references = [
        item
        for item in reference_pages
        if (item["type"] == "Schema" and item["source"] in catalog_sources)
        or (item["source"], item["table"]) in model_tables
    ]
    spec = _validate.page_spec(plan, page)
    gap_ids = {gap_id for concept in concepts for gap_id in concept.model_basis.gap_ids}
    gap_ids.update(
        gap_id
        for disposition in plan.table_dispositions
        if disposition.domain_id in domain_ids
        for gap_id in disposition.gap_ids
    )
    resources = _validate.page_evidence_resources(plan, page)
    evidence = [_prepared_evidence(root, state, resource) for resource in resources]
    payload = {
        "subject_digest": _composition_subject_digest(root, state),
        "page": page.model_dump(mode="json", exclude_none=True),
        "units": [
            unit.model_dump(mode="json", exclude_defaults=True) for unit in owned_units
        ],
        "projections": [
            unit.model_dump(mode="json", exclude_defaults=True)
            for unit in projection_units
        ],
        "domains": [
            domain.model_dump(mode="json")
            for domain in plan.domains
            if domain.id in domain_ids
        ],
        "concepts": [
            {
                **concept.model_dump(mode="json", exclude_defaults=True),
                "model_unit_id": concept.model_unit_id,
            }
            for concept in concepts
        ],
        "relationships": [item.model_dump(mode="json") for item in relationships],
        "gaps": [gap.model_dump(mode="json") for gap in plan.gaps if gap.id in gap_ids],
        "related_pages": related_pages,
        "reference_pages": [
            {key: item.get(key) for key in ("id", "path", "type", "source", "table")}
            for item in references
        ],
        "scopes": spec["scopes"],
        "evidence": evidence,
        "draft_frontmatter": {"coverage": "full"},
        "template": str(
            pathlib.Path(__file__).resolve().parent.parent
            / "assets/templates"
            / state["language"]
            / _validate._TEMPLATE_NAMES[page.type]
        ),
        "output": str(work / "drafts" / f"{page.id}.md"),
        "reference": str(
            pathlib.Path(__file__).resolve().parent.parent / "references/page.md"
        ),
        "language": state["language"],
        "workdir": str(root),
    }
    if page.type == "DataModel":
        import _reference

        _meta, preview = _reference.enrich_data_model(
            root,
            state,
            plan,
            page,
            {
                "sources": [
                    {"id": item["id"], "resource": item["seed"]} for item in evidence
                ],
                "diagrams": spec["diagrams"],
            },
            "<!-- okf-generated:model -->",
        )
        payload["generated_model_preview"] = preview
    packet_path = work / "page-packets" / f"{page.id}.json"
    atomic_json(packet_path, payload)
    return {
        "ok": True,
        "page_id": page.id,
        "artifact": str(packet_path),
        "output": payload["output"],
        "reference": payload["reference"],
        "language": state["language"],
    }


@_locked
def review_prepare(root: pathlib.Path) -> dict:
    import _validate

    state = _require_run(root, {"active"})
    assert_revisions_current(root, state)
    work = work_dir(root, state)
    plan, issues = _validate.validate_plan_artifact(root, state, work / "plan.md")
    errors = _errors(issues)
    if plan is not None:
        plan_review, plan_review_issues = _validate.validate_plan_review(
            work / "plan-review.json",
            _plan_subject_digest(root, state),
            {unit.id for unit in plan.effective_units},
        )
        errors.extend(_errors(plan_review_issues))
        if plan_review is not None and plan_review.verdict != "approved":
            errors.append(
                {
                    "severity": "error",
                    "code": "plan-review-rejected",
                    "path": str(work / "plan-review.json"),
                    "line": None,
                    "message": "repair the Knowledge Plan and obtain approval",
                }
            )
    if plan is not None:
        composition, composition_issues = _validate.validate_composition_artifact(
            work / "composition.md", plan
        )
        errors.extend(_errors(composition_issues))
    else:
        composition = None
    if plan is not None and composition is not None:
        composition_review, composition_review_issues = (
            _validate.validate_composition_review(
                work / "composition-review.json",
                _composition_subject_digest(root, state),
                {page.id for page in composition.pages},
            )
        )
        errors.extend(_errors(composition_review_issues))
        if composition_review is not None and composition_review.verdict != "approved":
            errors.append(
                {
                    "severity": "error",
                    "code": "composition-review-rejected",
                    "path": str(work / "composition-review.json"),
                    "line": None,
                    "message": "repair the Composition and obtain approval",
                }
            )
        errors.extend(
            _errors(
                _validate.validate_drafts(
                    root, state, plan, composition, work / "drafts"
                )
            )
        )
    if errors:
        return {"ok": False, "issues": errors, "state": status(root)}

    review_path = work / "review.json"
    previous_review = _previous_review(review_path, ReviewReport)

    _bind_candidate(root, state, plan, composition)
    candidate_validation = _validate.validate_candidate(root, state, published=False)
    errors = _errors(candidate_validation.issues)
    if errors or not candidate_validation.complete:
        return {
            "ok": False,
            "issues": errors,
            "skipped_checks": candidate_validation.skipped_checks,
            "state": status(root),
        }

    state["candidate_inputs_digest"] = _work_digest(root, state)
    state["candidate_digest"] = directory_digest(candidate_dir(root, state))
    state["review_subject_digest"] = _review_subject_digest(root, state)
    _write(root, state)
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
            "plan_ledger": str(work / "plan-ledger.json"),
            "composition": str(work / "composition.md"),
            "composition_review": str(work / "composition-review.json"),
            "evidence": str(work / "evidence"),
            "candidate": str(candidate_dir(root, state)),
            "reference_map": str(work / "reference-map.json"),
        },
        "workdir": str(root),
    }
    if previous_review:
        packet["previous_review"] = previous_review
    return packet


def _stamp_candidate(root: pathlib.Path, state: dict) -> None:
    now = datetime.now(timezone.utc)
    stale_after = (now + timedelta(days=state["freshness_days"])).date()
    for path in sorted(candidate_dir(root, state).rglob("*.md")):
        if path.name in ("index.md", "log.md"):
            continue
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
    report, issues = _validate.validate_review(
        work_dir(root, state) / "review.json",
        state["review_subject_digest"],
        _candidate_page_ids(root, state),
    )
    errors = _errors(issues)
    if errors:
        return {"ok": False, "issues": errors, "state": status(root)}
    if report.verdict == "changes_requested":
        return {
            "ok": True,
            "verdict": report.verdict,
            "issues": _open_review_issues(report),
            "state": status(root),
        }
    _stamp_candidate(root, state)
    validation = _validate.validate_candidate(root, state, published=True)
    errors = _errors(validation.issues)
    if errors or not validation.complete:
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
    root: pathlib.Path, source_name: str, frozen_state: dict | None = None
) -> tuple[dict, pathlib.Path, list[str]]:
    import _workspace

    state = frozen_state or _require_run(root, {"active"})
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
    root: pathlib.Path,
    source: str,
    query: str,
    path: str = ".",
    after: str | None = None,
) -> dict:
    import _workspace
    from _validate import parse_resource

    state, pin, files = _navigation_context(root, source)
    policy = RunPolicy.model_validate(state["policy"], strict=True).evidence.search
    path = _normalized_path(path)
    if not query or len(query) > 256:
        raise StateError("query must contain 1..256 characters")
    selected = [
        rel
        for rel in files
        if path == "." or rel == path or rel.startswith(path.rstrip("/") + "/")
    ]
    cursor: tuple[int, int] | None = None
    if after is not None:
        parsed = parse_resource(after)
        if parsed is None:
            raise StateError("search --after requires a canonical line locator")
        cursor_source, cursor_path, cursor_line, cursor_end = parsed
        if (
            cursor_source != source
            or cursor_path not in selected
            or cursor_line is None
            or cursor_end not in (None, cursor_line)
        ):
            raise StateError(
                "search --after must be inside the selected source and path"
            )
        cursor = (selected.index(cursor_path), cursor_line)

    def response(results: list[dict], *, limit_reached: bool, has_more: bool) -> dict:
        return {
            "items": results,
            "returned": len(results),
            "limit": {
                "max_items": policy.max_results,
                "max_output_bytes": policy.max_output_bytes,
            },
            "limit_reached": limit_reached,
            "has_more": has_more,
            "next_after": results[-1]["locator"] if has_more and results else None,
        }

    results: list[dict] = []
    for file_index, rel in enumerate(selected):
        disk = _workspace.resolve_pin_file(pin, rel)
        if disk is None:
            continue
        try:
            with disk.open(encoding="utf-8") as handle:
                for line_no, line in enumerate(handle, 1):
                    if cursor is not None and (file_index, line_no) <= cursor:
                        continue
                    if query not in line:
                        continue
                    text = line.rstrip("\r\n")[:500]
                    if len(results) >= policy.max_results:
                        return response(results, limit_reached=True, has_more=True)
                    candidate = [
                        *results,
                        {
                            "locator": f"{source}/{rel}#L{line_no}",
                            "text": text,
                            "text_clipped": len(line.rstrip("\r\n")) > 500,
                        },
                    ]
                    if (
                        compact_json_size(
                            response(candidate, limit_reached=True, has_more=True)
                        )
                        > policy.max_output_bytes
                    ):
                        if not results:
                            raise StateError(
                                "search byte policy cannot fit one complete result"
                            )
                        return response(results, limit_reached=True, has_more=True)
                    results = candidate
        except (OSError, UnicodeDecodeError):
            continue
    return response(results, limit_reached=False, has_more=False)


def evidence_read(
    root: pathlib.Path, locator: str, *, frozen_state: dict | None = None
) -> dict:
    import _workspace
    from _validate import parse_resource

    parsed = parse_resource(locator)
    if parsed is None:
        raise StateError("read requires a canonical source/path#Lx-Ly locator")
    source, path, start, end = parsed
    state, pin, files = _navigation_context(root, source, frozen_state)
    policy = RunPolicy.model_validate(state["policy"], strict=True).evidence.read
    if path not in files:
        raise StateError(f"file is outside the captured Source: {path}")
    start = start or 1
    if end is not None and end < start:
        raise StateError("end must not precede start")
    requested_end = end if end is not None else start + policy.default_lines - 1
    bounded_end = min(start + policy.max_lines - 1, requested_end)
    disk = _workspace.resolve_pin_file(pin, path)
    if disk is None:
        raise StateError(f"file is not a regular file inside the Pin: {path}")
    try:
        lines = disk.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError(f"file is not readable UTF-8 text: {path}") from exc
    requested_locator = (
        f"{source}/{path}#L{start}-L{end}" if end is not None else locator
    )

    def response(
        numbered: list[str], clipped_lines: list[int], *, limit_reached: bool
    ) -> dict:
        actual_end = start + len(numbered) - 1
        has_more = actual_end < len(lines)
        if has_more:
            next_start = max(start, actual_end + 1)
            if limit_reached and end is not None:
                next_end = min(end, next_start + policy.max_lines - 1)
            else:
                next_end = min(len(lines), next_start + policy.default_lines - 1)
            next_locator = f"{source}/{path}#L{next_start}-L{next_end}"
        else:
            next_locator = None
        returned_locator = (
            f"{source}/{path}#L{start}-L{actual_end}"
            if numbered
            else f"{source}/{path}"
        )
        return {
            "requested_locator": requested_locator,
            "returned_locator": returned_locator,
            "source": source,
            "path": path,
            "start": start,
            "end": actual_end if numbered else None,
            "text": "\n".join(numbered) + ("\n" if numbered else ""),
            "clipped_lines": clipped_lines,
            "limit": {
                "max_lines": policy.max_lines,
                "max_output_bytes": policy.max_output_bytes,
            },
            "limit_reached": limit_reached,
            "has_more": has_more,
            "next_locator": next_locator,
        }

    numbered: list[str] = []
    clipped_lines: list[int] = []
    target_end = min(bounded_end, len(lines))
    for index in range(start, target_end + 1):
        line = lines[index - 1]
        clipped = len(line) > 500
        candidate_lines = [*numbered, f"{index}|{line[:500]}"]
        candidate_clipped = [*clipped_lines, *([index] if clipped else [])]
        more_requested = index < min(requested_end, len(lines))
        candidate = response(
            candidate_lines,
            candidate_clipped,
            limit_reached=more_requested or clipped,
        )
        if compact_json_size(candidate) > policy.max_output_bytes:
            if not numbered:
                raise StateError("read byte policy cannot fit one complete line item")
            break
        numbered = candidate_lines
        clipped_lines = candidate_clipped
    actual_end = start + len(numbered) - 1
    limit_reached = actual_end < min(requested_end, len(lines)) or bool(clipped_lines)
    result = response(numbered, clipped_lines, limit_reached=limit_reached)
    if compact_json_size(result) > policy.max_output_bytes:
        raise StateError("read response exceeds its byte policy")
    return result


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
