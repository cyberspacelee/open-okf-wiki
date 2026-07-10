import hashlib
import json
import re
import shutil
from datetime import date
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml

from .accepted_knowledge import AcceptedKnowledgeStore
from .verification import VerificationStore


TAXONOMY = (
    "architecture",
    "modules",
    "flows",
    "concepts",
    "requirements",
    "decisions",
    "guides",
    "references",
    "reports",
)
REQUIRED_BUNDLE_FILES = {
    "index.md",
    "log.md",
    "overview.md",
    *(f"{category}/index.md" for category in TAXONOMY),
    "reports/coverage.md",
    "reports/review.md",
}
LINK_RE = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
INDEX_ENTRY_RE = re.compile(r"^[*-] \[[^]]+\]\([^)]+\)(?: - .+)?$")
LOG_DATE_RE = re.compile(r"^## \d{4}-\d{2}-\d{2}$")
LOG_ENTRY_RE = re.compile(r"^[*-] .+$")
CLAIM_GROUNDING_RE = re.compile(r"<!-- claims: (claim:[0-9a-f]{64}) -->")


def report_metadata(coverage: dict) -> dict:
    major = coverage.get("by_priority", {}).get("major", {}).get("dispositions", {})
    return {
        "blocked_major_obligations": major.get("blocked", 0),
        "blocked_obligations": coverage["blocked"],
        "covered_major_obligations": major.get("covered", 0),
        "covered_obligations": coverage["covered"],
        "deferred_obligations": coverage["deferred"],
        "excluded_major_obligations": major.get("excluded", 0),
        "excluded_obligations": coverage["excluded"],
        "failed_major_obligations": major.get("failed", 0),
        "failed_obligations": coverage["failed"],
        "major_obligations": coverage["major"],
        "open_major_obligations": major.get("open", 0),
        "open_obligations": coverage["open"],
        "supporting_obligations": coverage["supporting"],
        "total_obligations": coverage["total"],
    }


def frontmatter(
    type_name: str,
    title: str,
    description: str,
    revision: str,
    **metadata: object,
) -> str:
    return (
        "---\n"
        + yaml.safe_dump(
            {
                "type": type_name,
                "title": title,
                "description": description,
                "source_revision": revision,
                **metadata,
            },
            allow_unicode=True,
            sort_keys=False,
        )
        + "---\n"
    )


def render_coverage_group(title: str, groups: dict) -> str:
    rows = [f"## {title}", "", "| Value | Total | Dispositions |", "| --- | ---: | --- |"]
    rows.extend(
        f"| `{value}` | {group['total']} | "
        + ", ".join(
            f"`{disposition}`: {count}" for disposition, count in group["dispositions"].items()
        )
        + " |"
        for value, group in groups.items()
    )
    return "\n".join(rows)


def published_run_id(destination: Path) -> str | None:
    if not destination.is_symlink():
        return None
    return destination.resolve().name


def file_manifest(root: Path, *, include_review: bool = True) -> dict[str, str]:
    if not root.is_dir():
        return {}
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
        and (include_review or path.relative_to(root).as_posix() != "reports/review.md")
    }


def bundle_diff(staging: Path, published: Path) -> dict[str, list[str]]:
    current = file_manifest(staging, include_review=False)
    previous = file_manifest(published, include_review=False)
    return {
        "added": sorted(current.keys() - previous.keys()),
        "changed": sorted(
            path for path in current.keys() & previous.keys() if current[path] != previous[path]
        ),
        "removed": sorted(previous.keys() - current.keys()),
    }


