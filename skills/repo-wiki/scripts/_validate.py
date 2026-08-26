import pathlib
import re

from _frontmatter import parse_page, parse_file
from _markdown import extract


_CAUSAL = re.compile(
    r"\b(?:because|so that|in order to)\b|为了|以便|因此|由于", re.IGNORECASE
)
_FNREF_INLINE = re.compile(r"\[\^([^\]]+)\](?!:)")
_LINE_ANCHOR = re.compile(r"#L(\d+)(?:-L(\d+))?$")

_REQUIRED_FIELDS = ("type", "title", "description", "coverage", "sources")

_SURVEY_SECTIONS = {"Area", "Domains", "Leads", "Remaining", "Gaps"}
_SYNTHESIZE_SECTIONS = {"Topology", "Connections", "Unverified leads", "Remaining", "Gaps"}


def _issue(severity, code, path, line, message, suggestion=""):
    return {
        "severity": severity,
        "code": code,
        "path": str(path),
        "line": line,
        "message": message,
        "suggestion": suggestion,
    }


def validate_page(workspace, page_path: pathlib.Path) -> list[dict]:
    issues = []
    path_str = str(page_path)

    try:
        parsed = parse_file(page_path)
    except Exception as exc:
        return [_issue("error", "frontmatter-error", path_str, None, str(exc))]

    if parsed.errors:
        if "No frontmatter found" in parsed.errors[0]:
            issues.append(_issue("error", "frontmatter-missing", path_str, None,
                                 "No frontmatter block found"))
        else:
            for e in parsed.errors:
                issues.append(_issue("error", "frontmatter-error", path_str, None, e))
        return issues

    meta = parsed.meta
    body = parsed.body
    struct = extract(body)

    for field in _REQUIRED_FIELDS:
        if field not in meta:
            issues.append(_issue("error", "field-missing", path_str, None,
                                 f"Required field '{field}' missing from frontmatter"))

    coverage = meta.get("coverage", "")
    if coverage and coverage not in ("full", "partial"):
        issues.append(_issue("error", "coverage-invalid", path_str, None,
                             f"coverage must be 'full' or 'partial', got '{coverage}'"))

    sources_list = meta.get("sources", []) if isinstance(meta.get("sources"), list) else []
    source_ids = {s.get("id") for s in sources_list if isinstance(s, dict) and "id" in s}

    ref_ids = {ref_id for ref_id, _ in struct.footnote_refs}
    def_ids = set(struct.footnote_defs.keys())

    for ref_id, lineno in struct.footnote_refs:
        if ref_id not in def_ids:
            issues.append(_issue("error", "footnote-unmatched", path_str, lineno,
                                 f"Footnote ref [^{ref_id}] has no definition"))

    for src in sources_list:
        if not isinstance(src, dict):
            continue
        sid = src.get("id")
        if sid and sid not in ref_ids:
            issues.append(_issue("warning", "source-unused", path_str, None,
                                 f"Source '{sid}' is defined but never cited in body"))

    for src in sources_list:
        if not isinstance(src, dict):
            continue
        resource = src.get("resource", "")
        if not resource or resource.startswith("catalog:"):
            continue
        resolved = workspace.resolve_locator(resource)
        if resolved is None or not resolved.exists():
            issues.append(_issue("error", "locator-unresolved", path_str, None,
                                 f"Cannot resolve locator '{resource}'"))
            continue
        m = _LINE_ANCHOR.search(resource)
        if m:
            line_x = int(m.group(1))
            line_y = int(m.group(2)) if m.group(2) else line_x
            if line_x > line_y:
                issues.append(_issue("error", "line-range-invalid", path_str, None,
                                     f"Line range {line_x}-{line_y} is invalid (start > end)"))
                continue
            if resolved.exists():
                total = len(resolved.read_text(encoding="utf-8").splitlines())
                if line_x > total or line_y > total:
                    issues.append(_issue("error", "line-range-invalid", path_str, None,
                                         f"Line range L{line_x}-L{line_y} exceeds file length {total}"))

    for ph, lineno in struct.placeholders:
        issues.append(_issue("error", "placeholder-remaining", path_str, lineno,
                             f"Unreplaced placeholder: {ph}"))

    for idx, sec in enumerate(struct.sections):
        if sec.level != 2 or sec.content.strip():
            continue
        # An H2 that directly leads H3 subsections is structurally non-empty.
        nxt = struct.sections[idx + 1] if idx + 1 < len(struct.sections) else None
        if nxt is not None and nxt.level == 3:
            continue
        if coverage == "full":
            issues.append(_issue("error", "section-empty", path_str, sec.start_line,
                                 f"Section '## {sec.title}' is empty"))
        elif coverage == "partial":
            issues.append(_issue("warning", "section-empty", path_str, sec.start_line,
                                 f"Section '## {sec.title}' is empty"))

    if coverage == "partial":
        gaps_sections = [s for s in struct.sections if s.level == 2 and s.title == "Gaps"]
        if not gaps_sections or not gaps_sections[0].content.strip():
            issues.append(_issue("error", "gaps-missing", path_str, None,
                                 "coverage=partial requires a non-empty '## Gaps' section"))

    body_lines = body.splitlines()
    for lineno, raw in enumerate(body_lines, 1):
        if not _CAUSAL.search(raw):
            continue
        if _FNREF_INLINE.search(raw):
            continue
        issues.append(_issue("warning", "causal-unanchored", path_str, lineno,
                             "Causal claim without footnote citation"))

    return issues


