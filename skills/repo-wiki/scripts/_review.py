"""Review subject binding and the reviewer's `_review.json` report.

Each review round is done by a fresh reviewer (cross-context review); the report
holds only the current round. Approval is bound to the exact draft bytes and the
source HEADs through `subject_digest`, so a page edited after approval needs a
new round before it can be stamped as verified.
"""

import hashlib
import json
import re

import _config
import _page

REVIEW_FILE = "_review.json"
VERDICTS = ("approved", "changes_requested")
KINDS = ("unsupported", "invented-why", "parrot", "filler", "missing", "terminology", "routing", "other")
ACTOR = re.compile(r"human:[^\s/]+|[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:+-]*")
_KEYS = {"subject_digest", "reviewer", "verdict", "issues"}
_ISSUE_KEYS = {"page", "kind", "claim", "fix", "locator"}


def drafts(pages: list[_page.Page]) -> list[_page.Page]:
    return [p for p in pages if p.status == "draft" and not p.is_generated and not p.error]


def subject(ws: _config.Workspace, pages: list[_page.Page]) -> dict:
    items = sorted((p.path, p.file_sha256()) for p in drafts(pages))
    # Draft bytes include each page's revision, which validation keeps equal to
    # the source content at HEAD; wiki-only commits therefore keep the digest.
    revision = _page.current_revision(ws)
    payload = {"pages": [list(item) for item in items]}
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "subject_digest": digest,
        "revision": revision,
        "pages": [{"path": path, "sha256": sha} for path, sha in items],
        "review_file": f"{ws.wiki_rel}/{REVIEW_FILE}",
    }


def load(ws: _config.Workspace) -> tuple[dict | None, list[str]]:
    """(report, problems); report is None when the file is absent or unreadable."""
    file = ws.wiki / REVIEW_FILE
    if not file.is_file():
        return None, []
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        return None, [f"{REVIEW_FILE} is not valid JSON: {exc}"]
    return data, problems(data)


def problems(data) -> list[str]:
    if not isinstance(data, dict):
        return [f"{REVIEW_FILE} must be a JSON object"]
    found = []
    unknown = sorted(set(data) - _KEYS)
    if unknown:
        found.append(f"unknown keys: {', '.join(unknown)}")
    missing = sorted(_KEYS - set(data))
    if missing:
        found.append(f"missing keys: {', '.join(missing)}")
    if not isinstance(data.get("subject_digest"), str):
        found.append("subject_digest must be the string from okf review prepare")
    reviewer = data.get("reviewer")
    if not isinstance(reviewer, str) or not ACTOR.fullmatch(reviewer):
        found.append("reviewer must be an actor such as repo-wiki-reviewer/<model> or human:<id>")
    verdict = data.get("verdict")
    if verdict not in VERDICTS:
        found.append(f"verdict must be one of {', '.join(VERDICTS)}")
    issues = data.get("issues")
    if not isinstance(issues, list):
        return found + ["issues must be a list"]
    for index, issue in enumerate(issues):
        where = f"issues[{index}]"
        if not isinstance(issue, dict):
            found.append(f"{where} must be an object")
            continue
        extra = sorted(set(issue) - _ISSUE_KEYS)
        if extra:
            found.append(f"{where} has unknown keys: {', '.join(extra)}")
        for key in ("page", "claim", "fix"):
            if not isinstance(issue.get(key), str) or not issue[key].strip():
                found.append(f"{where}.{key} must be a non-empty string")
        if issue.get("kind") not in KINDS:
            found.append(f"{where}.kind must be one of {', '.join(KINDS)}")
        if "locator" in issue:
            try:
                _config.parse_locator(issue["locator"])
            except _config.LocatorError as exc:
                found.append(f"{where}.locator: {exc}")
    if verdict == "approved" and issues:
        found.append("an approved review must have no issues; use changes_requested")
    if verdict == "changes_requested" and not issues:
        found.append("changes_requested needs at least one issue")
    return found


def state(ws: _config.Workspace, pages: list[_page.Page]) -> tuple[str, dict | None]:
    """("missing" | "invalid" | "stale" | "changes_requested" | "approved", report)."""
    data, found = load(ws)
    if data is None and not found:
        return "missing", None
    if found:
        return "invalid", data if isinstance(data, dict) else None
    if data["subject_digest"] != subject(ws, pages)["subject_digest"]:
        return "stale", data
    return data["verdict"], data


def open_changes(ws: _config.Workspace) -> int | None:
    """Issue count of a ``changes_requested`` report on disk, current or stale, else None."""
    data, _ = load(ws)
    if isinstance(data, dict) and data.get("verdict") == "changes_requested":
        issues = data.get("issues")
        return len(issues) if isinstance(issues, list) else 0
    return None