def knowledge_changes(database: Path, run_id: str, base_run_id: str | None) -> dict:
    store = AcceptedKnowledgeStore(database)
    current_claims = {item["id"]: item for item in store.list_claims(run_id)}
    current_concepts = {item["id"]: item for item in store.list_concepts(run_id)}
    previous_claims = (
        {item["id"]: item for item in store.list_claims(base_run_id)} if base_run_id else {}
    )
    previous_concepts = (
        {item["id"]: item for item in store.list_concepts(base_run_id)} if base_run_id else {}
    )

    def changes(current: dict, previous: dict, accepted_status: str, status_key: str) -> dict:
        return {
            "added": sorted(current.keys() - previous.keys()),
            "changed": sorted(
                item for item in current.keys() & previous.keys() if current[item] != previous[item]
            ),
            "excluded": sorted(
                item for item, record in current.items() if record[status_key] != accepted_status
            ),
            "removed": sorted(previous.keys() - current.keys()),
        }

    return {
        "claims": changes(current_claims, previous_claims, "supported", "epistemic_status"),
        "concepts": changes(current_concepts, previous_concepts, "active", "status"),
    }


def verification_findings(database: Path, run_id: str) -> list[dict]:
    return VerificationStore(database, initialize=False).list_run_findings(run_id)


def finding_blockers(findings: list[dict]) -> list[str]:
    blockers = [
        f"{item['candidate_id']}:{item['perspective']}:{item['verdict']}:{item['severity']}"
        for item in findings
        if item["blocking"]
    ]
    finding_candidates = {item["candidate_id"] for item in findings if item["blocking"]}
    blockers.extend(
        f"{item['candidate_id']}:acceptance_policy:{reason}"
        for item in findings
        if item["active_review"] and item["candidate_id"] not in finding_candidates
        for reason in item["decision_reasons"]
    )
    return list(dict.fromkeys(blockers))


def verification_blockers(database: Path, run_id: str) -> list[str]:
    return finding_blockers(verification_findings(database, run_id))


def authoritative_digest(database: Path, run_id: str, obligations: list[dict]) -> str:
    store = AcceptedKnowledgeStore(database)
    concepts = store.list_concepts(run_id)
    payload = {
        "claims": store.list_claims(run_id),
        "concepts": concepts,
        "relations": {
            concept["id"]: store.get_relations(run_id, concept["id"]) for concept in concepts
        },
        "obligations": obligations,
        "verification_findings": verification_findings(database, run_id),
    }
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()


def render_review_report(review: dict, coverage: dict) -> str:
    def bullets(values: list[str], empty: str) -> str:
        return "\n".join(f"* `{value}`" for value in values) if values else empty

    exclusions = review["exclusions"]
    findings = review["verification_findings"]
    review_triggers = list(
        dict.fromkeys(
            f"* `{item['candidate_id']}` / `acceptance_policy` — {reason}"
            for item in findings
            if item["active_review"]
            for reason in item["decision_reasons"]
        )
    )
    changes = review["knowledge_changes"]
    diff = review["bundle_diff"]
    return (
        "# Review Report\n\n"
        "## Coverage\n\n"
        f"* Total: {coverage['total']}\n"
        f"* Covered: {coverage['covered']}\n"
        f"* Excluded: {coverage['excluded']}\n"
        f"* Deferred: {coverage['deferred']}\n\n"
        "## Exclusions\n\n"
        + (
            "\n".join(
                f"* `{item['id']}` — `{item['disposition']}`: {item['reason']}"
                for item in exclusions
            )
            if exclusions
            else "No exclusions."
        )
        + "\n\n## Changed Claims\n\n"
        + "### Added\n\n"
        + bullets(changes["claims"]["added"], "None.")
        + "\n\n### Changed\n\n"
        + bullets(changes["claims"]["changed"], "None.")
        + "\n\n### Removed\n\n"
        + bullets(changes["claims"]["removed"], "None.")
        + "\n\n### Excluded from accepted facts\n\n"
        + bullets(changes["claims"]["excluded"], "None.")
        + "\n\n## Concept Changes\n\n"
        + "### Added\n\n"
        + bullets(changes["concepts"]["added"], "None.")
        + "\n\n### Changed\n\n"
        + bullets(changes["concepts"]["changed"], "None.")
        + "\n\n### Removed\n\n"
        + bullets(changes["concepts"]["removed"], "None.")
        + "\n\n### Excluded from accepted facts\n\n"
        + bullets(changes["concepts"]["excluded"], "None.")
        + "\n\n## Verification Findings\n\n"
        + (
            "\n".join(
                f"* `{item['candidate_id']}` / `{item['perspective']}` — "
                f"`{item['verdict']}` `{item['severity']}`: {item['rationale']}"
                for item in findings
            )
            if findings
            else "No Verification Findings."
        )
        + (
            "\n\n### Acceptance Policy Review Triggers\n\n" + "\n".join(review_triggers)
            if review_triggers
            else ""
        )
        + "\n\n## Bundle Diff\n\n"
        + "### Added\n\n"
        + bullets(diff["added"], "None.")
        + "\n\n### Changed\n\n"
        + bullets(diff["changed"], "None.")
        + "\n\n### Removed\n\n"
        + bullets(diff["removed"], "None.")
        + "\n"
    )


