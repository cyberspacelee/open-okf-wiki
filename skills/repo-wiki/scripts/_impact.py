"""Which pages went stale since their revision, and turning them back into drafts.

Staleness is `git diff <page revision>..HEAD -- scope ∪ cited files`, per source,
plus changed catalogs of linked generated database pages. No state beyond the
page frontmatter is read or written.
"""

import bisect
import re

import _config
import _files
import _git
import _page
import _validate
from _stamp import linked_generated


class ImpactError(Exception):
    """User-facing; the message names the fix."""


def _lines(data: bytes | None) -> list[str] | None:
    return None if data is None else _files.text_lines(data)


def _find_unique(block: list[str], lines: list[str]) -> int | None:
    """1-based start of the only exact occurrence of ``block`` in ``lines``."""
    if not block:
        return None
    first, size, found = block[0], len(block), None
    for index in range(len(lines) - size + 1):
        if lines[index] == first and lines[index : index + size] == block:
            if found is not None:
                return None
            found = index + 1
    return found


def _page_reasons(ws, facts, page, readers, by_path) -> list[dict]:
    reasons: list[dict] = []
    revision = page.revision
    cited = _validate.cited_locators(page)
    claimed = _validate.claimed_contracts(ws, facts, page)
    for source in ws.sources:
        rev = revision.get(source.name)
        head = facts.head[source.name]
        if not isinstance(rev, str) or facts.current(source, rev):
            continue
        if not facts.rev_exists(source, rev):
            reasons.append({"kind": "revision-missing", "source": source.name, "revision": rev})
            continue
        # Scope globs are workspace paths, matched exactly as validate and coverage
        # match them (Facts.matches), so hub globs such as */src/** work too.
        globs = _validate.scope_globs(page)
        own_cited = []
        for label, locator, _ in cited:
            try:
                owner, rel = _config.resolve(ws, locator.path)
            except _config.LocatorError:
                continue
            if owner.name == source.name:
                own_cited.append((label, locator, rel))
        own_sites = [
            (contract.id, site.path) for contract in claimed for site in contract.sites
            if site.source == source.name
        ]
        if not globs and not own_cited and not own_sites:
            continue
        changes = facts.changes(source, rev)
        renamed = {old: new for letter, old, new in changes if letter == "R"}
        changed = {old: letter for letter, old, _ in changes}
        reader = readers[source.name]
        since = rev[:12]  # the revision this change was diffed from
        for label, locator, rel in own_cited:
            if rel not in changed:
                continue
            reason = _cited_reason(source, label, locator, rel, changed[rel], renamed.get(rel), rev, head, reader)
            reasons.append(reason | {"since": since})
        cited_rels = {rel for _, _, rel in own_cited}
        for letter, old, new in changes:
            for path, kind in _scope_changes(letter, old, new):
                if path in cited_rels and kind != "scope-added":
                    continue
                ws_path = source.prefix + path
                if any(_config.glob_match(g, ws_path) for g in globs):
                    reasons.append({"kind": kind, "path": ws_path, "since": since})
        # A claimed contract changes when a site file of either side changes, even in a
        # source the page's scope does not reach.
        touched = {source.prefix + old for _, old, _ in changes} | {source.prefix + new for _, _, new in changes if new}
        for contract_id, path in own_sites:
            if path in touched:
                reasons.append({"kind": "contract-changed", "contract": contract_id, "path": path, "since": since})
    for other in linked_generated(page, by_path):
        recorded = (page.meta.get("catalogs") or {}).get(other.path)
        if page.status == "stable" and recorded is not None and recorded != other.meta.get("catalog_sha256"):
            reasons.append({"kind": "catalog-changed", "path": other.path})
    for target in (page.meta.get("catalogs") or {}):
        if target not in by_path:
            reasons.append({"kind": "catalog-deleted", "path": target})
    return _dedupe(reasons)


def _scope_changes(letter, old, new):
    if letter == "A":
        return [(old, "scope-added")]
    if letter == "D":
        return [(old, "scope-deleted")]
    if letter == "R":
        return [(old, "scope-deleted"), (new, "scope-added")]
    return [(old, "scope-modified")]


