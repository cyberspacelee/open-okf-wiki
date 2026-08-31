import dataclasses
import hashlib
import json
import pathlib
import re
import tempfile
from datetime import datetime
from typing import Literal
from urllib.parse import unquote, urlparse

from _db import catalog_record, catalog_storage_key
from _diagram import validate as validate_diagrams
from _files import directory_digest
from _frontmatter import parse_file, render
from _markdown import extract
from _models import (
    CompositionMap,
    CompositionReviewReport,
    ConceptFrontmatter,
    DraftFrontmatter,
    KnowledgePlan,
    PlanReviewReport,
    ReviewReport,
    RunPolicy,
    model_errors,
)
from pydantic import ValidationError

_LINE_ANCHOR = re.compile(r"#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$")
CAUSAL = re.compile(
    r"\b(because|in order to|so that)\b|为了|以便|因为|由于|以致|从而", re.IGNORECASE
)
_INLINE_REF = re.compile(r"\[\^[^\]]+\]")
_LFS_PREFIX = b"version https://git-lfs.github.com/spec/v1"
MAX_STRUCTURED_ARTIFACT_BYTES = 256 * 1024
_INITIAL_PROGRESS = "<!-- repo-wiki-progress:initial -->"
_HAN = re.compile(r"[\u3400-\u9fff]")
_LATIN = re.compile(r"[A-Za-z]")
_TEMPLATE_NAMES = {
    "Overview": "overview.md",
    "Architecture": "architecture.md",
    "Domain": "domain.md",
    "Procedure": "procedure.md",
    "Flow": "flow.md",
    "Lifecycle": "lifecycle.md",
    "DataModel": "data-model.md",
    "Table": "table.md",
}
_GENERIC_PAGE_DIRECTORIES = {
    pathlib.Path(name).stem for name in _TEMPLATE_NAMES.values()
}
_TABLE_SECTIONS = {
    ("en", "Overview"): "Task entry points",
    ("en", "Architecture"): "Failure and change propagation",
    ("en", "Domain"): "Invariants and rules",
    ("en", "Procedure"): "Rules and failure modes",
    ("en", "Flow"): "Alternatives and recovery",
    ("en", "Lifecycle"): "Transitions and guards",
    ("en", "DataModel"): "Code-to-data mapping",
    ("zh", "Overview"): "任务入口",
    ("zh", "Architecture"): "故障与变更传播",
    ("zh", "Domain"): "不变量与规则",
    ("zh", "Procedure"): "规则与失败模式",
    ("zh", "Flow"): "替代路径与恢复",
    ("zh", "Lifecycle"): "转换与守卫条件",
    ("zh", "DataModel"): "代码与数据映射",
}
_TABLE_SEPARATOR = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$", re.MULTILINE)


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


@dataclasses.dataclass(frozen=True)
class ValidationResult:
    issues: list[Issue]
    skipped_checks: list[str]

    @property
    def complete(self) -> bool:
        return not self.skipped_checks


def issue(
    severity: Literal["error", "warning"],
    code: str,
    path: str,
    message: str,
    line: int | None = None,
) -> Issue:
    return Issue(severity, code, path, message, line)


def validation_result(
    issues: list[Issue], skipped_checks: list[str] | None = None
) -> ValidationResult:
    unique = {
        (item.severity, item.code, item.path, item.line, item.message): item
        for item in issues
    }
    ordered = sorted(
        unique.values(),
        key=lambda item: (item.path, item.line or 0, item.code, item.message),
    )
    return ValidationResult(ordered, sorted(set(skipped_checks or [])))


def _template_headings(
    language: str, page_type: str
) -> tuple[set[str], set[str]] | None:
    name = _TEMPLATE_NAMES[page_type]
    templates = pathlib.Path(__file__).resolve().parent.parent / "assets/templates"
    current = templates / language / name
    other = templates / ("zh" if language == "en" else "en") / name
    if not current.is_file() or not other.is_file():
        return None
    current_headings = {
        item.title for item in extract(parse_file(current).body).sections
    }
    other_headings = {item.title for item in extract(parse_file(other).body).sections}
    return current_headings, other_headings - current_headings


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
        pinned = (
            dataclasses.replace(registered, path=pin) if pin.is_dir() else registered
        )
        content = _workspace.files_blob(pinned, rel)
    else:
        content = _workspace.git_blob(registered, revision["commit"], rel)
    return (content, lo, hi) if content is not None else None