def validate_target(workspace, phase: str, target: str) -> list[dict]:
    root = workspace.root

    if phase in ("inspect", "publish"):
        return []

    if phase == "review":
        report = root / ".okf-wiki" / "drafts" / "review" / f"{target}.md"
        if not report.exists():
            return [_issue("error", "missing-target", str(report), None,
                           f"Review report not found: {report}",
                           "Write the review report before completing the target")]
        text = report.read_text(encoding="utf-8")
        first_line = text.strip().splitlines()[0].strip().lower() if text.strip() else ""
        if first_line not in ("approved", "changes_requested"):
            return [_issue("error", "review-verdict-missing", str(report), 1,
                           "Review report must start with 'approved' or 'changes_requested'",
                           "Put the verdict alone on the first line")]
        return []

    if phase in ("survey", "synthesize"):
        draft_path = root / ".okf-wiki" / "drafts" / phase / f"{target}.md"
        if not draft_path.exists():
            return [_issue("error", "missing-target", str(draft_path), None,
                           f"Draft file not found: {draft_path}")]
        text = draft_path.read_text(encoding="utf-8")
        struct = extract(text)
        section_titles = {s.title for s in struct.sections if s.level == 2}
        required = _SURVEY_SECTIONS if phase == "survey" else _SYNTHESIZE_SECTIONS
        issues = []
        for title in required:
            if title not in section_titles:
                issues.append(_issue("error", "draft-section-missing", str(draft_path), None,
                                     f"Required section '## {title}' missing from {phase} draft"))
        for sec in struct.sections:
            if sec.level == 2 and sec.title == "Remaining":
                if sec.content.strip().lower() != "none":
                    issues.append(_issue("error", "draft-incomplete", str(draft_path), sec.start_line,
                                         "'## Remaining' must be 'none' to pass the complete gate"))
        return issues

    if phase == "write":
        candidate_path = root / ".okf-wiki" / "candidate" / target
        if not candidate_path.exists():
            return [_issue("error", "missing-target", str(candidate_path), None,
                           f"Candidate file not found: {candidate_path}")]
        return validate_page(workspace, candidate_path)

    if phase == "derive":
        proposals_dir = root / ".okf-wiki" / "proposals"
        pattern = list(proposals_dir.glob("agents-block*.md")) if proposals_dir.exists() else []
        issues = []
        if not pattern:
            return [_issue("error", "missing-target", str(proposals_dir), None,
                           "No agents-block*.md files found in proposals/")]
        begin_re = re.compile(r"<!--\s*okf-wiki:begin\b[^>]*-->")
        end_re = re.compile(r"<!--\s*okf-wiki:end\s*-->")
        for fpath in pattern:
            text = fpath.read_text(encoding="utf-8")
            lines = text.splitlines()
            stack = []
            for lineno, line in enumerate(lines, 1):
                if begin_re.search(line):
                    stack.append(lineno)
                elif end_re.search(line):
                    if not stack:
                        issues.append(_issue("error", "missing-target", str(fpath), lineno,
                                             "Unmatched okf-wiki:end marker"))
                    else:
                        begin_line = stack.pop()
                        content_lines = [l for l in lines[begin_line:lineno - 1] if l.strip()]
                        if len(content_lines) > 15:
                            issues.append(_issue("error", "missing-target", str(fpath), begin_line,
                                                 f"Block content exceeds 15 lines ({len(content_lines)})"))
            for leftover in stack:
                issues.append(_issue("error", "missing-target", str(fpath), leftover,
                                     "Unmatched okf-wiki:begin marker"))
        return issues

    candidate_path = root / ".okf-wiki" / "candidate" / target
    if not candidate_path.exists():
        return [_issue("error", "missing-target", str(candidate_path), None,
                       f"Unknown phase '{phase}', target file not found")]
    return []


def validate_candidate(workspace) -> list[dict]:
    root = workspace.root
    candidate_dir = root / ".okf-wiki" / "candidate"
    issues = []

    pages = list(candidate_dir.rglob("*.md")) if candidate_dir.exists() else []
    page_set = {p.resolve() for p in pages}

    for page in pages:
        issues.extend(validate_page(workspace, page))

    # cross-page: broken internal links
    for page in pages:
        struct = extract(page.read_text(encoding="utf-8"))
        for target, lineno in struct.links:
            link_target = target.split("#")[0]
            if not link_target:
                continue
            resolved = (page.parent / link_target).resolve()
            if resolved not in page_set:
                issues.append(_issue("error", "broken-link", str(page), lineno,
                                     f"Broken internal link: '{target}'"))

    # BFS reachability from index.md
    index = candidate_dir / "index.md"
    if index.exists() and index.resolve() in page_set:
        visited = {index.resolve()}
        queue = [index]
        while queue:
            current = queue.pop(0)
            struct = extract(current.read_text(encoding="utf-8"))
            for target, _ in struct.links:
                link_target = target.split("#")[0]
                if not link_target:
                    continue
                resolved = (current.parent / link_target).resolve()
                if resolved in page_set and resolved not in visited:
                    visited.add(resolved)
                    queue.append(resolved)
        for page in pages:
            if page.resolve() not in visited:
                issues.append(_issue("warning", "unreachable", str(page), None,
                                     f"Page not reachable from index.md"))

    return issues
