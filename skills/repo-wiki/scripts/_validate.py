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
SURVEY_TOTAL_MAX_BYTES = 512 * 1024


def survey_budget(state: dict) -> tuple[int, int]:
    """Per-survey and whole-set byte budgets; wider for zh (UTF-8 ~3 bytes/char)."""
    per_file = SURVEY_MAX_BYTES * 2 if state.get("language") == "zh" else SURVEY_MAX_BYTES
    count = sum(1 for task in state["tasks"].values() if task["phase"] == "survey")
    return per_file, max(SURVEY_TOTAL_MAX_BYTES, count * per_file)


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
            for connection in value.connections:
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
        value, issues = _model_issues(path, PagePlan, path.read_text(encoding="utf-8"))
        if value:
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
            owner = expected_source or "workspace"
            known_findings = set(_finding_id_list(base))
            known_connections = _connection_ids(base)
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
                unknown = [fid for fid in page.finding_ids if fid not in known_findings]
                if unknown:
                    issues.append(
                        issue(
                            "error",
                            "finding-unknown",
                            str(path),
                            f"{page.path} cites unknown findings {unknown}",
                        )
                    )
                unknown_c = [
                    cid for cid in page.connection_ids if cid not in known_connections
                ]
                if unknown_c:
                    issues.append(
                        issue(
                            "error",
                            "connection-unknown",
                            str(path),
                            f"{page.path} cites unknown connections {unknown_c}",
                        )
                    )
        return issues
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
        return issues
    if phase == "write":
        return _validate_write(root, state, task, path)
    return [issue("error", "phase-unknown", str(path), f"unknown phase {phase}")]