def _catalog_resource(state: dict, resource: str) -> bool:
    return _catalog_locator(state, resource) is not None


def _catalog_source(state: dict, resource: str) -> str | None:
    located = _catalog_locator(state, resource)
    return located[0] if located else None


def _catalog_locator(state: dict, resource: str) -> tuple[str, set[str]] | None:
    for catalog in state["catalogs"]:
        if resource == catalog["resource"]:
            return catalog["name"], {"."}
        for table in catalog["tables"]:
            if resource == table["resource"]:
                return catalog["name"], {table["name"], table["page_slug"]}
    return None


def _catalog_in_scope(state: dict, resource: str, roots: dict[str, list[str]]) -> bool:
    located = _catalog_locator(state, resource)
    if located is None:
        return False
    source, selectors = located
    scoped = set(roots.get(source, []))
    return "." in scoped or bool(scoped & selectors)


def _catalog_record_valid(root: pathlib.Path, entry) -> bool:
    if not isinstance(entry, dict):
        return False
    content_hash = entry.get("content_hash")
    storage_key = entry.get("storage_key")
    if (
        not isinstance(content_hash, str)
        or re.fullmatch(r"[0-9a-f]{64}", content_hash) is None
        or storage_key != catalog_storage_key(str(entry.get("name", "")), content_hash)
    ):
        return False
    capture = root / ".okf-wiki" / "catalogs" / storage_key / "catalog.json"
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
    return entry == catalog_record(captured, content_hash, storage_key)


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
    path: pathlib.Path, model, *, markdown: bool = False
) -> tuple[object | None, list[Issue]]:
    size = path.stat().st_size
    if size > MAX_STRUCTURED_ARTIFACT_BYTES:
        return None, [
            issue(
                "error",
                "artifact-too-large",
                str(path),
                f"structured artifact is {size} bytes; limit is "
                f"{MAX_STRUCTURED_ARTIFACT_BYTES}; remove repeated items or "
                "embedded source text",
            )
        ]
    try:
        if markdown:
            parsed = parse_file(path)
            if parsed.errors:
                return None, [
                    issue("error", "frontmatter-invalid", str(path), message)
                    for message in parsed.errors
                ]
            if not parsed.body.strip():
                return None, [
                    issue(
                        "error",
                        "artifact-body-empty",
                        str(path),
                        "Markdown artifact requires an analysis body",
                    )
                ]
            return model.model_validate(parsed.meta, strict=True), []
        raw = path.read_text(encoding="utf-8")
        return model.model_validate_json(raw, strict=True), []
    except (OSError, UnicodeDecodeError) as exc:
        return None, [issue("error", "artifact-invalid", str(path), str(exc))]
    except ValidationError as exc:
        return None, [
            issue("error", "schema-invalid", str(path), message)
            for message in model_errors(exc)
        ]


def _path_in_scope(path: str, roots: list[str]) -> bool:
    return any(
        root in ("", ".")
        or path == root.rstrip("/")
        or path.startswith(root.rstrip("/") + "/")
        for root in roots
    )