def render_bundle(
    staging: Path,
    project_id: str,
    revision: str,
    sources: list[dict],
    evidence: list[dict],
    obligations: list[dict],
    coverage: dict,
    commit_date: str,
    accepted_knowledge: list[dict] | None = None,
    database: Path | None = None,
    run_id: str | None = None,
    base_run_id: str | None = None,
    published: Path | None = None,
) -> dict:
    accepted_knowledge = accepted_knowledge or []
    if staging.exists():
        shutil.rmtree(staging)
    for category in TAXONOMY:
        (staging / category).mkdir(parents=True)
    taxonomy_links = "".join(
        f"* [{category.title()}]({category}/index.md) - {category.title()} knowledge.\n"
        for category in TAXONOMY
    )
    (staging / "index.md").write_text(
        f"# {project_id} Knowledge Bundle\n\n"
        "* [Overview](overview.md) - Fixed-revision source overview.\n" + taxonomy_links,
        encoding="utf-8",
    )
    (staging / "log.md").write_text(
        "# Bundle Update Log\n\n"
        f"## {commit_date}\n"
        f"* **Creation**: Staged the bundle for Source Set `{revision}`.\n",
        encoding="utf-8",
    )
    source_summary = "\n".join(
        f"* `{source['id']}` ({source['role']}) at revision `{source['revision']}` "
        f"with tree digest `{source['digest']}`."
        for source in sources
    )
    (staging / "overview.md").write_text(
        frontmatter(
            "Overview",
            f"{project_id} Overview",
            "Overview of the fixed source revision.",
            revision,
            id="overview",
        )
        + f"\n# Overview\n\nProducer Project `{project_id}` covers "
        f"{len(evidence)} tracked source file(s) from {len(sources)} source(s).\n\n"
        + source_summary
        + "\n",
        encoding="utf-8",
    )
    obligation_lines = []
    for item in obligations:
        span = item["span"]
        reason = f" — {item['reason']}" if item["reason"] else ""
        obligation_lines.append(
            f"* `{item['id']}` — `{item['source']}/{item['path']}` "
            f"lines {span['start_line']}-{span['end_line']}; `{item['kind']}`, "
            f"`{item['priority']}`, `{item['disposition']}`{reason}"
        )
    source_lines = [
        f"* `{source['id']}` ({source['role']}) at revision `{source['revision']}` "
        f"with tree digest `{source['digest']}`."
        for source in sources
    ]
    (staging / "reports" / "coverage.md").write_text(
        frontmatter(
            "Coverage Report",
            "Coverage Report",
            "Disposition of Coverage Obligations.",
            revision,
            id="reports/coverage",
            **report_metadata(coverage),
        )
        + "\n# Coverage Report\n\n"
        + "## Sources\n\n"
        + "\n".join(source_lines)
        + "\n\n"
        + render_coverage_group("By Source", coverage["by_source"])
        + "\n\n"
        + render_coverage_group("By Role", coverage["by_role"])
        + "\n\n"
        + render_coverage_group("By Priority", coverage["by_priority"])
        + "\n\n## Obligations\n\n"
        + ("\n".join(obligation_lines) if obligation_lines else "No Coverage Obligations.")
        + "\n",
        encoding="utf-8",
    )
    pages_by_category = {category: [] for category in TAXONOMY}
    if accepted_knowledge and database is not None and run_id is not None:
        store = AcceptedKnowledgeStore(database)
        for concept in accepted_knowledge:
            if concept["status"] != "active":
                continue
            claim_ids = [claim["id"] for claim in store.renderable_claims(run_id, concept["id"])]
            if not claim_ids:
                continue
            path = staging / concept["page"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                frontmatter(
                    "Concept",
                    concept["canonical_name"],
                    "Accepted source-grounded knowledge.",
                    revision,
                    id=concept["id"],
                    claim_ids=claim_ids,
                )
                + "\n"
                + store.derive_concept_page(run_id, concept["id"]),
                encoding="utf-8",
            )
            pages_by_category[path.relative_to(staging).parts[0]].append(
                (concept["canonical_name"], path.name)
            )
    pages_by_category["reports"] = [
        ("Coverage Report", "coverage.md"),
        ("Review Report", "review.md"),
    ]
    for category, pages in pages_by_category.items():
        entries = "".join(f"* [{title}]({path}) - {title}.\n" for title, path in sorted(pages))
        (staging / category / "index.md").write_text(
            f"# {category.title()}\n\n" + entries,
            encoding="utf-8",
        )
    changes = (
        knowledge_changes(database, run_id, base_run_id)
        if database is not None and run_id is not None
        else {
            "claims": {"added": [], "changed": [], "excluded": [], "removed": []},
            "concepts": {"added": [], "changed": [], "excluded": [], "removed": []},
        }
    )
    findings = (
        verification_findings(database, run_id)
        if database is not None and run_id is not None
        else []
    )
    review = {
        "blocking_findings": finding_blockers(findings),
        "bundle_diff": bundle_diff(staging, published or Path("/nonexistent")),
        "exclusions": [
            {
                "disposition": item["disposition"],
                "id": item["id"],
                "reason": item["reason"] or "No reason recorded.",
            }
            for item in obligations
            if item["disposition"] in {"deferred", "excluded"}
        ],
        "knowledge_changes": changes,
        "report": "reports/review.md",
        "state": "review_required",
        "verification_findings": findings,
    }
    (staging / "reports" / "review.md").write_text(
        frontmatter(
            "Review Report",
            "Review Report",
            "Authoritative knowledge changes awaiting review.",
            revision,
            id="reports/review",
        )
        + "\n"
        + render_review_report(review, coverage),
        encoding="utf-8",
    )
    return review


