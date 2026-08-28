import dataclasses
import hashlib
import json
import pathlib
import re
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import unquote, urlparse

from _files import directory_digest
from _frontmatter import parse_file, render
from _markdown import extract
from _models import (
    ConceptFrontmatter,
    Connect,
    PagePlan,
    ReviewReport,
    Survey,
    Triage,
    model_errors,
)
from pydantic import ValidationError

_LINE_ANCHOR = re.compile(r"#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$")
CAUSAL = re.compile(
    r"\b(because|in order to|so that)\b|为了|以便|因为|由于|以致|从而", re.IGNORECASE
)
_INLINE_REF = re.compile(r"\[\^[^\]]+\]")
_LFS_PREFIX = b"version https://git-lfs.github.com/spec/v1"
SURVEY_MAX_BYTES = 64 * 1024


def survey_budget(state: dict) -> int:
    """Per-survey byte budget; wider for zh (UTF-8 ~3 bytes/char).

    The whole-set budget is implied: each survey is capped, and the task
    count bounds the file count, so no separate set-level check exists.
    """
    return SURVEY_MAX_BYTES * 2 if state.get("language") == "zh" else SURVEY_MAX_BYTES


@dataclasses.dataclass(frozen=True)
class Issue:
    severity: Literal["error", "warning"]
    code: str
    path: str
    message: str
    line: int | None = None

    def to_dict(self) -> dict:
        return {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "line": self.line,
            "message": self.message,
        }


def issue(
    severity: Literal["error", "warning"],
    code: str,
    path: str,
    message: str,
    line: int | None = None,
) -> Issue:
    return Issue(severity, code, path, message, line)


def _revision(state: dict, name: str) -> dict | None:
    return next((item for item in state["revisions"] if item["name"] == name), None)


def parse_resource(resource: str) -> tuple[str, str, int | None, int | None] | None:
    """Parse a locator: '<source>/<path>' with an optional '#Lx-Ly' anchor."""
    if "://" in resource or "\\" in resource:
        return None
    match = _LINE_ANCHOR.search(resource)
    raw = resource[: match.start()] if match else resource
    if "#" in raw:
        return None
    source, sep, rel = raw.partition("/")
    if not sep or not source or not rel:
        return None
    pure = pathlib.PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    lo = int(match.group(1)) if match else None
    hi = int(match.group(2) or match.group(1)) if match else None
    return source, rel, lo, hi


def _resolve_resource(
    root: pathlib.Path, state: dict, resource: str
) -> tuple[bytes, int | None, int | None] | None:
    import _workspace

    parsed = parse_resource(resource)
    if parsed is None:
        return None
    source, rel, lo, hi = parsed
    revision = _revision(state, source)
    if revision is None:
        return None
    registered = _workspace.load(root).sources.get(source)
    if registered is None:
        return None
    if registered.kind == "files" or revision.get("kind") == "files":
        pin = _workspace.pin_dir(root, state["run_id"], source)
        pinned = dataclasses.replace(registered, path=pin) if pin.is_dir() else registered
        content = _workspace.files_blob(pinned, rel)
    else:
        content = _workspace.git_blob(registered, revision["commit"], rel)
    return (content, lo, hi) if content is not None else None


def _catalog_resource(state: dict, resource: str) -> bool:
    allowed = set()
    for catalog in state["catalogs"]:
        allowed.add(catalog["resource"])
        allowed.update(table["resource"] for table in catalog["tables"])
    return resource in allowed


def _slim_tables(tables) -> list[dict] | None:
    if not isinstance(tables, list):
        return None
    result = []
    for table in tables:
        if not isinstance(table, dict) or not isinstance(table.get("resource"), str):
            return None
        result.append(
            {
                "name": table.get("name"),
                "page_slug": table.get("page_slug"),
                "resource": table["resource"],
            }
        )
    return result