def _validate_scopes(
    root: pathlib.Path, state: dict, item, path: pathlib.Path
) -> list[Issue]:
    import _workspace

    issues = []
    workspace = _workspace.load(root)
    roots: dict[str, list[str]] = {}
    for scope in item.scopes:
        roots.setdefault(scope.source, []).extend(scope.paths)
        source = workspace.sources.get(scope.source)
        if source is None:
            issues.append(
                issue("error", "scope-source-invalid", str(path), scope.source)
            )
            continue
        if source.kind in ("opengauss", "postgres"):
            catalog = next(
                (entry for entry in state["catalogs"] if entry["name"] == scope.source),
                None,
            )
            allowed = {"."}
            if catalog:
                allowed.update(table["page_slug"] for table in catalog["tables"])
                allowed.update(table["name"] for table in catalog["tables"])
            invalid = set(scope.paths) - allowed
            for scope_path in sorted(invalid):
                issues.append(
                    issue(
                        "error",
                        "scope-path-invalid",
                        str(path),
                        f"{scope.source}/{scope_path}",
                    )
                )
            continue
        pin = _workspace.pin_dir(root, state["run_id"], scope.source)
        for scope_path in scope.paths:
            candidate = pin if scope_path == "." else pin / scope_path
            if not candidate.exists():
                issues.append(
                    issue(
                        "error",
                        "scope-path-invalid",
                        str(path),
                        f"{scope.source}/{scope_path}",
                    )
                )
    seeded_sources = set()
    for resource in item.evidence_seeds:
        catalog_locator = _catalog_locator(state, resource)
        if catalog_locator is not None:
            seeded_sources.add(catalog_locator[0])
            if not _catalog_in_scope(state, resource, roots):
                issues.append(
                    issue("error", "evidence-outside-scope", str(path), resource)
                )
            continue
        resolved = _resolve_resource(root, state, resource)
        parsed = parse_resource(resource)
        if resolved is None or parsed is None:
            issues.append(issue("error", "evidence-unresolved", str(path), resource))
            continue
        source_name, rel, _, _ = parsed
        seeded_sources.add(source_name)
        if source_name not in roots or not _path_in_scope(rel, roots[source_name]):
            issues.append(issue("error", "evidence-outside-scope", str(path), resource))
            continue
        issues.extend(_check_range(*resolved, resource))
    for source_name in sorted(set(roots) - seeded_sources):
        issues.append(
            issue(
                "error",
                "scope-source-unseeded",
                str(path),
                f"{item.id}: scoped source {source_name} requires an evidence seed",
            )
        )
    return issues


def _validate_knowledge_plan(
    root: pathlib.Path, state: dict, plan: KnowledgePlan, path: pathlib.Path
) -> list[Issue]:
    return [
        problem
        for unit in plan.units
        for problem in _validate_scopes(root, state, unit, path)
    ]


def _validate_composition(
    plan: KnowledgePlan, composition: CompositionMap, path: pathlib.Path
) -> list[Issue]:
    issues = []
    units = {unit.id: unit for unit in plan.units}
    for page in composition.pages:
        if pathlib.PurePosixPath(page.path).name in {"index.md", "log.md"}:
            issues.append(issue("error", "reserved-page", str(path), page.path))
        parts = pathlib.PurePosixPath(page.path).parts
        if (
            len(composition.pages) > 1
            and page.type not in {"Overview", "Architecture"}
            and len(parts) < 2
        ):
            issues.append(
                issue(
                    "error",
                    "capability-path-required",
                    str(path),
                    f"{page.id}: multi-page Wikis place concept pages under a capability directory",
                )
            )
        if any(part in _GENERIC_PAGE_DIRECTORIES for part in parts[:-1]):
            issues.append(
                issue(
                    "error",
                    "page-type-directory",
                    str(path),
                    f"{page.path}: use a capability directory, not a page-type directory",
                )
            )
        inherited_sources = {
            scope.source
            for unit_id in page.units
            if unit_id in units
            for scope in units[unit_id].scopes
        }
        for diagram in page.diagrams:
            unknown = set(diagram.sources) - inherited_sources
            if unknown:
                issues.append(
                    issue(
                        "error",
                        "diagram-source-outside-scope",
                        str(path),
                        f"{page.id}/{diagram.id}: {sorted(unknown)}",
                    )
                )
    active_units = {unit.id for unit in plan.units}
    mapped = [unit for page in composition.pages for unit in page.units]
    if set(mapped) != active_units or len(mapped) != len(set(mapped)):
        issues.append(
            issue(
                "error",
                "composition-coverage-invalid",
                str(path),
                "knowledge units must be assigned to exactly one page",
            )
        )
    return issues


def page_spec(plan: KnowledgePlan, page) -> dict:
    units = {unit.id: unit for unit in plan.units}
    scopes = []
    seen = set()
    for unit_id in page.units:
        unit = units.get(unit_id)
        if unit is None:
            continue
        for scope in unit.scopes:
            value = (scope.source, scope.role, tuple(scope.paths))
            if value not in seen:
                seen.add(value)
                scopes.append(scope.model_dump(mode="json"))
    sources = {scope["source"] for scope in scopes}
    return {
        **page.model_dump(mode="json"),
        "scopes": scopes,
        "owner": next(iter(sources)) if len(sources) == 1 else "workspace",
    }