def parse_frontmatter(path: Path, text: str) -> tuple[dict | None, list[str]]:
    errors = []
    if not text.startswith("---\n"):
        return None, [f"{path}: missing YAML frontmatter"]
    end = text.find("\n---\n", 4)
    if end == -1:
        return None, [f"{path}: unterminated YAML frontmatter"]
    try:
        data = yaml.safe_load(text[4:end])
    except yaml.YAMLError as error:
        return None, [f"{path}: invalid YAML frontmatter: {error}"]
    if not isinstance(data, dict):
        errors.append(f"{path}: frontmatter must be a mapping")
        return None, errors
    elif not isinstance(data.get("type"), str) or not data["type"].strip():
        errors.append(f"{path}: frontmatter type must be non-empty")
    if not isinstance(data.get("id"), str) or not data["id"].strip():
        errors.append(f"{path}: frontmatter id must be non-empty")
    return data, errors


def validate_index(text: str) -> list[str]:
    lines = text.splitlines()
    if not lines:
        return ["index.md: must contain a section"]
    seen_section = False
    entries = 0
    for line in lines:
        if line == "":
            continue
        if line.startswith("# ") and line != "# ":
            seen_section = True
            entries = 0
        elif seen_section and INDEX_ENTRY_RE.fullmatch(line):
            entries += 1
        else:
            return ["index.md: only sections, blank lines, and Markdown link bullets are allowed"]
    return [] if seen_section else ["index.md: must contain a section"]


