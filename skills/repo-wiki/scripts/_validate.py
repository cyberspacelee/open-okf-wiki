import dataclasses
import hashlib
import json
import pathlib
import re
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import unquote, urlparse

from _files import directory_digest
from _frontmatter import parse_file, render
from _markdown import extract
from _models import (
    ConceptFrontmatter,
    PagePlan,
    ReviewReport,
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
        pinned = (
            dataclasses.replace(registered, path=pin) if pin.is_dir() else registered
        )
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
    if (
        not isinstance(content_hash, str)
        or re.fullmatch(r"[0-9a-f]{64}", content_hash) is None
    ):
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


def _model_issues(path: pathlib.Path, model) -> tuple[object | None, list[Issue]]:
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
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, [issue("error", "artifact-invalid", str(path), str(exc))]
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
    kind = task["kind"]
    if kind == "plan":
        value, issues = _model_issues(path, PagePlan)
        if value:
            issues.extend(_validate_page_plan(root, state, value, path))
        return issues
    if kind == "page":
        return _validate_page_target(root, state, task, path)
    if kind == "review":
        value, issues = _model_issues(path, ReviewReport)
        if value:
            if value.page != task["name"]:
                issues.append(
                    issue("error", "review-target-invalid", str(path), value.page)
                )
            expected = state["targets"][task["depends_on"][0]].get("output_digest")
            if value.page_digest != expected:
                issues.append(
                    issue(
                        "error",
                        "review-digest-invalid",
                        str(path),
                        "review does not bind the dispatched page digest",
                    )
                )
            if any(
                item.reopen == "plan" and item.target != "plan:workspace"
                for item in value.issues
            ):
                issues.append(
                    issue(
                        "error",
                        "review-target-invalid",
                        str(path),
                        "plan issues must target plan:workspace",
                    )
                )
        return issues
    return [issue("error", "target-kind-unknown", str(path), f"unknown kind {kind}")]


def _path_in_scope(path: str, roots: list[str]) -> bool:
    return any(
        root in ("", ".")
        or path == root.rstrip("/")
        or path.startswith(root.rstrip("/") + "/")
        for root in roots
    )


def _validate_page_plan(
    root: pathlib.Path, state: dict, plan: PagePlan, path: pathlib.Path
) -> list[Issue]:
    import _workspace

    issues = []
    workspace = _workspace.load(root)
    known = set(workspace.sources)
    planned_paths = {page.path for page in plan.pages}
    if "overview.md" not in planned_paths:
        issues.append(
            issue(
                "error", "overview-missing", str(path), "plan must include overview.md"
            )
        )
    if "architecture.md" not in planned_paths:
        issues.append(
            issue(
                "error",
                "architecture-missing",
                str(path),
                "plan must include architecture.md",
            )
        )
    for page in plan.pages:
        if pathlib.PurePosixPath(page.path).name in {"index.md", "log.md"}:
            issues.append(issue("error", "reserved-page", str(path), page.path))
        if page.owner != "workspace" and not page.path.startswith(
            f"data/{page.owner.lower()}/"
        ):
            issues.append(
                issue(
                    "error",
                    "page-owner-path-invalid",
                    str(path),
                    f"{page.path} must live under data/{page.owner.lower()}/",
                )
            )
        for scope in page.scopes:
            if scope.source not in known:
                issues.append(
                    issue("error", "scope-source-invalid", str(path), scope.source)
                )
                continue
            source = workspace.sources[scope.source]
            if source.kind in ("opengauss", "postgres"):
                catalog = next(
                    (
                        item
                        for item in state["catalogs"]
                        if item["name"] == scope.source
                    ),
                    None,
                )
                allowed = {"."}
                if catalog:
                    allowed.update(table["page_slug"] for table in catalog["tables"])
                    allowed.update(table["name"] for table in catalog["tables"])
                for scope_path in scope.paths:
                    if scope_path not in allowed:
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
        if page.owner != "workspace" and any(
            scope.source != page.owner for scope in page.scopes
        ):
            issues.append(
                issue(
                    "error",
                    "page-owner-scope-invalid",
                    str(path),
                    f"{page.path} includes a scope outside owner {page.owner}",
                )
            )
    return issues


def _validate_page_target(
    root: pathlib.Path, state: dict, task: dict, path: pathlib.Path
) -> list[Issue]:
    issues = validate_page(
        root, state, path, owner=task["spec"].get("owner"), published=False
    )
    parsed = parse_file(path)
    if parsed.errors:
        return issues
    roots: dict[str, list[str]] = {}
    for scope in task["spec"].get("scopes", []):
        roots.setdefault(scope["source"], []).extend(scope["paths"])
    cited_sources = set()
    for source in parsed.meta.get("sources", []):
        resource = source.get("resource", "") if isinstance(source, dict) else ""
        locator = parse_resource(resource)
        if locator is None:
            if _catalog_resource(state, resource):
                cited_sources.update(
                    name
                    for name in roots
                    if any(item["name"] == name for item in state["catalogs"])
                )
            continue
        source_name, rel, _, _ = locator
        cited_sources.add(source_name)
        if source_name not in roots or not _path_in_scope(rel, roots[source_name]):
            issues.append(issue("error", "evidence-outside-scope", str(path), resource))
    if task["spec"].get("owner") == "workspace" and len(roots) > 1:
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
        target["name"]: target
        for target in state["targets"].values()
        if target["kind"] == "page"
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

    state = {
        "run_id": manifest.get("producer_run_id") or manifest.get("run_id"),
        "revisions": revisions,
        "catalogs": catalogs,
    }
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