def _validate_page_draft(
    root: pathlib.Path, state: dict, spec: dict, path: pathlib.Path
) -> list[Issue]:
    issues = validate_page(
        root,
        state,
        path,
        owner=spec["owner"],
        expected=spec,
        published=False,
    )
    parsed = parse_file(path)
    if parsed.errors:
        return issues
    roots: dict[str, list[str]] = {}
    for scope in spec["scopes"]:
        roots.setdefault(scope["source"], []).extend(scope["paths"])
    cited_sources = set()
    for source in parsed.meta.get("sources", []):
        resource = source.get("resource", "") if isinstance(source, dict) else ""
        catalog_locator = _catalog_locator(state, resource)
        if catalog_locator is not None:
            cited_sources.add(catalog_locator[0])
            if not _catalog_in_scope(state, resource, roots):
                issues.append(
                    issue("error", "evidence-outside-scope", str(path), resource)
                )
            continue
        locator = parse_resource(resource)
        if locator is None:
            continue
        source_name, rel, _, _ = locator
        cited_sources.add(source_name)
        if source_name not in roots or not _path_in_scope(rel, roots[source_name]):
            issues.append(issue("error", "evidence-outside-scope", str(path), resource))
    if len(roots) > 1:
        missing = set(roots) - cited_sources
        if missing:
            issues.append(
                issue(
                    "error",
                    "cross-source-evidence-missing",
                    str(path),
                    f"workspace page does not cite scoped sources: {sorted(missing)}",
                )
            )
    return issues


def validate_plan_artifact(
    root: pathlib.Path, state: dict, path: pathlib.Path
) -> tuple[KnowledgePlan | None, list[Issue]]:
    if not path.is_file():
        return None, [
            issue("error", "plan-missing", str(path), "write the Knowledge Plan")
        ]
    value, issues = _model_issues(path, KnowledgePlan, markdown=True)
    if value:
        issues.extend(_validate_knowledge_plan(root, state, value, path))
    return value, issues


def validate_progress_artifact(path: pathlib.Path) -> list[Issue]:
    if not path.is_file():
        return [issue("error", "progress-missing", str(path), "write run progress")]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [issue("error", "progress-invalid", str(path), str(exc))]
    if not text.strip() or _INITIAL_PROGRESS in text:
        return [
            issue(
                "error",
                "progress-stale",
                str(path),
                "replace the initial progress note with findings, gaps and next actions",
            )
        ]
    return []


def _merge_probe_issues(
    path: pathlib.Path, probes, id_field: str, expected_ids: set[str] | None
) -> list[Issue]:
    if expected_ids is None:
        return []
    covered = {item_id for probe in probes for item_id in getattr(probe, id_field)}
    issues = []
    unknown = covered - expected_ids
    if unknown:
        issues.append(
            issue("error", "merge-probe-id-invalid", str(path), str(sorted(unknown)))
        )
    if len(expected_ids) > 1:
        missing = expected_ids - covered
        if missing:
            issues.append(
                issue(
                    "error",
                    "merge-probe-incomplete",
                    str(path),
                    f"merge probes must cover every routed item: {sorted(missing)}",
                )
            )
    elif probes:
        issues.append(
            issue(
                "error",
                "merge-probe-unnecessary",
                str(path),
                "merge probes require at least two routed items",
            )
        )
    return issues