def _catalog_record_valid(root: pathlib.Path, entry) -> bool:
    if not isinstance(entry, dict):
        return False
    content_hash = entry.get("content_hash")
    if not isinstance(content_hash, str) or re.fullmatch(
        r"[0-9a-f]{64}", content_hash
    ) is None:
        return False
    capture = root / ".okf-wiki" / "catalogs" / content_hash / "catalog.json"
    try:
        captured = json.loads(capture.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(captured, dict):
        return False
    digest = hashlib.sha256(
        json.dumps(
            captured, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    if digest != content_hash:
        return False
    payload = {key: value for key, value in entry.items() if key != "content_hash"}
    if payload == captured:
        return True
    return (
        payload.get("name") == captured.get("name")
        and payload.get("schema") == captured.get("schema")
        and payload.get("resource") == captured.get("resource")
        and _slim_tables(payload.get("tables")) == _slim_tables(captured.get("tables"))
    )


def _check_range(
    path: pathlib.Path | bytes, lo: int | None, hi: int | None, label: str
) -> list[Issue]:
    if lo is not None and hi is not None and lo > hi:
        return [
            issue(
                "error", "line-range-invalid", label, f"start L{lo} exceeds end L{hi}"
            )
        ]
    content = path if isinstance(path, bytes) else path.read_bytes()
    if content.startswith(_LFS_PREFIX):
        return [
            issue(
                "error",
                "lfs-pointer",
                label,
                "unmaterialized Git LFS pointers cannot be evidence",
            )
        ]
    try:
        total = len(content.decode("utf-8").splitlines())
    except UnicodeDecodeError:
        return [
            issue(
                "error",
                "evidence-binary",
                label,
                "binary files cannot be line evidence",
            )
        ]
    if hi is not None and hi > total:
        return [
            issue(
                "error",
                "line-range-invalid",
                label,
                f"L{lo}-L{hi} exceeds {total} lines",
            )
        ]
    return []


def _model_issues(
    path: pathlib.Path, model, raw: str
) -> tuple[object | None, list[Issue]]:
    try:
        return model.model_validate_json(raw, strict=True), []
    except ValidationError as exc:
        return None, [
            issue("error", "schema-invalid", str(path), message)
            for message in model_errors(exc)
        ]


def validate_task(root: pathlib.Path, state: dict, task: dict) -> list[Issue]:
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    path = base / task["artifact"]
    if not path.exists():
        return [
            issue(
                "error", "artifact-missing", str(path), "target artifact does not exist"
            )
        ]
    phase = task["phase"]
    if phase == "triage":
        return _validate_triage(root, state, task, path)
    if phase == "survey":
        return _validate_survey(root, state, task, path)
    if phase == "connect":
        value, issues = _model_issues(path, Connect, path.read_text(encoding="utf-8"))
        if value:
            if value.source != task["spec"]["source"]:
                issues.append(
                    issue(
                        "error",
                        "connect-mismatch",
                        str(path),
                        "connect source does not match target",
                    )
                )
            known = {item["name"] for item in state["revisions"]}
            taken = _sibling_connection_ids(base, state, task)
            for connection in value.connections:
                if connection.id in taken:
                    issues.append(
                        issue(
                            "error",
                            "connection-id-taken",
                            str(path),
                            f"connection id {connection.id!r} is already used by"
                            f" connect:{taken[connection.id]}; connection ids are global",
                        )
                    )
                names = {item.source for item in connection.participants}
                if names - known:
                    issues.append(
                        issue(
                            "error",
                            "connection-source-invalid",
                            str(path),
                            connection.id,
                        )
                    )
                if value.source not in names:
                    issues.append(
                        issue(
                            "error",
                            "connection-source-invalid",
                            str(path),
                            f"{connection.id} must include {value.source}",
                        )
                    )
                elif not (names - known):
                    owner = min(names, key=str.casefold)
                    if value.source != owner:
                        issues.append(
                            issue(
                                "error",
                                "connection-owner-invalid",
                                str(path),
                                f"{connection.id} belongs to connect:{owner.lower()}"
                                " (lowest participant declares the edge)",
                            )
                        )
                for participant in connection.participants:
                    for locator in participant.evidence:
                        resolved = _resolve_resource(root, state, locator)
                        if resolved is None or not locator.startswith(
                            participant.source + "/"
                        ):
                            issues.append(
                                issue(
                                    "error",
                                    "connection-evidence-invalid",
                                    str(path),
                                    locator,
                                )
                            )
                        elif resolved:
                            issues.extend(_check_range(*resolved, locator))
                for locator in connection.contract_evidence:
                    resolved = _resolve_resource(root, state, locator)
                    if resolved is None:
                        issues.append(
                            issue(
                                "error",
                                "connection-evidence-invalid",
                                str(path),
                                locator,
                            )
                        )
                    else:
                        issues.extend(_check_range(*resolved, locator))
        return issues
    if phase == "plan":
        return _validate_plan(root, state, task, path, base)
    if phase == "review":
        value, issues = _model_issues(
            path, ReviewReport, path.read_text(encoding="utf-8")
        )
        if value:
            allowed = set(task["spec"].get("pages", []))
            for item in value.issues:
                if item.reopen == "page" and item.target not in allowed:
                    issues.append(
                        issue(
                            "error",
                            "review-target-invalid",
                            str(path),
                            item.target,
                        )
                    )
                elif item.reopen == "plan":
                    slug = (
                        "workspace"
                        if item.target in ("workspace", "plan:workspace")
                        else item.target.removeprefix("plan:").lower()
                    )
                    if f"plan:{slug}" not in state["tasks"]:
                        issues.append(
                            issue(
                                "error",
                                "review-target-invalid",
                                str(path),
                                f"{item.target} does not name a plan shard",
                            )
                        )
        return issues
    if phase == "write":
        return _validate_write(root, state, task, path)
    return [issue("error", "phase-unknown", str(path), f"unknown phase {phase}")]

def _validate_triage(
    root: pathlib.Path, state: dict, task: dict, path: pathlib.Path
) -> list[Issue]:
    import _index
    import _workspace

    value, issues = _model_issues(path, Triage, path.read_text(encoding="utf-8"))
    if not value:
        return issues
    expected_source = task["spec"]["source"]
    if value.source != expected_source:
        return issues + [
            issue(
                "error",
                "triage-source-mismatch",
                str(path),
                f"triage source must be {expected_source}",
            )
        ]
    workspace = _workspace.load(root)
    source = workspace.sources[expected_source]
    revision = next(
        item for item in state["revisions"] if item["name"] == expected_source
    )
    pin = _workspace.pin_dir(root, state["run_id"], expected_source)
    files = _workspace.captured_files(source, pin, revision)
    expected = set(_workspace.scoped_files(files, ["."], source.survey_exclude))
    claimed: set[str] = set()
    for scope in value.scopes:
        covered = set(
            _workspace.scoped_files(files, scope.paths, source.survey_exclude)
        )
        if not covered:
            issues.append(
                issue(
                    "error",
                    "triage-path-invalid",
                    str(path),
                    f"paths select no files: {list(scope.paths)}",
                )
            )
            continue
        overlap = claimed & covered
        if overlap:
            issues.append(
                issue(
                    "error",
                    "triage-overlap",
                    str(path),
                    f"paths overlap: {sorted(overlap)[:8]}",
                )
            )
        claimed.update(covered)
        if scope.tier != "inventory":
            continue
        if not scope.reason:
            issues.append(
                issue("error", "inventory-reason-missing", str(path), str(scope.paths))
            )
        protected = {item for item in covered if _index.is_protected(item)}
        if protected:
            issues.append(
                issue(
                    "error",
                    "inventory-protected-path",
                    str(path),
                    f"entry points require semantic survey: {sorted(protected)}",
                )
            )
        generated = all(_index.is_generated(pin, item) for item in covered)
        if not scope.samples and not generated:
            issues.append(
                issue("error", "inventory-sample-missing", str(path), str(scope.paths))
            )
        for locator in scope.samples:
            parsed = parse_resource(locator)
            if parsed is None or parsed[0] != expected_source or parsed[1] not in covered:
                issues.append(
                    issue("error", "inventory-sample-invalid", str(path), locator)
                )
                continue
            resolved = _resolve_resource(root, state, locator)
            if resolved is None:
                issues.append(
                    issue("error", "inventory-sample-invalid", str(path), locator)
                )
            else:
                issues.extend(_check_range(*resolved, locator))
    missing = expected - claimed
    if missing:
        issues.append(
            issue(
                "error",
                "triage-coverage-invalid",
                str(path),
                f"{expected_source} leaves {len(missing)} files unscoped",
            )
        )
    for split in source.survey_split:
        if not any(list(scope.paths) == [split] for scope in value.scopes):
            issues.append(
                issue(
                    "error",
                    "triage-split-missing",
                    str(path),
                    f"configured split must be an independent scope: {split}",
                )
            )
    return issues


def _validate_survey(root: pathlib.Path, state: dict, task: dict, path: pathlib.Path) -> list[Issue]:
    max_bytes = survey_budget(state)
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    if path.stat().st_size > max_bytes:
        return [
            issue(
                "error",
                "survey-too-large",
                str(path),
                f"survey exceeds {max_bytes} bytes; split or prioritize findings",
            )
        ]
    value, issues = _model_issues(path, Survey, path.read_text(encoding="utf-8"))
    if value:
        if value.source != task["spec"]["source"] or value.target != task["name"]:
            issues.append(
                issue(
                    "error",
                    "survey-mismatch",
                    str(path),
                    "survey identity does not match target",
                )
            )
        taken = _sibling_finding_ids(base, state, task)
        for finding in value.findings:
            if finding.id in taken:
                issues.append(
                    issue(
                        "error",
                        "finding-id-taken",
                        str(path),
                        f"finding id {finding.id!r} is already used by survey"
                        f" {taken[finding.id]!r}; finding ids are global",
                    )
                )
            for locator in finding.evidence:
                resolved = _resolve_resource(root, state, locator)
                if resolved is None:
                    issues.append(issue("error", "locator-unresolved", str(path), locator))
                else:
                    issues.extend(_check_range(*resolved, locator))
    return issues


def _sibling_finding_ids(
    base: pathlib.Path, state: dict, task: dict
) -> dict[str, str]:
    """Finding ids claimed by completed sibling surveys, id -> survey name."""
    taken: dict[str, str] = {}
    for sibling in state["tasks"].values():
        if (
            sibling["phase"] != "survey"
            or sibling["status"] != "complete"
            or sibling["id"] == task["id"]
        ):
            continue
        artifact = base / sibling["artifact"]
        if not artifact.is_file():
            continue
        survey = Survey.model_validate_json(
            artifact.read_text(encoding="utf-8"), strict=True
        )
        for finding in survey.findings:
            taken.setdefault(finding.id, sibling["name"])
    return taken


def _sibling_connection_ids(
    base: pathlib.Path, state: dict, task: dict
) -> dict[str, str]:
    """Connection ids claimed by completed sibling connect tasks, id -> task name."""
    taken: dict[str, str] = {}
    for sibling in state["tasks"].values():
        if (
            sibling["phase"] != "connect"
            or sibling["status"] != "complete"
            or sibling["id"] == task["id"]
        ):
            continue
        artifact = base / sibling["artifact"]
        if not artifact.is_file():
            continue
        connect = Connect.model_validate_json(
            artifact.read_text(encoding="utf-8"), strict=True
        )
        for connection in connect.connections:
            taken.setdefault(connection.id, sibling["name"])
    return taken



def _validate_write(root: pathlib.Path, state: dict, task: dict, path: pathlib.Path) -> list[Issue]:
    issues = validate_page(
        root, state, path, owner=task["spec"]["owner"], published=False
    )
    if task["spec"]["type"] == "Table":
        parsed = parse_file(path)
        expected = next(
            (
                table["resource"]
                for catalog in state["catalogs"]
                for table in catalog["tables"]
                if f"data/{catalog['name'].lower()}/{table['page_slug']}.md"
                == task["name"]
            ),
            None,
        )
        if expected is None or parsed.meta.get("resource") != expected:
            issues.append(
                issue(
                    "error",
                    "table-resource-invalid",
                    str(path),
                    f"Table resource must be {expected}",
                )
            )
    return issues


def _finding_id_list(base: pathlib.Path) -> list[str]:
    result = []
    survey_dir = base / "drafts" / "survey"
    if not survey_dir.is_dir():
        return result
    for path in sorted(survey_dir.rglob("*.json")):
        survey = Survey.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
        result.extend(item.id for item in survey.findings)
    return result


def _finding_sources(base: pathlib.Path) -> dict[str, str]:
    """Map every finding id to the Source whose survey produced it."""
    result: dict[str, str] = {}
    survey_dir = base / "drafts" / "survey"
    if not survey_dir.is_dir():
        return result
    for path in sorted(survey_dir.rglob("*.json")):
        survey = Survey.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
        for item in survey.findings:
            result.setdefault(item.id, survey.source)
    return result


def _sibling_plan_claims(
    base: pathlib.Path, state: dict, task: dict
) -> dict[str, str]:
    """Finding ids assigned or excluded by completed sibling plan shards."""
    taken: dict[str, str] = {}
    for sibling in state["tasks"].values():
        if (
            sibling["phase"] != "plan"
            or sibling["status"] != "complete"
            or sibling["id"] == task["id"]
        ):
            continue
        artifact = base / sibling["artifact"]
        if not artifact.is_file():
            continue
        plan = PagePlan.model_validate_json(
            artifact.read_text(encoding="utf-8"), strict=True
        )
        for page in plan.pages:
            for fid in page.finding_ids:
                taken.setdefault(fid, sibling["name"])
        for exclusion in plan.exclusions:
            taken.setdefault(exclusion.finding_id, sibling["name"])
    return taken


def _validate_plan(
    root: pathlib.Path,
    state: dict,
    task: dict,
    path: pathlib.Path,
    base: pathlib.Path,
) -> list[Issue]:
    """Gate one plan shard as the single writer of its page namespace.

    Partition rules checked here, on the shard's own gate:
    - a shard's pages live only under its own path prefix, so page paths
      cannot collide across shards by construction;
    - source-owned pages cite only their own Source's findings; workspace
      pages compose and may cite any finding;
    - connections are assigned only by plan:workspace, which must assign
      all of them;
    - required pages (core, per-source architecture, table pages) are
      checked on the shard that owns them.
    Global exactly-once finding coverage spans shards and is checked at
    compose with per-shard attribution.
    """
    value, issues = _model_issues(path, PagePlan, path.read_text(encoding="utf-8"))
    if not value:
        return issues
    expected_source = task["spec"].get("source")
    if value.source != expected_source:
        issues.append(
            issue(
                "error",
                "plan-source-mismatch",
                str(path),
                "plan shard source does not match target",
            )
        )
        return issues
    owner = expected_source or "workspace"
    slug = owner.lower()
    catalog = next(
        (item for item in state["catalogs"] if item["name"] == owner), None
    )
    source_slugs = {
        item["name"].lower() for item in (*state["revisions"], *state["catalogs"])
    }
    finding_owner = _finding_sources(base)
    known_connections = _connection_ids(base)
    sibling_claims = _sibling_plan_claims(base, state, task)
    assigned: dict[str, str] = {}
    assigned_connections: dict[str, str] = {}
    page_by_path = {page.path: page for page in value.pages}

    for page in value.pages:
        if page.owner != owner:
            issues.append(
                issue(
                    "error",
                    "page-owner-invalid",
                    str(path),
                    f"{page.path} owner must be {owner}",
                )
            )
        head = page.path.split("/", 1)[0]
        if owner == "workspace":
            if "/" in page.path and (head in source_slugs or head == "data"):
                issues.append(
                    issue(
                        "error",
                        "page-path-foreign",
                        str(path),
                        f"{page.path} lives in a source-owned namespace",
                    )
                )
        elif catalog is not None:
            if not page.path.startswith(f"data/{slug}/"):
                issues.append(
                    issue(
                        "error",
                        "page-path-foreign",
                        str(path),
                        f"{page.path} must live under data/{slug}/",
                    )
                )
        elif not page.path.startswith(f"{slug}/"):
            issues.append(
                issue(
                    "error",
                    "page-path-foreign",
                    str(path),
                    f"{page.path} must live under {slug}/",
                )
            )
        for fid in page.finding_ids:
            fowner = finding_owner.get(fid)
            if fowner is None:
                issues.append(
                    issue(
                        "error",
                        "finding-unknown",
                        str(path),
                        f"{page.path} cites unknown finding {fid}",
                    )
                )
            elif owner != "workspace" and fowner != owner:
                issues.append(
                    issue(
                        "error",
                        "finding-foreign",
                        str(path),
                        f"{page.path} cites finding {fid} owned by {fowner};"
                        " source-owned pages cite only their owner",
                    )
                )
            elif fid in assigned:
                issues.append(
                    issue(
                        "error",
                        "finding-reassigned",
                        str(path),
                        f"finding {fid} is assigned to both {assigned[fid]}"
                        f" and {page.path}",
                    )
                )
            elif fid in sibling_claims:
                issues.append(
                    issue(
                        "error",
                        "finding-reassigned",
                        str(path),
                        f"finding {fid} is already claimed by"
                        f" plan:{sibling_claims[fid]}",
                    )
                )
            else:
                assigned[fid] = page.path
        if owner == "workspace":
            for cid in page.connection_ids:
                if cid not in known_connections:
                    issues.append(
                        issue(
                            "error",
                            "connection-unknown",
                            str(path),
                            f"{page.path} cites unknown connection {cid}",
                        )
                    )
                elif cid in assigned_connections:
                    issues.append(
                        issue(
                            "error",
                            "connection-reassigned",
                            str(path),
                            f"connection {cid} is assigned to both"
                            f" {assigned_connections[cid]} and {page.path}",
                        )
                    )
                else:
                    assigned_connections[cid] = page.path
        elif page.connection_ids:
            issues.append(
                issue(
                    "error",
                    "connection-foreign",
                    str(path),
                    f"{page.path} assigns connections;"
                    " plan:workspace owns connection assignment",
                )
            )

    excluded: set[str] = set()
    for exclusion in value.exclusions:
        fid = exclusion.finding_id
        fowner = finding_owner.get(fid)
        if fowner is None:
            issues.append(
                issue(
                    "error",
                    "finding-unknown",
                    str(path),
                    f"exclusion names unknown finding {fid}",
                )
            )
        elif owner != "workspace" and fowner != owner:
            issues.append(
                issue(
                    "error",
                    "finding-foreign",
                    str(path),
                    f"exclusion of {fid} belongs to plan:{fowner.lower()}"
                    " or plan:workspace",
                )
            )
        elif fid in assigned or fid in excluded:
            issues.append(
                issue(
                    "error",
                    "finding-reassigned",
                    str(path),
                    f"finding {fid} is both assigned and excluded",
                )
            )
        elif fid in sibling_claims:
            issues.append(
                issue(
                    "error",
                    "finding-reassigned",
                    str(path),
                    f"finding {fid} is already claimed by"
                    f" plan:{sibling_claims[fid]}",
                )
            )
        else:
            excluded.add(fid)

    git_or_files = [
        item["name"]
        for item in state["revisions"]
        if item.get("kind") in ("git", "files", None)
    ]
    if owner == "workspace":
        required = [("overview.md", "Overview"), ("architecture.md", "Architecture")]
        if state["catalogs"]:
            required.append(("data-model.md", "DataModel"))
        for core_path, core_type in required:
            entry = page_by_path.get(core_path)
            if entry is None or entry.type != core_type:
                issues.append(
                    issue(
                        "error",
                        "core-page-invalid",
                        str(path),
                        f"{core_path} must be a workspace-owned {core_type}",
                    )
                )
        unassigned = sorted(known_connections - set(assigned_connections))
        if unassigned:
            issues.append(
                issue(
                    "error",
                    "connection-coverage-invalid",
                    str(path),
                    f"connections not assigned to any page: {unassigned[:8]}",
                )
            )
    elif catalog is not None:
        for table in catalog["tables"]:
            table_path = f"data/{slug}/{table['page_slug']}.md"
            entry = page_by_path.get(table_path)
            if entry is None or entry.type != "Table":
                issues.append(
                    issue(
                        "error",
                        "data-page-invalid",
                        str(path),
                        f"{table_path} must be a Table owned by {owner}",
                    )
                )
    elif len(git_or_files) > 1:
        arch_path = f"{slug}/architecture.md"
        entry = page_by_path.get(arch_path)
        if entry is None or entry.type != "Architecture":
            issues.append(
                issue(
                    "error",
                    "source-architecture-invalid",
                    str(path),
                    f"{arch_path} must be an Architecture owned by {owner}",
                )
            )
    return issues


def _connection_entries(base: pathlib.Path) -> list[tuple[str, object]]:
    result = []
    connect_dir = base / "drafts" / "connect"
    if not connect_dir.is_dir():
        return result
    for path in sorted(connect_dir.glob("*.json")):
        connect = Connect.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
        result.extend((connect.source, item) for item in connect.connections)
    return result


def _connection_ids(base: pathlib.Path) -> set[str]:
    return {item.id for _, item in _connection_entries(base)}


def validate_composed_plan(root: pathlib.Path, state: dict) -> list[Issue]:
    """Re-run every plan shard gate, then check the cross-shard contracts.

    Every issue carries the artifact path of the shard that must change, so
    a compose failure is always attributable and repairable: page paths are
    disjoint by the per-shard prefix rule, and each finding must be assigned
    or excluded exactly once across all shards.
    """
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    plan_dir = base / "drafts" / "plan"
    issues: list[Issue] = []
    shard_tasks = [
        task for task in state["tasks"].values() if task["phase"] == "plan"
    ]
    for task in shard_tasks:
        path = base / task["artifact"]
        if not path.is_file():
            issues.append(
                issue(
                    "error",
                    "artifact-missing",
                    str(path),
                    "plan shard artifact does not exist",
                )
            )
            continue
        issues.extend(_validate_plan(root, state, task, path, base))
    if issues:
        return issues
    shards: list[tuple[str, object]] = []
    for task in shard_tasks:
        path = base / task["artifact"]
        plan = PagePlan.model_validate_json(
            path.read_text(encoding="utf-8"), strict=True
        )
        shards.append((str(path), plan))
    pages = [page for _, plan in shards for page in plan.pages]
    paths = [page.path for page in pages]
    if len(paths) != len(set(paths)):
        issues.append(
            issue(
                "error",
                "page-path-duplicate",
                str(plan_dir),
                "page paths must be unique across plan shards",
            )
        )
    finding_owner = _finding_sources(base)
    touched: dict[str, list[str]] = {}
    for shard_path, plan in shards:
        for page in plan.pages:
            for fid in page.finding_ids:
                touched.setdefault(fid, []).append(shard_path)
        for exclusion in plan.exclusions:
            touched.setdefault(exclusion.finding_id, []).append(shard_path)
    owner_shard = {
        (task["spec"].get("source") or "workspace"): str(base / task["artifact"])
        for task in shard_tasks
    }
    for fid, fowner in sorted(finding_owner.items()):
        if fid not in touched:
            shard_path = owner_shard.get(fowner) or owner_shard["workspace"]
            issues.append(
                issue(
                    "error",
                    "finding-coverage-invalid",
                    shard_path,
                    f"finding {fid} ({fowner}) is neither assigned nor excluded",
                )
            )
    connection_entries = _connection_entries(base)
    connection_list_all = [item.id for _, item in connection_entries]
    if len(connection_list_all) != len(set(connection_list_all)):
        issues.append(
            issue(
                "error",
                "connection-id-duplicate",
                str(plan_dir),
                "connection ids must be unique across connect tasks",
            )
        )
    declared_by: dict[frozenset, set[str]] = {}
    for declaring, item in connection_entries:
        participants = frozenset(part.source for part in item.participants)
        declared_by.setdefault(participants, set()).add(declaring)
    for participants, declarers in sorted(
        declared_by.items(), key=lambda entry: sorted(entry[0])
    ):
        if len(declarers) > 1:
            issues.append(
                issue(
                    "error",
                    "connection-duplicate-edge",
                    str(plan_dir),
                    f"edge between {sorted(participants)} is declared by"
                    f" {sorted(declarers)}; one connect task owns an edge",
                )
            )
    finding_list = _finding_id_list(base)
    if len(finding_list) != len(set(finding_list)):
        issues.append(
            issue(
                "error",
                "finding-id-duplicate",
                str(plan_dir),
                "finding ids must be globally unique",
            )
        )
    return issues


def render_generated_page(
    root: pathlib.Path, state: dict, task: dict, path: pathlib.Path
) -> str | None:
    import _workspace

    parsed = parse_file(path)
    if parsed.errors:
        return None
    meta = dict(parsed.meta)
    spec = task["spec"]
    meta.update(
        {
            "type": spec["type"],
            "title": spec["title"],
            "description": spec["description"],
            "tags": spec["tags"],
            "language": state["language"],
            "status": "draft",
            "generated": {"by": state["producer"], "at": datetime.now(timezone.utc)},
        }
    )
    meta.pop("verified", None)
    meta.pop("stale_after", None)
    workspace = _workspace.load(root)
    enriched = []
    for source in meta.get("sources", []):
        if not isinstance(source, dict):
            enriched.append(source)
            continue
        resource = source.get("resource", "")
        parsed_resource = (
            parse_resource(resource) if isinstance(resource, str) else None
        )
        if parsed_resource:
            source_name, rel, _, _ = parsed_resource
            revision = _revision(state, source_name)
            if revision:
                signals = _workspace.git_file_metadata(workspace, revision, rel)
                source = dict(source)
                source.update({key: value for key, value in signals.items() if value})
        enriched.append(source)
    meta["sources"] = enriched
    return render(meta, parsed.body)


def render_approved_pages(
    root: pathlib.Path, state: dict, actor: str
) -> list[tuple[pathlib.Path, str]]:
    now = datetime.now(timezone.utc)
    stale = now.date() + timedelta(days=state["freshness_days"])
    rendered = []
    for path in sorted(
        (root / ".okf-wiki" / "runs" / state["run_id"] / "candidate").rglob("*.md")
    ):
        parsed = parse_file(path)
        if parsed.errors:
            continue
        meta = dict(parsed.meta)
        verified = meta.get("verified") or []
        if isinstance(verified, dict):
            verified = [verified]
        meta["verified"] = [*verified, {"by": actor, "at": now}]
        meta["status"] = "stable"
        meta["stale_after"] = stale
        rendered.append((path, render(meta, parsed.body)))
    return rendered


def validate_page(
    root: pathlib.Path,
    state: dict,
    path: pathlib.Path,
    *,
    owner: str | None = None,
    published: bool = False,
) -> list[Issue]:
    parsed = parse_file(path)
    if parsed.errors:
        return [
            issue("error", "frontmatter-invalid", str(path), message)
            for message in parsed.errors
        ]
    try:
        frontmatter = ConceptFrontmatter.model_validate(parsed.meta, strict=True)
    except ValidationError as exc:
        return [
            issue("error", "frontmatter-invalid", str(path), message)
            for message in model_errors(exc)
        ]
    issues = []
    for field in ("title", "description", "coverage", "language", "generated"):
        if getattr(frontmatter, field) is None:
            issues.append(
                issue(
                    "error", "field-missing", str(path), f"repo-wiki requires {field}"
                )
            )
    if published and (
        frontmatter.status != "stable"
        or not frontmatter.verified
        or not frontmatter.stale_after
    ):
        issues.append(
            issue(
                "error",
                "trust-incomplete",
                str(path),
                "published concepts must be stable, verified and have stale_after",
            )
        )
    structure = extract(parsed.body)
    refs = {ref for ref, _ in structure.footnote_refs}
    defs = set(structure.footnote_defs)
    source_ids = [source.id for source in frontmatter.sources]
    if any(source_id is None for source_id in source_ids) or len(source_ids) != len(
        set(source_ids)
    ):
        issues.append(
            issue(
                "error",
                "source-id-invalid",
                str(path),
                "source ids are required and unique",
            )
        )
    if refs != set(source_ids) or refs != defs:
        issues.append(
            issue(
                "error",
                "citation-join-invalid",
                str(path),
                "footnote refs, definitions and source ids must match exactly",
            )
        )
    for source in frontmatter.sources:
        if _catalog_resource(state, source.resource):
            continue
        resolved = _resolve_resource(root, state, source.resource)
        if resolved is None:
            issues.append(
                issue("error", "locator-unresolved", str(path), source.resource)
            )
            continue
        parsed_resource = parse_resource(source.resource)
        if (
            owner
            and owner != "workspace"
            and parsed_resource
            and parsed_resource[0] != owner
        ):
            issues.append(issue("error", "ownership-bleed", str(path), source.resource))
        issues.extend(_check_range(*resolved, source.resource))
    for placeholder, line in structure.placeholders:
        issues.append(
            issue("error", "placeholder-remaining", str(path), placeholder, line)
        )
    if frontmatter.coverage == "partial":
        gaps = [section for section in structure.sections if section.title == "Gaps"]
        if not gaps or not gaps[0].content:
            issues.append(
                issue(
                    "error",
                    "gaps-missing",
                    str(path),
                    "partial coverage requires a non-empty Gaps section",
                )
            )
    for line, raw in enumerate(parsed.body.splitlines(), 1):
        if CAUSAL.search(raw) and not _INLINE_REF.search(raw):
            issues.append(
                issue(
                    "warning",
                    "causal-unanchored",
                    str(path),
                    "causal claim has no citation",
                    line,
                )
            )
    return issues


def validate_candidate(
    root: pathlib.Path, state: dict, *, published: bool
) -> list[Issue]:
    candidate = root / ".okf-wiki" / "runs" / state["run_id"] / "candidate"
    pages = sorted(candidate.rglob("*.md")) if candidate.exists() else []
    if not pages:
        return [
            issue(
                "error",
                "candidate-empty",
                str(candidate),
                "candidate has no concept pages",
            )
        ]
    issues = []
    page_set = {path.relative_to(candidate).as_posix() for path in pages}
    task_by_path = {
        task["name"]: task
        for task in state["tasks"].values()
        if task["phase"] == "write"
    }
    if page_set != set(task_by_path):
        issues.append(
            issue(
                "error",
                "page-set-mismatch",
                str(candidate),
                "candidate pages must exactly match the page plan",
            )
        )
    for path in pages:
        rel = path.relative_to(candidate).as_posix()
        owner = task_by_path.get(rel, {}).get("spec", {}).get("owner")
        issues.extend(
            validate_page(root, state, path, owner=owner, published=published)
        )
    issues.extend(_link_issues(candidate, pages, page_set))
    return issues


def _link_issues(
    base: pathlib.Path, pages: list[pathlib.Path], allowed: set[str]
) -> list[Issue]:
    issues = []
    for path in pages:
        rel = path.relative_to(base).as_posix()
        parsed = parse_file(path, reserved=path.name in ("index.md", "log.md"))
        structure = extract(parsed.body)
        for target, line in structure.links:
            clean = unquote(target.split("#", 1)[0].split("?", 1)[0])
            if not clean or urlparse(clean).scheme or clean.startswith("mailto:"):
                continue
            if clean.startswith("/"):
                rel_target = pathlib.PurePosixPath(clean.lstrip("/"))
            else:
                rel_target = pathlib.PurePosixPath(rel).parent / clean
            normalized = pathlib.PurePosixPath(rel_target)
            if ".." in normalized.parts or normalized.as_posix() not in allowed:
                issues.append(issue("error", "broken-link", str(path), target, line))
    return issues


def validate_bundle(path: pathlib.Path) -> list[Issue]:
    issues = []
    for page in sorted(path.rglob("*.md")):
        rel = page.relative_to(path).as_posix()
        if page.name == "index.md":
            parsed = parse_file(page, reserved=True)
            if rel == "index.md":
                if parsed.errors or parsed.meta != {"okf_version": "0.2"}:
                    issues.append(
                        issue(
                            "error",
                            "index-frontmatter",
                            str(page),
                            "root index may contain only okf_version: 0.2",
                        )
                    )
            elif parsed.meta or parsed.errors:
                issues.append(
                    issue(
                        "error",
                        "index-frontmatter",
                        str(page),
                        "nested index must not have frontmatter",
                    )
                )
            for line_no, line in enumerate(parsed.body.splitlines(), 1):
                if line.startswith("##"):
                    issues.append(
                        issue(
                            "error",
                            "index-heading",
                            str(page),
                            "index groups must use H1 headings",
                            line_no,
                        )
                    )
        elif page.name == "log.md":
            parsed = parse_file(page, reserved=True)
            if parsed.meta or parsed.errors:
                issues.append(
                    issue(
                        "error",
                        "log-frontmatter",
                        str(page),
                        "log must not have frontmatter",
                    )
                )
            for line_no, line in enumerate(parsed.body.splitlines(), 1):
                if line.startswith("## ") and not re.fullmatch(
                    r"## \d{4}-\d{2}-\d{2}", line
                ):
                    issues.append(
                        issue(
                            "error",
                            "log-date",
                            str(page),
                            "log date headings must be YYYY-MM-DD",
                            line_no,
                        )
                    )
        else:
            parsed = parse_file(page)
            if parsed.errors:
                issues.extend(
                    issue("error", "frontmatter-invalid", str(page), message)
                    for message in parsed.errors
                )
            else:
                try:
                    concept = ConceptFrontmatter.model_validate(
                        parsed.meta, strict=True
                    )
                    if (
                        concept.status != "stable"
                        or not concept.verified
                        or not concept.stale_after
                    ):
                        issues.append(
                            issue(
                                "error",
                                "trust-incomplete",
                                str(page),
                                "published concepts must be stable, verified and have stale_after",
                            )
                        )
                except ValidationError as exc:
                    issues.extend(
                        issue("error", "frontmatter-invalid", str(page), message)
                        for message in model_errors(exc)
                    )
    return issues


def validate_publication(root: pathlib.Path, path: pathlib.Path) -> list[Issue]:
    issues = validate_bundle(path)
    manifest_path = path / ".okf-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        issues.append(issue("error", "manifest-invalid", str(manifest_path), str(exc)))
        return issues
    if (
        not isinstance(manifest, dict)
        or not isinstance(manifest.get("revisions"), list)
        or not isinstance(manifest.get("catalogs"), list)
    ):
        issues.append(
            issue(
                "error",
                "manifest-invalid",
                str(manifest_path),
                "manifest fields are invalid",
            )
        )
        return issues
    if manifest.get("digest") != directory_digest(
        path, exclude_names={".okf-manifest.json"}
    ):
        issues.append(
            issue(
                "error", "manifest-digest", str(manifest_path), "bundle digest mismatch"
            )
        )

    revisions = []
    for entry in manifest["revisions"]:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("name"), str)
            or not re.fullmatch(r"[0-9a-f]{40,64}", entry.get("commit", ""))
        ):
            issues.append(
                issue(
                    "error",
                    "revision-invalid",
                    str(manifest_path),
                    "Git revision fields are invalid",
                )
            )
            continue
        revisions.append(entry)

    catalogs = []
    for entry in manifest["catalogs"]:
        if not _catalog_record_valid(root, entry):
            issues.append(
                issue(
                    "error",
                    "catalog-invalid",
                    str(manifest_path),
                    "catalog capture is missing or does not match its content hash",
                )
            )
            continue
        catalogs.append(entry)

    state = {"revisions": revisions, "catalogs": catalogs}
    concepts = sorted(
        page for page in path.rglob("*.md") if page.name not in ("index.md", "log.md")
    )
    for page in concepts:
        issues.extend(validate_page(root, state, page, published=True))
    linked_pages = sorted(page for page in path.rglob("*.md") if page.name != "log.md")
    allowed = {page.relative_to(path).as_posix() for page in path.rglob("*.md")}
    issues.extend(_link_issues(path, linked_pages, allowed))
    return issues


def validate_proposals(
    root: pathlib.Path,
    state: dict,
    path: pathlib.Path,
) -> list[Issue]:
    issues = []
    expected = {
        f"agents-block-{item['name']}.md"
        for item in state["revisions"]
        if item.get("kind") != "files"
    }
    actual = (
        {item.name for item in path.glob("agents-block-*.md")}
        if path.exists()
        else set()
    )
    if actual - expected:
        issues.append(
            issue(
                "error",
                "proposal-set-invalid",
                str(path),
                f"unexpected proposal files: {sorted(actual - expected)}",
            )
        )
    begin = re.compile(r"<!--\s*okf-wiki:begin\b[^>]*-->")
    end = re.compile(r"<!--\s*okf-wiki:end\s*-->")
    for proposal in path.glob("agents-block-*.md"):
        text = proposal.read_text(encoding="utf-8")
        if len(begin.findall(text)) != 1 or len(end.findall(text)) != 1:
            issues.append(
                issue(
                    "error",
                    "managed-block-invalid",
                    str(proposal),
                    "exactly one managed block is required",
                )
            )
        inside = text.split("-->", 1)[-1].rsplit("<!--", 1)[0]
        if len([line for line in inside.splitlines() if line.strip()]) > 15:
            issues.append(
                issue(
                    "error",
                    "managed-block-long",
                    str(proposal),
                    "managed block exceeds 15 non-empty lines",
                )
            )
    return issues
