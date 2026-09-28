"""Stamp reviewed drafts, render the root index, record human verification and
render the AGENTS.md pointer block."""

import re
import shlex
from datetime import UTC, datetime
from pathlib import PurePosixPath

import _config
import _files
import _git
import _page
import _review
import _validate

INDEX = "index.md"
POINTER_BEGIN = "<!-- repo-wiki:begin -->"
POINTER_END = "<!-- repo-wiki:end -->"
POINTER_MAX_LINES = 15

_SECTIONS = {
    "en": (
        ("Architecture", "Architecture"), ("Glossary", "Glossary"),
        ("Conventions", "Conventions"), ("Workflow", "Workflows"), ("Module", "Modules"),
        ("Schema", "Database"), ("Table", "Tables"),
    ),
    "zh": (
        ("Architecture", "架构"), ("Glossary", "术语表"), ("Conventions", "开发规范"),
        ("Workflow", "流程"), ("Module", "模块"), ("Schema", "数据库"), ("Table", "数据表"),
    ),
}
_TEXT = {
    "en": {
        "source_map": "Source map",
        "not_covered": "Not covered",
        "unmapped": "no page yet",
        "pointer": [
            "## Repository knowledge layer",
            "Before changing code, open `{index}` and pick pages by description or by the",
            "Source map; check their claims in the cited source lines. Must read before",
            "naming or changing code: `{wiki}/glossary.md` and `{wiki}/conventions.md`.",
            "Before editing, run `okf impact --files <paths> --json` (okf: the repo-wiki",
            "skill's scripts/okf.py): pages to read and update, and change guide rows (where",
            "to start, what else to change, how to verify). After changing a page's `scope`",
            "files, update the page or mark it `status: draft` with a todo block. Invariant rows:",
            "`rg -nU '^\\|\\s*Invariant\\s*\\|.*\\n(\\|.*\\n)*' {wiki_arg}`",
        ],
        "hub": ("In this hub, paste this block into each source's AGENTS.md too (paths are "
                "relative to the hub root); okf never writes into sources."),
        "commands": "Verified commands:",
    },
    "zh": {
        "source_map": "源码映射",
        "not_covered": "未单独成页",
        "unmapped": "暂无页面",
        "pointer": [
            "## 仓库知识层",
            "修改代码前先打开 `{index}`：按 description 或源码映射选页面，",
            "再到引用的源码行核实。命名或修改代码前必读：",
            "`{wiki}/glossary.md` 和 `{wiki}/conventions.md`。",
            "编辑前运行 `okf impact --files <paths> --json`（okf 即 repo-wiki skill 的",
            "scripts/okf.py）：列出要读的页面、要更新的页面和修改指南行",
            "（从哪里改、还要改什么、如何验证）。修改页面 `scope` 覆盖的文件后，",
            "同步更新页面，或将其标为 `status: draft` 并在 todo 块中写明变化。关键约束：",
            "`rg -nU '^\\|\\s*关键约束\\s*\\|.*\\n(\\|.*\\n)*' {wiki_arg}`",
        ],
        "hub": "在 hub 中，把本块同样粘贴到每个源仓库的 AGENTS.md（路径相对 hub 根目录）；okf 从不写入源仓库。",
        "commands": "已验证的命令：",
    },
}


class StampError(Exception):
    """User-facing; the message names the fix."""


def now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --- index --------------------------------------------------------------------------


def render_index(ws: _config.Workspace, pages: list[_page.Page], facts: _validate.Facts) -> str:
    text = _TEXT[ws.lang]
    stable = [p for p in pages if p.status == "stable" and not p.error]
    out = ['---\nokf_version: "0.2"\n---\n']
    for type, heading in _SECTIONS[ws.lang]:
        group = sorted((p for p in stable if p.type == type), key=lambda p: (str(p.meta.get("title")), p.path))
        if not group:
            continue
        out.append(f"# {heading}\n")
        out += [f"* [{_one_line(p.meta.get('title'))}]({p.path}) - {_one_line(p.meta.get('description'))}" for p in group]
        out.append("")
    mapped = _validate.module_pages(facts, stable)
    excluded = _validate.module_exclusions(facts, pages)
    if facts.modules:
        out.append(f"# {text['source_map']}\n")
        for module in facts.modules:
            label = "`./`" if module.path == "." else f"`{module.path}/`"
            covering = mapped.get(module.path) or []
            if covering:
                links = ", ".join(f"[{_one_line(p.meta.get('title'))}]({p.path})" for p in covering)
                out.append(f"* {label} - {links}")
            elif module.path in excluded:
                out.append(f"* {label} - {text['not_covered']}: {_one_line(excluded[module.path])}")
            else:
                out.append(f"* {label} - {text['unmapped']}")
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"