def validate_plan_review(
    path: pathlib.Path,
    expected_digest: str | None,
    unit_ids: set[str] | None = None,
) -> tuple[PlanReviewReport | None, list[Issue]]:
    if not path.is_file():
        return None, [
            issue(
                "error",
                "plan-review-missing",
                str(path),
                "run an independent Knowledge Plan review",
            )
        ]
    value, issues = _model_issues(path, PlanReviewReport)
    if value:
        if expected_digest is not None and value.subject_digest != expected_digest:
            issues.append(
                issue(
                    "error",
                    "plan-review-digest-invalid",
                    str(path),
                    "plan review does not bind the current Knowledge Plan",
                )
            )
        issues.extend(
            _merge_probe_issues(path, value.merge_probes, "unit_ids", unit_ids)
        )
        if unit_ids is not None:
            unknown = {
                unit_id
                for report_issue in value.issues
                if report_issue.status == "open"
                for unit_id in report_issue.unit_ids
            } - unit_ids
            if unknown:
                issues.append(
                    issue(
                        "error",
                        "plan-review-unit-invalid",
                        str(path),
                        str(sorted(unknown)),
                    )
                )
    return value, issues


def validate_composition_artifact(
    path: pathlib.Path, plan: KnowledgePlan | None
) -> tuple[CompositionMap | None, list[Issue]]:
    if not path.is_file():
        return None, [
            issue(
                "error", "composition-missing", str(path), "write the Composition Map"
            )
        ]
    value, issues = _model_issues(path, CompositionMap, markdown=True)
    if value and plan is not None:
        issues.extend(_validate_composition(plan, value, path))
    return value, issues


def validate_composition_review(
    path: pathlib.Path, expected_digest: str | None, page_ids: set[str] | None
) -> tuple[CompositionReviewReport | None, list[Issue]]:
    if not path.is_file():
        return None, [
            issue(
                "error",
                "composition-review-missing",
                str(path),
                "run an independent Composition review",
            )
        ]
    value, issues = _model_issues(path, CompositionReviewReport)
    if value:
        if expected_digest is not None and value.subject_digest != expected_digest:
            issues.append(
                issue(
                    "error",
                    "composition-review-digest-invalid",
                    str(path),
                    "composition review does not bind the current Plan and Composition",
                )
            )
        for report_issue in value.issues:
            if report_issue.status == "open" and report_issue.area != "composition":
                issues.append(
                    issue(
                        "error",
                        "composition-review-area-invalid",
                        str(path),
                        "Composition review issues must use the composition area",
                    )
                )
            unknown = (
                set(report_issue.page_ids) - page_ids
                if page_ids is not None and report_issue.status == "open"
                else set()
            )
            if unknown:
                issues.append(
                    issue(
                        "error",
                        "composition-review-page-invalid",
                        str(path),
                        str(sorted(unknown)),
                    )
                )
        issues.extend(
            _merge_probe_issues(path, value.merge_probes, "page_ids", page_ids)
        )
    return value, issues


def validate_drafts(
    root: pathlib.Path,
    state: dict,
    plan: KnowledgePlan,
    composition: CompositionMap,
    drafts: pathlib.Path,
) -> list[Issue]:
    expected = {page.id: page for page in composition.pages}
    present = {path.stem: path for path in drafts.glob("*.md")}
    issues = [
        issue("error", "page-draft-missing", str(drafts / f"{page_id}.md"), page_id)
        for page_id in sorted(set(expected) - set(present))
    ]
    for page_id in sorted(set(present) - set(expected)):
        issues.append(
            issue("error", "page-draft-unplanned", str(present[page_id]), page_id)
        )
    with tempfile.TemporaryDirectory(prefix="okf-draft-check-") as temporary:
        checked = pathlib.Path(temporary)
        for page_id in sorted(set(expected) & set(present)):
            spec = page_spec(plan, expected[page_id])
            rendered = render_generated_page(root, state, spec, present[page_id])
            if rendered is None:
                parsed = parse_file(present[page_id])
                messages = parsed.errors
                if not messages:
                    try:
                        DraftFrontmatter.model_validate(parsed.meta, strict=True)
                    except ValidationError as exc:
                        messages = model_errors(exc)
                issues.extend(
                    issue(
                        "error", "frontmatter-invalid", str(present[page_id]), message
                    )
                    for message in messages
                )
                continue
            path = checked / f"{page_id}.md"
            path.write_text(rendered, encoding="utf-8", newline="\n")
            issues.extend(
                dataclasses.replace(item, path=str(present[page_id]))
                for item in _validate_page_draft(root, state, spec, path)
            )
    return issues