def _cited_reason(source, label, locator, rel, letter, new_rel, rev, head, reader) -> dict:
    base = {"label": label, "path": locator.path, "locator": locator.text()}
    if letter == "D":
        return base | {"kind": "cited-deleted"}
    target = new_rel or rel
    if locator.start is None:
        kind = "cited-moved" if new_rel else "cited-changed"
        out = base | {"kind": kind}
        if new_rel:
            out["suggested"] = _config.Locator(source.prefix + new_rel, None, None).text()
        return out
    old_lines = _lines(reader.read(rev, rel)) or []
    new_lines = _lines(reader.read(head, target))
    block = old_lines[locator.start - 1 : locator.end]
    if new_lines is None:
        return base | {"kind": "cited-deleted"}
    if new_rel is None and new_lines[locator.start - 1 : locator.end] == block and len(block) == locator.end - locator.start + 1:
        return base | {"kind": "cited-context"}
    start = _find_unique(block, new_lines) if len(block) == locator.end - locator.start + 1 else None
    if start is not None:
        suggested = _config.Locator(source.prefix + target, start, start + len(block) - 1).text()
        return base | {"kind": "cited-moved", "suggested": suggested}
    return base | {"kind": "cited-changed"}


def _dedupe(reasons: list[dict]) -> list[dict]:
    seen, out = set(), []
    for reason in reasons:
        key = tuple(sorted(reason.items()))
        if key not in seen:
            seen.add(key)
            out.append(reason)
    return out


def impact(
    ws: _config.Workspace,
    facts: _validate.Facts | None = None,
    pages: list[_page.Page] | None = None,
) -> dict:
    facts = facts or _validate.Facts(ws)
    pages = [p for p in (_page.load_pages(ws) if pages is None else pages) if not p.error]
    by_path = {p.path: p for p in pages}
    report_pages = []
    readers = {s.name: _git.BlobReader(s.path) for s in ws.sources}
    try:
        for page in pages:
            if page.is_generated:
                continue
            reasons = _page_reasons(ws, facts, page, readers, by_path)
            if reasons:
                report_pages.append(
                    {"page": page.path, "status": page.status, "revision": page.revision, "reasons": reasons}
                )
    finally:
        for reader in readers.values():
            reader.close()
    covered = _validate.module_pages(facts, pages)
    excluded = _validate.module_exclusions(facts, pages)
    return {
        "head": facts.head,
        "pages": report_pages,
        "unmapped_modules": [m.path for m in facts.modules if not covered[m.path] and m.path not in excluded],
        "unclaimed_triggers": [
            {"path": path, "kinds": kinds} for path, kinds in _validate.unclaimed_triggers(facts, pages)
        ],
        "missing_scope": [
            {"page": p.path, "glob": g}
            for p in pages
            if not p.is_generated
            for g in p.scope
            if isinstance(g, str) and not facts.matches(g)
        ],
        "deleted_not_covered": [
            {"page": page.path, "path": path}
            for page, _, path, _ in _validate.not_covered_rows(pages) if path and not facts.matches(path)
        ],
        "unclaimed_contracts": [
            {"id": c.id, "sources": c.sources} for c in _validate.unclaimed_contracts(ws, facts, pages)
        ],
    }