def validate_log(text: str) -> list[str]:
    lines = text.splitlines()
    if not lines or not lines[0].startswith("# ") or lines[0] == "# ":
        return ["log.md: must start with a non-empty title"]
    seen_date = False
    entries = 0
    for line in lines[1:]:
        if line == "":
            continue
        if LOG_DATE_RE.fullmatch(line):
            try:
                date.fromisoformat(line.removeprefix("## "))
            except ValueError:
                return ["log.md: date sections must use valid ISO dates"]
            if seen_date and not entries:
                return ["log.md: every ISO date section must contain a bullet"]
            seen_date = True
            entries = 0
        elif seen_date and LOG_ENTRY_RE.fullmatch(line):
            entries += 1
        else:
            return ["log.md: only a title, ISO date sections, and bullets are allowed"]
    return [] if seen_date and entries else ["log.md: must contain a dated bullet entry"]


def claim_paragraphs_are_grounded(text: str, claim_ids: list[str]) -> bool:
    body = text.split("\n---\n", 1)[-1].split("\n# Citations\n", 1)[0]
    blocks = [block.strip() for block in body.split("\n\n") if block.strip()]
    if blocks and blocks[0].startswith("# "):
        blocks = blocks[1:]
    if not blocks or len(blocks) % 2:
        return False
    grounded = []
    for paragraph, marker in zip(blocks[::2], blocks[1::2], strict=True):
        if paragraph.startswith("#"):
            return False
        match = CLAIM_GROUNDING_RE.fullmatch(marker)
        if match is None:
            return False
        grounded.append(match.group(1))
    return sorted(grounded) == sorted(claim_ids)