def validate_unbound_drafts(path: pathlib.Path) -> list[Issue]:
    issues = []
    for draft in sorted(path.glob("*.md")):
        parsed = parse_file(draft)
        issues.extend(
            issue("error", "frontmatter-invalid", str(draft), message)
            for message in parsed.errors
        )
        if parsed.errors:
            continue
        for placeholder, line in extract(parsed.body).placeholders:
            issues.append(
                issue("error", "placeholder-remaining", str(draft), placeholder, line)
            )
    return issues


def validate_review(
    path: pathlib.Path, expected_digest: str, page_ids: set[str]
) -> tuple[ReviewReport | None, list[Issue]]:
    if not path.is_file():
        return None, [
            issue(
                "error", "review-missing", str(path), "run an independent Wiki review"
            )
        ]
    value, issues = _model_issues(path, ReviewReport)
    if value:
        if value.subject_digest != expected_digest:
            issues.append(
                issue(
                    "error",
                    "review-digest-invalid",
                    str(path),
                    "review does not bind the current Wiki bundle",
                )
            )
        for report_issue in value.issues:
            unknown = (
                set(report_issue.page_ids) - page_ids
                if report_issue.status == "open"
                else set()
            )
            if unknown:
                issues.append(
                    issue(
                        "error", "review-page-invalid", str(path), str(sorted(unknown))
                    )
                )
    return value, issues