def _one_line(value) -> str:
    return " ".join(str(value or "").split())


def write_index(ws, pages, facts) -> bool:
    text = render_index(ws, pages, facts)
    file = ws.wiki / INDEX
    if file.is_file() and file.read_text(encoding="utf-8") == text:
        return False
    _files.atomic_text(file, text)
    return True


# --- stamp ------------------------------------------------------------------------


def stamp(ws: _config.Workspace, by: str, unreviewed: bool = False) -> dict:
    if not _review.ACTOR.fullmatch(by or ""):
        raise StampError(f"--by {by!r} is not an actor; use repo-wiki/<model> or human:<id>")
    pages = _page.load_pages(ws)
    facts = _validate.Facts(ws)
    blocked: list[_validate.Issue] = []
    for source in ws.sources:
        clean, dirty = _git.is_clean(source.path, [] if ws.hub else [ws.wiki_rel])
        if not clean:
            blocked.append(
                _validate.Issue(
                    "dirty", "error", None, None,
                    f"source {source.name} has uncommitted changes: {', '.join(dirty[:10])}",
                    "Ask the user to commit or stash them; pages are stamped only against a commit.",
                )
            )
    issues = _validate.validate(ws, pages, facts=facts)
    blocked += [i for i in issues if i.severity in ("error", "pending") and i.code != "index"]
    drafts = _review.drafts(pages)
    report = None
    requested = _review.open_changes(ws)
    if drafts and unreviewed and requested is not None:
        blocked.append(
            _validate.Issue(
                "review", "error", _review.REVIEW_FILE, None,
                f"{_review.REVIEW_FILE} requests changes ({requested} issues); --unreviewed "
                "cannot skip a review that found problems",
                "Repair the issues and run a fresh review round (okf review prepare --json), or "
                f"delete {_review.REVIEW_FILE} after resolving the issues with the user.",
            )
        )
    if drafts and not unreviewed:
        review_state, report = _review.state(ws, pages)
        if review_state != "approved":
            blocked.append(
                _validate.Issue(
                    "review", "error", _review.REVIEW_FILE, None,
                    f"review is {review_state}",
                    "Run okf review prepare --json and have a fresh reviewer write an approved report "
                    "for the current digest, or stamp with --unreviewed.",
                )
            )
    if blocked:
        return {"stamped": [], "blocked": [i.to_dict() for i in blocked]}

    at = now()
    stamped = []
    by_path = {p.path: p for p in pages}
    for page in drafts:
        meta = dict(page.meta)
        meta["status"] = "stable"
        meta["revision"] = dict(facts.head)  # equal source content, see Facts.current
        meta["sources"] = _page.sources_from_footnotes(page)
        meta["generated"] = {"by": by, "at": at}
        if report is not None:
            meta["verified"] = [{"by": report["reviewer"], "at": at}]
        else:
            meta.pop("verified", None)
        catalogs = _linked_catalogs(page, by_path)
        if catalogs:
            meta["catalogs"] = catalogs
        else:
            meta.pop("catalogs", None)
        meta.pop("stamp", None)
        page.meta = meta
        # The approving reviewer is part of the hash, so a reviewer entry added to
        # verified by hand (or an --unreviewed stamp dressed up as reviewed) fails
        # validation as an unreviewed edit.
        reviewer = report["reviewer"] if report is not None else None
        page.meta["stamp"] = {"content_sha256": page.content_sha256(reviewer), "reviewed_by": reviewer}
        _page.write_page(page)
        stamped.append(page.path)
    pages = _page.load_pages(ws)
    index_changed = write_index(ws, pages, facts)
    review_file = ws.wiki / _review.REVIEW_FILE
    if review_file.exists():
        review_file.unlink()
    # Warnings never block a stamp; list them (with the stamped file lines) so they
    # stay visible after the pages turn stable.
    warnings = [i.to_dict() for i in _validate.validate(ws, pages, facts=facts) if i.severity == "warning"]
    return {
        "stamped": stamped,
        "verified_by": report["reviewer"] if report else None,
        "index": f"{ws.wiki_rel}/{INDEX}",
        "index_changed": index_changed,
        "warnings": warnings,
        "blocked": [],
    }