def impact_files(ws: _config.Workspace, paths: list[str]) -> dict:
    """What to read and update before changing each path (file or directory).

    ``read``: pages whose scope matches the path; ``update``: pages that cite it;
    ``change_guide``: change guide rows whose Change or Start at cell or cited
    locators mention it, with the Also change and Verify cells; ``canon``: the glossary and conventions pages to read before
    naming or changing code; ``note``: why no page answers for it, or how an
    unprefixed hub path was resolved.
    """
    pages = [p for p in _page.load_pages(ws) if not p.error and not p.is_generated]
    cited = {p.path: {loc.path for _, loc, _ in _validate.cited_locators(p)} for p in pages}
    facts = _validate.Facts(ws)
    rows = _change_guide_rows(pages)
    not_covered = [(path, reason) for _, _, path, reason in _validate.not_covered_rows(pages) if path]
    texts = _HeadTexts(ws, facts)
    contract_rows = {"contracts": _contract_rows(pages)} if ws.hub else {}

    def matches_below(glob: str, below: str) -> bool:
        # A tracked file under the directory matches the glob (src/*.py for src).
        matched = facts.matches(glob)
        index = bisect.bisect_left(matched, below)
        return index < len(matched) and matched[index].startswith(below)

    result: dict[str, dict] = {}
    try:
        for raw in paths:
            path = raw.replace("\\", "/").removeprefix("./").rstrip("/")
            notes = []
            ambiguous = False
            if ws.hub:
                path, note = _resolve_hub_path(ws, facts, path)
                if note:
                    notes.append(note)
                    ambiguous = note.startswith("ambiguous:")
            below = path + "/"
            read = [
                page.path for page in pages
                if any(
                    _config.glob_match(g, path)
                    or _config.glob_prefix(g).startswith(below)
                    or matches_below(g, below)
                    for g in _validate.scope_globs(page)
                )
            ]
            update = [
                page.path for page in pages
                if any(c == path or c.startswith(below) for c in cited[page.path])
            ]
            guide_rows = [
                {key: row[key] for key in ("page", "line", "change", "start", "also", "verify")}
                for row in rows
                if _row_mentions(row, path, texts)
            ]
            excluded = next(
                (reason for row_path, reason in not_covered if _config.glob_match(row_path, path)),
                None,
            )
            # An ambiguous path names no file yet: coverage notes would describe a
            # path that does not exist, so only the ambiguity is reported.
            if ambiguous:
                pass
            elif excluded is not None and not read:
                notes.append(f"not covered: {excluded or 'no reason given'}")
            elif not read and not update and not guide_rows:
                notes.append("no page covers this path")
            entry = {
                "read": read,
                "update": update,
                "change_guide": guide_rows,
                "canon": _canon_for(ws, path),
                "note": "; ".join(notes) or None,
            }
            if ws.hub:
                entry["contracts"] = _contracts_at(ws, facts, pages, path, contract_rows)
            result[path] = entry
    finally:
        texts.close()
    return {"files": result}


def _canon_for(ws, path: str) -> list[str]:
    """The canon pages to read before naming or changing code at ``path``: the glossary
    and conventions, plus the conventions and overview of the path's source in a hub."""
    wanted = ["glossary.md", "conventions.md"]
    source = path.split("/", 1)[0]
    if ws.hub and any(s.name == source for s in ws.sources):
        wanted += [f"{_page.SOURCES_DIR}/{source}/conventions.md", f"{_page.SOURCES_DIR}/{source}/overview.md"]
    return [p for p in wanted if (ws.wiki / p).is_file()]


def _contracts_at(ws, facts, pages, path: str, rows: dict) -> list[dict]:
    """The contracts ``path`` (a file, or a directory) is a site of: its role, the sites
    on the other side, the pages that claim the contract and its Contracts rows.
    ``rows`` carries the Contracts rows and caches each page's claims across paths."""
    below = path + "/"
    out = []
    if "claims" not in rows:  # page -> claimed ids, once per impact_files call
        rows["claims"] = {p.path: {c.id for c in _validate.claimed_contracts(ws, facts, p)} for p in pages}
    claims = rows["claims"]
    for contract in facts.contracts:
        mine = [s for s in contract.sites if s.path == path or s.path.startswith(below)]
        if not mine:
            continue
        roles = sorted({"provider" if s in contract.providers else "consumer" for s in mine})
        other = [s for s in contract.sites if s not in mine and s.source not in {m.source for m in mine}]
        out.append({
            "id": contract.id,
            "role": "/".join(roles),
            "counterparts": [f"{s.source} {s.locator}" for s in other],
            "pages": sorted(page for page, ids in claims.items() if contract.id in ids),
            "change_order": [row for key, row in rows["contracts"].items() if _page.contract_match(key[0], contract.id)],
            "external": contract.external,
        })
    return out


def _contract_rows(pages) -> dict[tuple[str, int], dict]:
    """(contract cell, line) -> the Contracts row of the system architecture page."""
    found = {}
    for page in pages:
        if page.type != "Architecture":
            continue
        for table in _page.tables(page).get("contracts", []):
            for row in table.rows:
                cells = [_validate._plain(c) for c in row.cells] + [""] * 5
                for part in re.split(r";|<br\s*/?>", cells[0]):
                    part = part.strip()
                    if part:
                        found[(part, row.line)] = {
                            "page": page.path, "line": row.line + page.body_offset, "contract": cells[0],
                            "provider": cells[1], "consumers": cells[2], "change_order": cells[3],
                            "verify": cells[4],
                        }
    return found