def validate_bundle(
    bundle: Path,
    expected_revision: str | None = None,
    expected_coverage: dict | None = None,
) -> list[str]:
    if not bundle.is_dir():
        return [f"Bundle does not exist: {bundle}"]
    errors = []
    documents = {}
    document_ids: dict[str, str] = {}
    present = {path.relative_to(bundle).as_posix() for path in bundle.rglob("*.md")}
    for missing in sorted(REQUIRED_BUNDLE_FILES - present):
        errors.append(f"Missing required Bundle file: {missing}")
    for relative in sorted(present):
        path = bundle / relative
        top_level = relative.split("/", 1)[0]
        if "/" in relative and top_level not in TAXONOMY:
            errors.append(f"{relative}: path is outside the fixed Producer Profile taxonomy")
        elif "/" not in relative and relative not in {"index.md", "log.md", "overview.md"}:
            errors.append(f"{relative}: path is outside the fixed Producer Profile taxonomy")
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            errors.append(f"{relative}: cannot read UTF-8 Markdown: {error}")
            continue
        if path.name == "index.md":
            errors.extend(
                f"{relative}: {error.removeprefix('index.md: ')}" for error in validate_index(text)
            )
        elif path.name == "log.md":
            errors.extend(
                f"{relative}: {error.removeprefix('log.md: ')}" for error in validate_log(text)
            )
        else:
            data, frontmatter_errors = parse_frontmatter(Path(relative), text)
            errors.extend(frontmatter_errors)
            if data is not None:
                documents[relative] = data
                document_id = data.get("id")
                if isinstance(document_id, str) and document_id.strip():
                    if document_id in document_ids:
                        errors.append(
                            f"{relative}: duplicate frontmatter id also used by "
                            f"{document_ids[document_id]}"
                        )
                    else:
                        document_ids[document_id] = relative
                if data.get("type") == "Concept":
                    claim_ids = data.get("claim_ids")
                    if (
                        not isinstance(claim_ids, list)
                        or not claim_ids
                        or any(not isinstance(item, str) for item in claim_ids)
                    ):
                        errors.append(f"{relative}: Concept claim_ids must be a non-empty list")
                    elif not claim_paragraphs_are_grounded(text, claim_ids):
                        errors.append(
                            f"{relative}: factual paragraphs must map to frontmatter Claim IDs"
                        )
                if (
                    expected_revision is not None
                    and data.get("source_revision") != expected_revision
                ):
                    errors.append(
                        f"{relative}: source_revision does not match Production Run revision"
                    )
        for raw_target in LINK_RE.findall(text):
            target = unquote(urlsplit(raw_target.strip().split()[0]).path)
            if not target or urlsplit(raw_target).scheme or target.startswith("#"):
                continue
            resolved = (
                (bundle / target.lstrip("/")) if target.startswith("/") else path.parent / target
            )
            try:
                resolved.resolve().relative_to(bundle.resolve())
            except ValueError:
                errors.append(f"{relative}: link escapes Bundle: {raw_target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: broken internal link: {raw_target}")
    if expected_revision is None:
        overview_revision = documents.get("overview.md", {}).get("source_revision")
        coverage_revision = documents.get("reports/coverage.md", {}).get("source_revision")
        if not isinstance(overview_revision, str) or overview_revision != coverage_revision:
            errors.append("overview.md and reports/coverage.md source_revision must match")
    coverage = documents.get("reports/coverage.md", {})
    metadata_fields = (
        "blocked_major_obligations",
        "blocked_obligations",
        "covered_major_obligations",
        "covered_obligations",
        "deferred_obligations",
        "excluded_major_obligations",
        "excluded_obligations",
        "failed_major_obligations",
        "failed_obligations",
        "major_obligations",
        "open_major_obligations",
        "open_obligations",
        "supporting_obligations",
        "total_obligations",
    )
    for field in metadata_fields:
        value = coverage.get(field)
        if type(value) is not int or value < 0:
            errors.append(f"reports/coverage.md: {field} must be a non-negative integer")
    if all(type(coverage.get(field)) is int for field in metadata_fields):
        if coverage["total_obligations"] != (
            coverage["major_obligations"] + coverage["supporting_obligations"]
        ):
            errors.append("reports/coverage.md: priority totals must equal total_obligations")
        if coverage["total_obligations"] != sum(
            coverage[f"{disposition}_obligations"]
            for disposition in ("blocked", "covered", "deferred", "excluded", "failed", "open")
        ):
            errors.append("reports/coverage.md: disposition totals must equal total_obligations")
    major_obligations = coverage.get("major_obligations")
    covered_major = coverage.get("covered_major_obligations")
    excluded_major = coverage.get("excluded_major_obligations")
    if (
        type(major_obligations) is int
        and type(covered_major) is int
        and type(excluded_major) is int
        and major_obligations != covered_major + excluded_major
    ):
        errors.append("reports/coverage.md: all Major Obligations must be covered or excluded")
    for field in (
        "blocked_major_obligations",
        "failed_major_obligations",
        "open_major_obligations",
    ):
        if coverage.get(field) != 0:
            errors.append(f"reports/coverage.md: {field} must be the integer 0")
    if expected_coverage is not None:
        expected_metadata = (
            report_metadata(expected_coverage)
            if "total" in expected_coverage
            else {
                "covered_obligations": expected_coverage.get("covered"),
                "major_obligations": expected_coverage.get("major"),
                "open_obligations": expected_coverage.get("open"),
            }
        )
        for report_field, expected in expected_metadata.items():
            if coverage.get(report_field) != expected:
                errors.append(f"reports/coverage.md: {report_field} does not match run coverage")
    return errors


def review_status(
    state: str,
    validation_errors: list[str],
    snapshot: dict | None = None,
    finding_blockers: list[str] | None = None,
) -> dict:
    review = dict(snapshot or {})
    active_findings = (
        review.get("blocking_findings", []) if finding_blockers is None else finding_blockers
    )
    review.update(
        blocking_findings=list(
            dict.fromkeys(
                [
                    *active_findings,
                    *validation_errors,
                ]
            )
        ),
        report="reports/review.md",
        state=state,
    )
    review.setdefault(
        "knowledge_changes",
        {
            "claims": {"added": [], "changed": [], "excluded": [], "removed": []},
            "concepts": {"added": [], "changed": [], "excluded": [], "removed": []},
        },
    )
    return review