def linked_generated(page: _page.Page, by_path: dict[str, _page.Page]) -> list[_page.Page]:
    found = []
    base = PurePosixPath(page.path).parent
    for target, _ in page.structure.links:
        path = target.strip("<>").split("#", 1)[0]
        if not path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
            continue
        rel = path.lstrip("/") if path.startswith("/") else (base / path).as_posix()
        other = by_path.get(PurePosixPath(rel).as_posix())
        if other is not None and other.is_generated and other not in found:
            found.append(other)
    return found


def _linked_catalogs(page, by_path) -> dict[str, str]:
    return {
        other.path: other.meta["catalog_sha256"]
        for other in linked_generated(page, by_path)
        if isinstance(other.meta.get("catalog_sha256"), str)
    }


# --- human verification ------------------------------------------------------------


def verify(ws: _config.Workspace, actor: str, paths: list[str]) -> dict:
    if not actor.startswith("human:") or not _review.ACTOR.fullmatch(actor):
        raise StampError(f"--actor {actor!r} must be human:<id>")
    at = now()
    done, already = [], []
    for path in paths:
        rel = path.removeprefix(ws.wiki_rel + "/")
        if not (ws.wiki / rel).is_file():
            raise StampError(f"{path} is not a wiki page")
        page = _page.load_page(ws, rel)
        if not _validate.stamped(page):
            raise StampError(
                f"{rel} is not a stable page matching its stamp (never stamped, or edited "
                "since); stamp it before recording a human review"
            )
        verified = page.meta.get("verified") or []
        if isinstance(verified, dict):
            verified = [verified]
        # A stamp resets verified, so an entry by this actor covers the current
        # stamped content: a second verify is a no-op; a verify after a re-stamp records.
        if any(isinstance(e, dict) and e.get("by") == actor for e in verified):
            already.append(rel)
            continue
        page.meta = dict(page.meta) | {"verified": [*verified, {"by": actor, "at": at}]}
        _page.write_page(page)
        done.append(rel)
    result = {"verified": done, "by": actor, "at": at}
    if already:
        result["already_verified"] = already
    return result


# --- AGENTS.md pointer ----------------------------------------------------------------


def pointer(ws: _config.Workspace) -> str:
    text = _TEXT[ws.lang]
    wiki = ws.wiki_rel
    lines = [POINTER_BEGIN]
    # The rg line is a shell command: a wiki path with spaces is quoted there.
    wiki_arg = shlex.quote(wiki)
    lines += [
        line.replace("{index}", f"{wiki}/{INDEX}").replace("{wiki_arg}", wiki_arg).replace("{wiki}", wiki)
        for line in text["pointer"]
    ]
    if ws.hub:
        lines.append(text["hub"])
    commands = _verified_commands(ws)
    room = POINTER_MAX_LINES - len(lines) - 1  # the end marker takes one line
    if commands and room >= 2:
        lines.append(text["commands"])
        lines += [f"- {purpose}: `{command}`" for purpose, command in commands[: room - 1]]
    lines.append(POINTER_END)
    return "\n".join(lines) + "\n"


def _verified_commands(ws) -> list[tuple[str, str]]:
    path = _page.CANON["Conventions"]
    if not (ws.wiki / path).is_file():
        return []
    page = _page.load_page(ws, path)
    if not _validate.stamped(page):  # a hand edit after stamp must not reach AGENTS.md
        return []
    found = []
    for table in _page.tables(page).get("commands", []):
        for row in table.rows:
            cells = [_validate._plain(c) for c in row.cells] + ["", "", ""]
            if cells[2] == "verified" and cells[1]:
                found.append((cells[0], cells[1]))
    return found


def write_pointer(ws: _config.Workspace, target) -> dict:
    file = ws.root / target
    # Symlinks are written through (CLAUDE.md -> AGENTS.md), but never out of the workspace.
    resolved = file.resolve()
    if not resolved.is_relative_to(ws.root.resolve()):
        raise StampError(
            f"{target} resolves to {resolved}, outside the workspace {ws.root}; pass a "
            "file inside the workspace, such as AGENTS.md"
        )
    block = pointer(ws)
    text = file.read_text(encoding="utf-8") if file.is_file() else ""
    start, end = text.find(POINTER_BEGIN), text.find(POINTER_END)
    if start >= 0 and end > start:
        new = text[:start] + block.rstrip("\n") + text[end + len(POINTER_END):]
        action = "replaced"
    else:
        new = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block
        action = "appended"
    if new != text:
        _files.atomic_text(file, new)
    else:
        action = "unchanged"
    return {"file": str(target), "action": action}