def _resolve_hub_path(ws, facts, path: str) -> tuple[str, str | None]:
    """An unprefixed hub path found in exactly one source gets that source's prefix."""
    first = path.split("/", 1)[0]
    if not path or any(first == s.name for s in ws.sources):
        return path, None
    hits = []
    for source in ws.sources:
        candidate = source.prefix + path
        index = bisect.bisect_left(facts.files, candidate)
        if index < len(facts.files) and (
            facts.files[index] == candidate or facts.files[index].startswith(candidate + "/")
        ):
            hits.append(source)
    if len(hits) == 1:
        resolved = hits[0].prefix + path
        return resolved, f"resolved {path} to {resolved} (only source {hits[0].name} has it)"
    if hits:
        names = ", ".join(s.name for s in hits)
        return path, f"ambiguous: sources {names} all have {path}; prefix it with the source name"
    return path, None


def _change_guide_rows(pages) -> list[dict]:
    """Every change guide row with its cells, the text to match and cited paths."""
    rows = []
    for page in pages:
        defs = page.structure.footnote_defs
        for table in _page.tables(page).get("change_guide", []):
            for row in table.rows:
                cells = row.cells + ["", "", "", ""]
                cited = []
                for label in row.footnotes:
                    token, _ = _config.definition_locator(defs.get(label, ("",))[0])
                    try:
                        cited.append(_config.parse_locator(token).path if token else None)
                    except _config.LocatorError:
                        continue
                rows.append({
                    "page": page.path,
                    "line": row.line + page.body_offset,
                    "change": _validate._plain(cells[0]),
                    "start": _validate._plain(cells[1]),
                    "also": _validate._plain(cells[2]),
                    "verify": _validate._plain(cells[3]),
                    "raw": " ".join(cells[:2]),  # Also change names a follow-up, not the change
                    "cited": [c for c in cited if c],
                })
    return rows


_CODE_SPAN = re.compile(r"`([^`]+)`")
_TOKEN = re.compile(r"[^\s`,;()]+")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _row_mentions(row: dict, path: str, texts: "_HeadTexts") -> bool:
    """The row's cited locators or its Change or Start at cell name the path, a
    directory or glob covering it, or (for a file) a code identifier that occurs in
    the file."""
    below = path + "/"
    if any(c == path or c.startswith(below) or path.startswith(c + "/") for c in row["cited"]):
        return True
    change = _FOOTNOTE.sub("", row["raw"])
    for token in _TOKEN.findall(change.replace("`", " ")):
        token = token.strip(".:").removeprefix("./").rstrip("/")
        if "/" in token or any(ch in token for ch in "*?["):
            if token == path or token.startswith(below) or _config.glob_match(token, path):
                return True
        elif "." in token and token == path.rsplit("/", 1)[-1]:
            return True  # a file name such as retry.py
    identifiers = {
        name for span in _CODE_SPAN.findall(change) if "/" not in span
        for name in _IDENTIFIER.findall(span) if len(name) >= 3
    }
    if identifiers:
        text = texts.text(path)
        if text is not None:
            return any(re.search(rf"(?<![\w]){re.escape(name)}(?![\w])", text) for name in identifiers)
    return False


_FOOTNOTE = re.compile(r"\[\^[^\]]+\]")


class _HeadTexts:
    """Text of tracked files at HEAD, read on demand (one reader per source)."""

    def __init__(self, ws, facts):
        self.ws, self.facts, self.readers, self.cache = ws, facts, {}, {}

    def text(self, path: str) -> str | None:
        if path in self.cache:
            return self.cache[path]
        text = None
        index = bisect.bisect_left(self.facts.files, path)
        if index < len(self.facts.files) and self.facts.files[index] == path:
            try:
                source, rel = _config.resolve(self.ws, path)
            except _config.LocatorError:
                source = None
            if source is not None:
                if source.name not in self.readers:
                    self.readers[source.name] = _git.BlobReader(source.path)
                data = self.readers[source.name].read(self.facts.head[source.name], rel)
                if data is not None and b"\0" not in data[:8192] and len(data) <= 1 << 20:
                    text = data.decode("utf-8", errors="replace")
        self.cache[path] = text
        return text

    def close(self) -> None:
        for reader in self.readers.values():
            reader.close()