def _covered_files(files: list[str], paths: list[str], exclude: list[str]) -> set[str]:
    remaining = []
    for item in files:
        if any(item == entry or item.startswith(entry.rstrip("/") + "/") for entry in exclude):
            continue
        remaining.append(item)
    covered = set()
    for path in paths:
        if path in (".", ""):
            covered.update(remaining)
            continue
        for item in remaining:
            if item == path or item.startswith(path.rstrip("/") + "/"):
                covered.add(item)
    return covered


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
    files = (
        _workspace.tree_files(pin)
        if source.kind == "files"
        else _workspace.tracked_files(source, revision.get("commit"))
    )
    expected = _covered_files(files, ["."], list(source.survey_exclude))
    claimed: set[str] = set()
    for scope in value.scopes:
        covered = _covered_files(files, list(scope.paths), list(source.survey_exclude))
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
    max_bytes, total_max_bytes = survey_budget(state)
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    survey_root = base / "drafts" / "survey"
    survey_total = sum(
        item.stat().st_size for item in survey_root.rglob("*.json") if item.is_file()
    )
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
        for finding in value.findings:
            for locator in finding.evidence:
                resolved = _resolve_resource(root, state, locator)
                if resolved is None:
                    issues.append(issue("error", "locator-unresolved", str(path), locator))
                else:
                    issues.extend(_check_range(*resolved, locator))
    if survey_total > total_max_bytes:
        issues.append(
            issue(
                "error",
                "survey-set-too-large",
                str(survey_root),
                f"survey set exceeds {total_max_bytes} bytes",
            )
        )
    return issues



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
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    plan_dir = base / "drafts" / "plan"
    pages = []
    exclusions = []
    issues = []
    for path in sorted(plan_dir.glob("*.json")):
        value, local = _model_issues(path, PagePlan, path.read_text(encoding="utf-8"))
        issues.extend(local)
        if value:
            pages.extend(value.pages)
            exclusions.extend(value.exclusions)
    if issues:
        return issues
    paths = {page.path for page in pages}
    page_by_path = {page.path: page for page in pages}
    if len(paths) != len(pages):
        issues.append(
            issue(
                "error",
                "page-path-duplicate",
                str(plan_dir),
                "page paths must be unique across plan shards",
            )
        )
    required = {"overview.md", "architecture.md"}
    known_owners = {
        "workspace",
        *(item["name"] for item in state["revisions"]),
        *(item["name"] for item in state["catalogs"]),
    }
    unknown_owners = sorted(
        {page.owner for page in pages if page.owner not in known_owners}
    )
    if unknown_owners:
        issues.append(
            issue(
                "error",
                "page-owner-invalid",
                str(plan_dir),
                f"unknown page owners: {unknown_owners}",
            )
        )
    for core_path, core_type in (
        ("overview.md", "Overview"),
        ("architecture.md", "Architecture"),
    ):
        entry = page_by_path.get(core_path)
        if entry is None or entry.owner != "workspace" or entry.type != core_type:
            issues.append(
                issue(
                    "error",
                    "core-page-invalid",
                    str(plan_dir),
                    f"{core_path} must be a workspace-owned {core_type}",
                )
            )
    git_or_files = [
        item["name"]
        for item in state["revisions"]
        if item.get("kind") in ("git", "files", None)
    ]
    if len(git_or_files) > 1:
        for source in git_or_files:
            source_path = source.lower()
            required.add(f"{source_path}/architecture.md")
            entry = page_by_path.get(f"{source_path}/architecture.md")
            if entry and (entry.owner != source or entry.type != "Architecture"):
                issues.append(
                    issue(
                        "error",
                        "source-architecture-invalid",
                        str(plan_dir),
                        f"{source_path}/architecture.md must be owned by {source}",
                    )
                )
    database_sources = state["catalogs"]
    if database_sources:
        required.add("data-model.md")
    for catalog in database_sources:
        source_path = catalog["name"].lower()
        for table in catalog["tables"]:
            required.add(f"data/{source_path}/{table['page_slug']}.md")
    missing = required - paths
    if missing:
        issues.append(
            issue(
                "error",
                "page-plan-incomplete",
                str(plan_dir),
                f"missing required pages: {sorted(missing)}",
            )
        )
    if database_sources:
        data_model = page_by_path.get("data-model.md")
        if data_model and (
            data_model.type != "DataModel" or data_model.owner != "workspace"
        ):
            issues.append(
                issue(
                    "error",
                    "data-page-invalid",
                    str(plan_dir),
                    "data-model.md must be a workspace-owned DataModel",
                )
            )
    for catalog in database_sources:
        source_path = catalog["name"].lower()
        for table in catalog["tables"]:
            table_path = f"data/{source_path}/{table['page_slug']}.md"
            entry = page_by_path.get(table_path)
            if entry and (entry.type != "Table" or entry.owner != catalog["name"]):
                issues.append(
                    issue(
                        "error",
                        "data-page-invalid",
                        str(plan_dir),
                        f"{table_path} must be a Table owned by {catalog['name']}",
                    )
                )
    finding_list = _finding_id_list(base)
    finding_ids = set(finding_list)
    if len(finding_list) != len(finding_ids):
        issues.append(
            issue(
                "error",
                "finding-id-duplicate",
                str(plan_dir),
                "finding ids must be globally unique",
            )
        )
    assigned_list = [fid for page in pages for fid in page.finding_ids]
    excluded_list = [item.finding_id for item in exclusions]
    assigned = set(assigned_list)
    excluded = set(excluded_list)
    if (
        finding_ids != assigned | excluded
        or assigned & excluded
        or len(assigned_list) != len(assigned)
        or len(excluded_list) != len(excluded)
    ):
        issues.append(
            issue(
                "error",
                "finding-coverage-invalid",
                str(plan_dir),
                "every finding must be assigned once or explicitly excluded",
            )
        )
    connection_entries = _connection_entries(base)
    connection_list_all = [item.id for _, item in connection_entries]
    connection_ids = set(connection_list_all)
    if len(connection_list_all) != len(connection_ids):
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
    connection_list = [cid for page in pages for cid in page.connection_ids]
    assigned_connections = set(connection_list)
    if connection_ids != assigned_connections or len(connection_list) != len(
        assigned_connections
    ):
        issues.append(
            issue(
                "error",
                "connection-coverage-invalid",
                str(plan_dir),
                "every connection must be assigned to a page",
            )
        )
    if len(pages) < 2:
        issues.append(
            issue(
                "error",
                "page-plan-incomplete",
                str(plan_dir),
                "composed plan must contain at least two pages",
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