def render_generated_page(
    root: pathlib.Path, state: dict, spec: dict, path: pathlib.Path
) -> str | None:
    import _workspace

    parsed = parse_file(path)
    if parsed.errors:
        return None
    try:
        draft = DraftFrontmatter.model_validate(parsed.meta, strict=True)
    except ValidationError:
        return None
    meta = draft.model_dump(mode="json", exclude_none=True)
    meta.update(
        {
            "id": spec["id"],
            "type": spec["type"],
            "title": spec["title"],
            "description": spec["description"],
            "tags": spec["tags"],
            "diagrams": spec["diagrams"],
            "language": state["language"],
            "status": "draft",
            "generated": {
                "by": "repo-wiki",
                "at": datetime.fromisoformat(state["started_at"]),
            },
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


def validate_page(
    root: pathlib.Path,
    state: dict,
    path: pathlib.Path,
    *,
    owner: str | None = None,
    expected: dict | None = None,
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
    if expected is not None:
        actual_diagrams = [
            diagram.model_dump(mode="json") for diagram in frontmatter.diagrams
        ]
        if (
            frontmatter.id != expected.get("id")
            or frontmatter.type != expected.get("type")
            or actual_diagrams != expected.get("diagrams")
        ):
            issues.append(
                issue(
                    "error",
                    "page-plan-metadata-mismatch",
                    str(path),
                    "page id, type and diagrams must exactly match the Composition Map",
                )
            )
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
    if frontmatter.language is not None:
        if frontmatter.language != state.get("language"):
            issues.append(
                issue(
                    "error",
                    "page-language-mismatch",
                    str(path),
                    f"page language must match workspace language {state.get('language')}",
                )
            )
        pattern = _HAN if frontmatter.language == "zh" else _LATIN
        for field, value in (
            ("title", frontmatter.title or ""),
            ("description", frontmatter.description or ""),
            ("body", parsed.body),
        ):
            if not pattern.search(value):
                issues.append(
                    issue(
                        "error",
                        "language-content-missing",
                        str(path),
                        f"{field} has no {frontmatter.language} language text",
                    )
                )
        headings = _template_headings(frontmatter.language, frontmatter.type)
        if headings is None:
            issues.append(
                issue(
                    "error",
                    "template-missing",
                    str(path),
                    f"missing {frontmatter.language}/{_TEMPLATE_NAMES[frontmatter.type]}",
                )
            )
        else:
            required, forbidden = headings
            actual_headings = {section.title for section in structure.sections}
            for missing in sorted(required - actual_headings):
                issues.append(
                    issue(
                        "error",
                        "template-heading-missing",
                        str(path),
                        f"required {frontmatter.type} heading is missing: {missing}",
                    )
                )
            for section in structure.sections:
                if section.title in forbidden:
                    issues.append(
                        issue(
                            "error",
                            "template-heading-leak",
                            str(path),
                            f"heading belongs to the other language template: {section.title}",
                            section.start_line,
                        )
                    )
            table_title = _TABLE_SECTIONS.get((frontmatter.language, frontmatter.type))
            table_section = next(
                (
                    section
                    for section in structure.sections
                    if section.title == table_title
                ),
                None,
            )
            if table_title and (
                table_section is None
                or _TABLE_SEPARATOR.search(table_section.content) is None
            ):
                issues.append(
                    issue(
                        "error",
                        "required-table-missing",
                        str(path),
                        f"{table_title} requires a compact Markdown table",
                        table_section.start_line if table_section else None,
                    )
                )
    source_citations: dict[str, set[str]] = {}
    for source in frontmatter.sources:
        locator = parse_resource(source.resource)
        source_name = locator[0] if locator else _catalog_source(state, source.resource)
        if source_name:
            source_citations.setdefault(source_name, set()).add(source.id)
    for code, message, line in validate_diagrams(
        structure, frontmatter.diagrams, source_citations
    ):
        issues.append(issue("error", code, str(path), message, line))
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
    gap_title = "缺口" if frontmatter.language == "zh" else "Gaps"
    gaps = [section for section in structure.sections if section.title == gap_title]
    if frontmatter.coverage == "partial":
        if not gaps or not gaps[0].content:
            issues.append(
                issue(
                    "error",
                    "gaps-missing",
                    str(path),
                    f"partial coverage requires a non-empty {gap_title} section",
                )
            )
    elif frontmatter.coverage == "full" and gaps:
        issues.append(
            issue(
                "error",
                "gaps-unexpected",
                str(path),
                f"full coverage must not include a {gap_title} section",
                gaps[0].start_line,
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


def validate_navigation(path: pathlib.Path, language: str) -> list[Issue]:
    import _publish

    expected = _publish.render_indexes(path, language)
    actual = {
        item.relative_to(path).as_posix(): item for item in path.rglob("index.md")
    }
    issues = []
    if set(actual) != set(expected):
        issues.append(
            issue(
                "error",
                "navigation-index-set-invalid",
                str(path),
                f"expected indexes {sorted(expected)}, found {sorted(actual)}",
            )
        )
    for relative in sorted(set(actual) & set(expected)):
        if actual[relative].read_text(encoding="utf-8") != expected[relative]:
            issues.append(
                issue(
                    "error",
                    "navigation-index-stale",
                    str(actual[relative]),
                    "navigation index does not match the Candidate page tree",
                )
            )
    return issues


def validate_candidate(
    root: pathlib.Path, state: dict, *, published: bool
) -> ValidationResult:
    import _state

    base = root / ".okf-wiki" / "runs" / state["run_id"]
    candidate = base / "candidate"
    work = base / "work"
    plan_path = work / "plan.md"
    composition_path = work / "composition.md"
    plan, plan_issues = validate_plan_artifact(root, state, plan_path)
    plan_digest = (
        _state._plan_subject_digest(root, state) if plan_path.is_file() else None
    )
    plan_review, plan_review_issues = validate_plan_review(
        work / "plan-review.json",
        plan_digest,
        {unit.id for unit in plan.units} if plan is not None else None,
    )
    composition, composition_issues = validate_composition_artifact(
        composition_path, plan
    )
    composition_inputs_exist = all(
        path.is_file()
        for path in (plan_path, work / "plan-review.json", composition_path)
    )
    composition_digest = (
        _state._composition_subject_digest(root, state)
        if composition_inputs_exist
        else None
    )
    composition_review, composition_review_issues = validate_composition_review(
        work / "composition-review.json",
        composition_digest,
        {page.id for page in composition.pages} if composition is not None else None,
    )
    all_pages = sorted(candidate.rglob("*.md")) if candidate.exists() else []
    pages = [path for path in all_pages if path.name not in ("index.md", "log.md")]
    issues = [
        *plan_issues,
        *plan_review_issues,
        *composition_issues,
        *composition_review_issues,
    ]
    skipped = []
    if plan is None:
        skipped.extend(
            [
                "composition-unit-binding",
                "draft-scope-binding",
                "page-scope-binding",
            ]
        )
    if composition is None:
        skipped.extend(
            [
                "composition-review-page-binding",
                "draft-page-binding",
                "candidate-page-binding",
            ]
        )
    if plan_digest is None:
        skipped.append("plan-review-digest")
    if composition_digest is None:
        skipped.append("composition-review-digest")
    if plan_review is not None and plan_review.verdict != "approved":
        issues.append(
            issue(
                "error",
                "plan-review-rejected",
                str(work / "plan-review.json"),
                "Knowledge Plan review must be approved",
            )
        )
    if composition_review is not None and composition_review.verdict != "approved":
        issues.append(
            issue(
                "error",
                "composition-review-rejected",
                str(work / "composition-review.json"),
                "Composition review must be approved",
            )
        )
    page_set = {path.relative_to(candidate).as_posix() for path in pages}
    page_by_path = (
        {page.path: page for page in composition.pages}
        if composition is not None
        else {}
    )
    if composition is not None and page_set != set(page_by_path):
        issues.append(
            issue(
                "error",
                "page-set-mismatch",
                str(candidate),
                "candidate pages must exactly match the Composition Map",
            )
        )
    for path in pages:
        rel = path.relative_to(candidate).as_posix()
        page = page_by_path.get(rel)
        expected = (
            page_spec(plan, page)
            if plan is not None and page is not None
            else page.model_dump(mode="json")
            if page is not None
            else None
        )
        issues.extend(
            validate_page(
                root,
                state,
                path,
                owner=expected.get("owner") if expected else None,
                expected=expected,
                published=published,
            )
        )
    issues.extend(validate_navigation(candidate, state["language"]))
    allowed = {path.relative_to(candidate).as_posix() for path in all_pages}
    linked_pages = [path for path in all_pages if path.name != "log.md"]
    issues.extend(_link_issues(candidate, linked_pages, allowed))
    if plan is not None and composition is not None:
        issues.extend(validate_drafts(root, state, plan, composition, work / "drafts"))
    else:
        issues.extend(validate_unbound_drafts(work / "drafts"))
    return validation_result(issues, skipped)


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
                    structure = extract(parsed.body)
                    for code, message, line in validate_diagrams(
                        structure, concept.diagrams
                    ):
                        issues.append(issue("error", code, str(page), message, line))
                except ValidationError as exc:
                    issues.extend(
                        issue("error", "frontmatter-invalid", str(page), message)
                        for message in model_errors(exc)
                    )
    return issues


def validate_publication(root: pathlib.Path, path: pathlib.Path) -> ValidationResult:
    import _workspace

    issues = validate_bundle(path)
    skipped = []
    manifest_path = path / ".okf-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        issues.append(issue("error", "manifest-invalid", str(manifest_path), str(exc)))
        skipped.append("manifest-binding")
        return validation_result(issues, skipped)
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
        skipped.append("manifest-binding")
        return validation_result(issues, skipped)
    try:
        policy = RunPolicy.model_validate(manifest.get("policy"), strict=True)
    except ValidationError as exc:
        issues.extend(
            issue("error", "manifest-policy-invalid", str(manifest_path), message)
            for message in model_errors(exc)
        )
        skipped.append("manifest-binding")
        return validation_result(issues, skipped)
    if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("skill_bundle_digest", "")):
        issues.append(
            issue(
                "error",
                "manifest-skill-digest-invalid",
                str(manifest_path),
                "skill bundle digest is missing or invalid",
            )
        )
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

    state = {
        "run_id": manifest.get("run_id"),
        "revisions": revisions,
        "catalogs": catalogs,
        "language": _workspace.load(root).language,
        "policy": policy.model_dump(mode="json"),
    }
    concepts = sorted(
        page for page in path.rglob("*.md") if page.name not in ("index.md", "log.md")
    )
    for page in concepts:
        issues.extend(validate_page(root, state, page, published=True))
    linked_pages = sorted(page for page in path.rglob("*.md") if page.name != "log.md")
    allowed = {page.relative_to(path).as_posix() for page in path.rglob("*.md")}
    issues.extend(_link_issues(path, linked_pages, allowed))
    return validation_result(issues, skipped)


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
    for proposal in sorted(path.glob("agents-block-*.md")):
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