def describe(reason: dict) -> str:
    """The todo line for a reason; a source change ends with ``(since <sha12>)``, the
    revision it was diffed from, so the next writer can run ``git diff <sha12>``."""
    kind = reason["kind"]
    since = f" (since {reason['since']})" if reason.get("since") else ""
    if kind.startswith("cited-"):
        text = f"{kind} [^{reason['label']}] {reason['locator']}"
        if reason.get("suggested"):
            text += f" -> suggested {reason['suggested']}"
        return text + since
    if kind == "revision-missing":
        return f"revision-missing {reason['source']} {reason['revision'][:12]}: recheck every claim"
    if kind == "contract-changed":
        return f"contract-changed {reason['contract']} {reason['path']}{since}"
    return f"{kind} {reason['path']}{since}"


def plan(ws: _config.Workspace, report: dict, pages: list[_page.Page]) -> tuple[dict[str, list[str]], list[dict]]:
    """What ``update`` would write: page path -> new todo lines for every page it would
    redraft, and the reasons it cannot place because their page is missing or unparsable.

    Status routes to ``update`` only when this plan (or a stale draft) is non-empty, so
    the two never disagree about whether update can act.
    """
    by_path = {p.path: p for p in pages if not p.error}
    extra: dict[str, list[str]] = {}
    for module in report["unmapped_modules"]:
        extra.setdefault(_validate.coverage_page(ws, module), []).append(
            f"unmapped-module {module}: add it to a page scope or a Not covered row"
        )
    for item in report["unclaimed_triggers"]:
        extra.setdefault(_validate.coverage_page(ws, item["path"]), []).append(
            f"unclaimed-trigger {item['path']} ({', '.join(item['kinds'])}): trace it into a Workflow "
            "page scope or add a Not covered row"
        )
    for item in report.get("unclaimed_contracts", []):
        extra.setdefault("architecture.md", []).append(
            f"unclaimed-contract {item['id']} ({', '.join(item['sources'])}): claim it on a Flow page or "
            "in contracts of architecture.md, or add a Not covered row"
        )
    for item in report["deleted_not_covered"]:
        extra.setdefault(item["page"], []).append(f"not-covered-deleted {item['path']}: remove the Not covered row")
    for item in report["missing_scope"]:
        extra.setdefault(item["page"], []).append(f"scope-empty {item['glob']}: fix or remove the glob")
    reasons_by_page = {item["page"]: [describe(r) for r in item["reasons"]] for item in report["pages"]}
    for path, lines in extra.items():
        reasons_by_page.setdefault(path, []).extend(lines)
    to_draft: dict[str, list[str]] = {}
    unplaced: list[dict] = []
    for path, lines in sorted(reasons_by_page.items()):
        page = by_path.get(path)
        if page is None:
            unplaced += [
                {"page": path, "reason": _page.reason_text(line),
                 "fix": f"create or repair {path} (okf status names the command), then run okf update again"}
                for line in dict.fromkeys(lines)
            ]
            continue
        # Whole reason lines, not substrings: "scope-modified src/a" is new even
        # when "scope-modified src/a.py" is already listed.
        existing = {
            _page.reason_text(line.strip().removeprefix("- "))
            for _, text in page.todos
            for line in text.split("\n")
            if line.strip()
        }
        lines = [line for line in dict.fromkeys(lines) if _page.reason_text(line) not in existing]
        if not lines and page.status == "draft":
            continue  # nothing new to record; update rebases it if needed
        to_draft[path] = lines
    return to_draft, unplaced


def update(ws: _config.Workspace) -> dict:
    for source in ws.sources:
        clean, dirty = _git.is_clean(source.path, [] if ws.hub else [ws.wiki_rel])
        if not clean:
            raise ImpactError(
                f"source {source.name} has uncommitted changes ({', '.join(dirty[:10])}); "
                "ask the user to commit or stash them first"
            )
    facts = _validate.Facts(ws)
    pages = _page.load_pages(ws)
    report = impact(ws, facts, pages)
    by_path = {p.path: p for p in pages if not p.error}
    to_draft, unplaced = plan(ws, report, pages)
    drafted = []
    for path, lines in to_draft.items():
        _page.mark_draft(ws, by_path[path], lines)
        drafted.append(path)
    rebased = []
    for page in by_path.values():
        if page.status == "draft" and not page.is_generated and page.path not in drafted and not facts.page_current(page):
            # HEAD moved without touching this draft's scope or citations.
            page.meta = dict(page.meta) | {"revision": dict(facts.head)}
            _page.write_page(page)
            rebased.append(page.path)
    return {"drafted": drafted, "rebased": rebased, "unplaced": unplaced, "impact": report}
