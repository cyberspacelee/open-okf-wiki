"""Every validation rule of the knowledge layer; each issue carries a one-sentence fix."""

import re
import shlex
from dataclasses import asdict, dataclass
from functools import cached_property
from pathlib import PurePosixPath

import _config
import _diagram
import _files
import _git
import _page
import _review
import _scan
from _markdown import strip_code_spans

HEX40 = re.compile(r"[0-9a-f]{40}")
MAX_PAGE_BYTES = 40 * 1024
SEVERITY_ORDER = {"error": 0, "pending": 1, "warning": 2}

# Causal markers that make a sentence a "why" claim.
_CAUSAL = re.compile(
    r"\b(because|so that|in order to|to avoid|to prevent|the reason)\b|因为|为了|以便|以免|由于|原因是",
    re.IGNORECASE,
)
_NO_RATIONALE = re.compile(r"rationale not recorded|原因未记录|理由未记录|未记录理由", re.IGNORECASE)
_SECRETS = (
    re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{32,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b[\"']?\s*[:=]\s*[\"'][^\"'\s]{16,}[\"']"
    ),
    re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]{6,}@"),
)
_IDENT_CELL = re.compile(r"^`[^`]+`$|^[A-Za-z_][\w.:/()-]*$")
_FOOTNOTE_REF = re.compile(r"\[\^[^\]]+\]")


@dataclass(frozen=True)
class Issue:
    code: str
    severity: str  # "error" | "warning" | "pending"
    page: str | None
    line: int | None
    message: str
    fix: str

    def to_dict(self) -> dict:
        return asdict(self)


# --- shared repository facts ----------------------------------------------------


class Facts:
    """HEAD facts computed once per command and shared by validate, status, stamp and
    impact: the listing, modules, glob matches, revision checks and diffs are each
    computed at most once, so the cost grows with files + globs, not their product."""

    def __init__(self, ws: _config.Workspace):
        self.ws = ws
        self._matches: dict[str, list[str]] = {}
        self._current: dict[tuple[str, str], bool] = {}
        self._exists: dict[tuple[str, str], bool] = {}
        self._changes: dict[tuple[str, str], list[tuple[str, str, str | None]]] = {}

    @cached_property
    def head(self) -> dict[str, str]:
        return _page.current_revision(self.ws)

    @cached_property
    def listings(self) -> dict[str, list[str]]:
        """Source name -> tracked source-relative paths at HEAD."""
        return {s.name: _git.ls_files(s.path, self.head[s.name]) for s in self.ws.sources}

    @cached_property
    def files(self) -> list[str]:
        """Workspace-relative tracked files at HEAD, wiki excluded, sorted."""
        found: list[str] = []
        for source in self.ws.sources:
            for path in self.listings[source.name]:
                ws_path = source.prefix + path
                if ws_path == self.ws.wiki_rel or ws_path.startswith(self.ws.wiki_rel + "/"):
                    continue
                found.append(ws_path)
        return sorted(found)

    @cached_property
    def modules(self) -> list[_scan.Module]:
        return _scan.modules(self.ws, self.head, self.listings)

    @cached_property
    def owners(self) -> dict[str, str]:
        """File -> the deepest module containing it (files outside every module are absent)."""
        paths = {module.path for module in self.modules}
        found = {}
        for path in self.files:
            owner = _scan.owner(path, paths)
            if owner is not None:
                found[path] = owner
        return found

    @cached_property
    def triggers(self) -> list[_scan.Trigger]:
        """Every trigger at HEAD (framework routes, listeners, jobs, commands)."""
        return _scan.triggers(self.ws, self.head, self.listings)

    @cached_property
    def contracts(self) -> list[_scan.Contract]:
        """Contracts between the sources of a hub at HEAD (empty in a single repository)."""
        return _scan.contracts(self.ws, self.head, self.listings)

    def current(self, source: _config.Source, rev) -> bool:
        """True when ``rev`` has the same source content as HEAD, ignoring wiki-only commits."""
        head = self.head[source.name]
        if rev == head:
            return True
        if not isinstance(rev, str) or not HEX40.fullmatch(rev):
            return False
        key = (source.name, rev)
        if key not in self._current:
            if self.ws.hub or not self.rev_exists(source, rev):
                self._current[key] = False
            else:
                spec = [f":(exclude){self.ws.wiki_rel}"]
                self._current[key] = not _git.diff_name_status(source.path, rev, head, spec)
        return self._current[key]

    def rev_exists(self, source: _config.Source, rev) -> bool:
        if not isinstance(rev, str) or not HEX40.fullmatch(rev):
            return False
        key = (source.name, rev)
        if key not in self._exists:
            self._exists[key] = rev == self.head[source.name] or _git.rev_exists(source.path, rev)
        return self._exists[key]

    def changes(self, source: _config.Source, rev: str) -> list[tuple[str, str, str | None]]:
        """Whole-tree name-status diff (with renames) from ``rev`` to HEAD of ``source``.

        One diff per distinct revision serves every page bound to it, and running
        it unrestricted lets a cited file renamed out of a page's scope still be
        followed to its new path.
        """
        key = (source.name, rev)
        if key not in self._changes:
            changes = _git.diff_name_status(source.path, rev, self.head[source.name], [])
            if not self.ws.hub:  # the wiki is not source content
                changes = [c for c in changes if not all(_in_wiki(self.ws, p) for p in c[1:] if p)]
            self._changes[key] = changes
        return self._changes[key]

    def page_current(self, page: _page.Page) -> bool:
        return all(self.current(s, page.revision.get(s.name)) for s in self.ws.sources)

    def matches(self, glob: str) -> list[str]:
        if glob not in self._matches:
            self._matches[glob] = _config.glob_filter(glob, self.files)
        return self._matches[glob]


def _in_wiki(ws: _config.Workspace, path: str) -> bool:
    return path == ws.wiki_rel or path.startswith(ws.wiki_rel + "/")


def not_covered_rows(pages: list[_page.Page]) -> list[tuple[_page.Page, _page.Row, str, str]]:
    """(page, row, path, reason) for every Not covered row of the Architecture and
    Overview pages."""
    rows = []
    for page in pages:
        if page.type not in ("Architecture", "Overview") or page.error:
            continue
        for table in _page.tables(page).get("not_covered", []):
            for row in table.rows:
                cells = row.cells + ["", ""]
                path = _plain(cells[0]).rstrip("/")
                rows.append((page, row, path, _plain(cells[1])))
    return rows


def module_pages(facts: Facts, pages: list[_page.Page]) -> dict[str, list[_page.Page]]:
    """Module path -> author pages whose scope matches at least one file the module owns."""
    result: dict[str, list[_page.Page]] = {module.path: [] for module in facts.modules}
    owners = facts.owners
    for page in pages:
        if page.is_generated:
            continue
        hit = {owners[path] for glob in scope_globs(page) for path in facts.matches(glob) if path in owners}
        for module in hit:
            result[module].append(page)
    return result


def module_exclusions(facts: Facts, pages: list[_page.Page]) -> dict[str, str]:
    """Module path -> Not covered reason, when a row path equals or contains the module."""
    rows = not_covered_rows(pages)
    found: dict[str, str] = {}
    for module in facts.modules:
        for _, _, path, reason in rows:
            if path and reason and _config.glob_match(path, module.path):
                found[module.path] = reason
                break
    return found


def unclaimed_triggers(facts: Facts, pages: list[_page.Page]) -> list[tuple[str, list[str]]]:
    """(trigger file, its trigger kinds) for every trigger file that no Workflow or Flow
    page scope matches and no Not covered row (path or glob, with a reason) excludes."""
    kinds: dict[str, set[str]] = {}
    for trigger in facts.triggers:
        kinds.setdefault(trigger.path, set()).add(trigger.kind)
    if not kinds:
        return []
    claimed: set[str] = set()
    for page in pages:
        if page.type in ("Workflow", "Flow") and not page.error and not page.is_generated:
            for glob in scope_globs(page):
                claimed.update(facts.matches(glob))
    rows = [path for _, _, path, reason in not_covered_rows(pages) if path and reason]
    return [
        (path, sorted(found, key=_scan.TRIGGER_KINDS.index))
        for path, found in sorted(kinds.items())
        if path not in claimed and not any(_config.glob_match(row, path) for row in rows)
    ]


def claimed_contracts(ws, facts: Facts, page: _page.Page) -> list[_scan.Contract]:
    """Contracts the page's frontmatter ``contracts`` names (ids or globs)."""
    claims = [c for c in page.contracts if isinstance(c, str) and c.strip()]
    if not claims or page.error:
        return []
    return [c for c in facts.contracts if any(_page.contract_match(claim, c.id) for claim in claims)]


def unclaimed_contracts(ws, facts: Facts, pages: list[_page.Page]) -> list[_scan.Contract]:
    """Contracts (not external) that no page claims and no Not covered row excludes
    (a row path or glob matching one of the contract's site files)."""
    if not ws.hub or not facts.contracts:
        return []
    claimed: set[str] = set()
    for page in pages:
        if not page.is_generated:
            claimed.update(c.id for c in claimed_contracts(ws, facts, page))
    rows = [path for _, _, path, reason in not_covered_rows(pages) if path and reason]
    return [
        c for c in facts.contracts
        if not c.external and c.id not in claimed
        and not any(_config.glob_match(row, site.path) for row in rows for site in c.sites)
    ]


def cited_locators(page: _page.Page) -> list[tuple[str, _config.Locator, int]]:
    """(label, locator, body line) for every footnote definition with a valid locator."""
    found = []
    for label, (text, line) in page.structure.footnote_defs.items():
        locator, _ = _config.definition_locator(text)
        if not locator:
            continue
        try:
            found.append((label, _config.parse_locator(locator), line))
        except _config.LocatorError:
            continue
    return found


def scope_globs(page: _page.Page) -> list[str]:
    return [g for g in page.scope if isinstance(g, str) and g.strip()]


def _plain(cell: str) -> str:
    return _FOOTNOTE_REF.sub("", cell).replace("`", "").strip()


# --- entry point ---------------------------------------------------------------------


def validate(
    ws: _config.Workspace,
    pages: list[_page.Page] | None = None,
    *,
    only: list[str] | None = None,
    facts: Facts | None = None,
) -> list[Issue]:
    pages = _page.load_pages(ws) if pages is None else pages
    facts = facts or Facts(ws)
    issues: list[Issue] = []
    readers: dict[str, _git.BlobReader] = {}
    try:
        for source in ws.sources:
            readers[source.name] = _git.BlobReader(source.path)
        glossary = _aliases(pages)
        for page in pages:
            issues += _page_issues(ws, facts, page, readers, glossary)
    finally:
        for reader in readers.values():
            reader.close()
    issues += _canon_issues(ws, pages)
    issues += _db_binding_issues(ws, pages)
    issues += _coverage_issues(ws, facts, pages)
    issues += _contract_issues(ws, facts, pages)
    issues += _orphan_issues(ws, pages)
    issues += _derived_issues(ws, facts, pages)
    if only is not None:
        wanted = {PurePosixPath(p).as_posix().removeprefix(ws.wiki_rel + "/") for p in only}
        issues = [issue for issue in issues if issue.page in wanted]
    return sorted(
        issues,
        key=lambda i: (i.page or "", i.line or 0, SEVERITY_ORDER[i.severity], i.code, i.message),
    )


def _issue(page, line, code, message, fix, severity="error") -> Issue:
    path = page.path if isinstance(page, _page.Page) else page
    file_line = None
    if isinstance(page, _page.Page) and line is not None:
        file_line = line + page.body_offset
    elif line is not None:
        file_line = line
    return Issue(code, severity, path, file_line, message, fix)


# --- per page ----------------------------------------------------------------------------


def _page_issues(ws, facts, page, readers, glossary) -> list[Issue]:
    if page.error is not None:
        return [
            _issue(
                page.path, 1, "frontmatter", f"frontmatter cannot be parsed: {page.error}",
                "Fix the YAML frontmatter between the --- lines by hand.",
            )
        ]
    issues = _frontmatter_issues(ws, page)
    issues += _path_issues(ws, page)
    if page.is_generated:
        issues += _link_issues(ws, page)
        return issues
    issues += _revision_issues(ws, facts, page)
    issues += _footnote_issues(page)
    issues += _locator_issues(ws, facts, page, readers)
    issues += _table_issues(ws, page)
    issues += _section_issues(ws, page)
    issues += _scope_issues(facts, page)
    issues += _stamp_issues(page)
    issues += _link_issues(ws, page)
    issues += _secret_issues(page)
    issues += _mermaid_issues(page)
    issues += _todo_issues(page)
    issues += _hint_issues(page)
    issues += _change_guide_issues(ws, page)
    issues += _flow_issues(ws, page)
    issues += _alias_issues(page, glossary)
    issues += _why_issues(page)
    issues += _parrot_issues(page)
    return issues


def _frontmatter_issues(ws, page) -> list[Issue]:
    meta = page.meta
    issues = []

    def bad(message, fix):
        issues.append(_issue(page.path, 1, "frontmatter", message, fix))

    if page.type not in _page.AUTHOR_TYPES + _page.GENERATED_TYPES:
        bad(
            f"type is {page.type!r}",
            f"Set type to one of {', '.join(_page.AUTHOR_TYPES)}.",
        )
        return issues
    for key in ("title", "description"):
        if not isinstance(meta.get(key), str) or not meta[key].strip():
            bad(f"{key} is missing or empty", f"Add a non-empty {key} string.")
    tags = meta.get("tags")
    if tags is not None and not (
        isinstance(tags, list) and all(isinstance(t, str) and t for t in tags)
    ):
        bad("tags must be a list of strings", "Write tags as a YAML list of strings or remove it.")
    if meta.get("status") not in ("draft", "stable"):
        bad(f"status is {meta.get('status')!r}", "Set status: draft; okf stamp sets stable.")
    if page.is_generated:
        if page.type != "Map" and not isinstance(meta.get("catalog_sha256"), str):
            bad(
                "generated page lacks catalog_sha256",
                "Regenerate the page with okf db capture; never write Schema or Table pages by hand.",
            )
        return issues
    page_role = _page.role(ws, page)
    scope = meta.get("scope", [])
    if not isinstance(scope, list) or not all(isinstance(g, str) and g.strip() for g in scope):
        bad("scope must be a list of glob strings", "Write scope as a YAML list such as [src/billing/**].")
    elif not scope and page_role in _page.CHANGE_GUIDE_ROLES:
        bad(
            f"a {page.type} page needs a scope",
            "List the source globs this page answers for, such as src/billing/**.",
        )
    elif scope and page_role in _page.CANON_ROLES:
        bad(
            f"a {page.type} page has no scope; its place in the wiki says what it covers",
            "Remove scope (an empty list is fine); list modules in its Structure section instead.",
        )
    contracts = meta.get("contracts")
    if contracts is not None:
        if not isinstance(contracts, list) or not all(isinstance(c, str) and c.strip() for c in contracts):
            bad(
                "contracts must be a list of contract ids or globs",
                "Write contracts as a YAML list such as ['http POST /orders', 'topic order-*'].",
            )
        elif page_role not in _page.CONTRACT_ROLES or not ws.hub:
            bad(
                f"a {page.type} page cannot claim contracts",
                "Claim contracts on a Flow page or the hub's architecture.md; remove the key here.",
            )
    revision = meta.get("revision")
    names = sorted(s.name for s in ws.sources)
    if not isinstance(revision, dict) or sorted(map(str, revision)) != names or not all(
        isinstance(v, str) and HEX40.fullmatch(v) for v in revision.values()
    ):
        bad(
            f"revision must map {', '.join(names)} to a full commit hash",
            "Do not edit revision; restore it from git or recreate the page with okf new.",
        )
    return issues


def _revision_issues(ws, facts, page) -> list[Issue]:
    revision = page.revision
    if not revision or any(not isinstance(v, str) or not HEX40.fullmatch(v) for v in revision.values()):
        return []  # frontmatter reports it
    issues = []
    for source in ws.sources:
        rev = revision.get(source.name)
        if rev is None:
            continue
        if page.status == "draft" and not facts.current(source, rev):
            issues.append(
                _issue(
                    page.path, 1, "revision",
                    f"draft was written against {rev[:12]} but {source.name} HEAD is "
                    f"{facts.head[source.name][:12]}",
                    "Run okf update --json to record the source changes in the page's todo block.",
                )
            )
        elif page.status == "stable" and not facts.rev_exists(source, rev):
            issues.append(
                _issue(
                    page.path, 1, "revision",
                    f"revision {rev[:12]} does not exist in {source.name}",
                    "Run okf update --json to redraft the page against HEAD.",
                )
            )
    return issues


def _footnote_issues(page) -> list[Issue]:
    s = page.structure
    issues = []
    referenced = {label for label, _ in s.footnote_refs}
    reported: set[str] = set()
    for label, line in s.footnote_refs:
        if label not in s.footnote_defs and label not in reported:
            reported.add(label)
            issues.append(
                _issue(
                    page, line, "footnote-join", f"[^{label}] has no definition",
                    f"Add a line '[^{label}]: path#Lx-Ly' at the end of the page.",
                )
            )
    for label, (_, line) in s.footnote_defs.items():
        if not _page.FOOTNOTE_LABEL.fullmatch(label):
            issues.append(
                _issue(
                    page, line, "footnote-join", f"footnote label {label!r} is not a slug",
                    "Use a semantic slug of letters, digits, '.', '_' or '-', such as retry-cap.",
                )
            )
        if label not in referenced:
            issues.append(
                _issue(
                    page, line, "footnote-join", f"[^{label}] is defined but never referenced",
                    f"Reference [^{label}] after the claim it supports, or delete the definition.",
                )
            )
    for label, line in s.duplicate_defs:
        issues.append(
            _issue(
                page, line, "footnote-join", f"[^{label}] is defined twice",
                "Keep one definition per label.",
            )
        )
    if (page.status == "stable" and "sources" in page.meta
            and page.meta.get("sources") != _page.sources_from_footnotes(page)):
        issues.append(
            _issue(
                page.path, 1, "footnote-join",
                "frontmatter sources no longer match the footnotes",
                "Do not edit a stable page directly; run okf update --json or restore it from git.",
            )
        )
    return issues


def _locator_issues(ws, facts, page, readers) -> list[Issue]:
    issues = []
    revision = page.revision
    for label, (text, line) in page.structure.footnote_defs.items():
        token, _ = _config.definition_locator(text)
        if not token:
            issues.append(
                _issue(
                    page, line, "locator", f"[^{label}] has no locator",
                    "Start the definition with a locator such as src/app.py#L10-L20.",
                )
            )
            continue
        try:
            locator = _config.parse_locator(token)
            source, rel = _config.resolve(ws, locator.path)
        except _config.LocatorError as exc:
            issues.append(
                _issue(
                    page, line, "locator", f"[^{label}]: {exc}",
                    "Write a repository-relative path, optionally with #L<start>-L<end>.",
                )
            )
            continue
        if _config.is_forbidden(locator.path):
            issues.append(
                _issue(
                    page, line, "locator", f"[^{label}] cites a secret file {locator.path}",
                    "Never cite .env, key or certificate files; cite the code that reads the setting.",
                )
            )
            continue
        rev = revision.get(source.name)
        if not facts.rev_exists(source, rev):
            rev = facts.head[source.name]
        data = readers[source.name].read(rev, rel)
        if data is None:
            issues.append(
                _issue(
                    page, line, "locator",
                    f"[^{label}]: {locator.path} is not a tracked file at {rev[:12]}",
                    "Cite a file tracked by git at the page revision; check the path spelling "
                    "(write a path with spaces as <my app/x.py>#L1-L5).",
                )
            )
            continue
        if b"\0" in data[:8192]:
            issues.append(
                _issue(
                    page, line, "locator", f"[^{label}]: {locator.path} is a binary file",
                    "Cite a text file.",
                )
            )
            continue
        if locator.end is not None:
            count = len(_files.text_lines(data))
            if locator.end > count:
                issues.append(
                    _issue(
                        page, line, "locator",
                        f"[^{label}]: {locator.text()} is past the end of the file ({count} lines)",
                        f"Use a line range within 1-{count}.",
                    )
                )
    return issues


def _path_issues(ws, page) -> list[Issue]:
    problem = _page.path_problem(ws, page)
    if problem is None:
        return []
    return [
        _issue(
            page.path, 1, "page-path", problem,
            "Move the page to the path named (git mv), or fix its type or scope; okf new derives the path.",
        )
    ]


def _table_issues(ws, page) -> list[Issue]:
    issues = []
    for kind, tables in _page.tables(page).items():
        for table in tables:
            for row in table.rows:
                cells = row.cells
                if kind in _page.CITED_KINDS and not row.footnotes:
                    issues.append(
                        _issue(
                            page, row.line, "required-citation",
                            f"{kind.replace('_', ' ')} row has no citation: {' | '.join(cells)[:80]}",
                            "Add a footnote [^slug] in the row whose definition cites the source lines.",
                        )
                    )
                issues += _value_issues(page, kind, table, row)
                if kind in ("contracts", "hops"):
                    issues += _contract_value_issues(ws, page, kind, row)
    return issues


def _contract_value_issues(ws, page, kind, row) -> list[Issue]:
    """Contracts and call chain rows name sources of the hub; the cells an agent acts
    on are never empty."""
    cells = [_plain(c) for c in row.cells] + [""] * 5
    names = [source.name for source in ws.sources]
    issues = []

    def bad(message, fix):
        issues.append(_issue(page, row.line, "table-values", message, fix))

    if not ws.hub:
        bad(f"a {kind} table only belongs in a hub", "Describe cross-module changes in a change guide table instead.")
        return issues
    if kind == "contracts":
        if cells[1] not in names:
            bad(f"Provider {cells[1]!r} is not a source", f"Name the providing source: one of {', '.join(names)}.")
        consumers = [c.strip() for c in re.split(r"[,，、]", cells[2]) if c.strip()]
        wrong = [c for c in consumers if c not in names]
        if not consumers or wrong:
            bad(
                f"Consumers {cells[2]!r} are not sources",
                f"List the consuming sources, comma separated, from: {', '.join(names)}.",
            )
        for index, name in ((0, "Contract"), (3, "Change order"), (4, "Verify")):
            if not cells[index] or cells[index] in ("-", "—"):
                bad(
                    f"contracts row has no {name}: {cells[0][:60]!r}",
                    {"Contract": "Name the contract id, as okf links --json prints it.",
                     "Change order": "Say which side changes and ships first and what the other side relies on.",
                     "Verify": "Name the tests or checks on both sides."}[name],
                )
    else:
        if cells[1] not in names:
            bad(f"Source {cells[1]!r} is not a source", f"Name the hop's source: one of {', '.join(names)}.")
        if not cells[2] or cells[2] in ("-", "—"):
            bad(f"call chain row has no Entry: {cells[0][:60]!r}", "Name the route, listener or function the hop enters at.")
    return issues


def _value_issues(page, kind, table, row) -> list[Issue]:
    cells = [_plain(c) for c in row.cells] + [""] * len(table.header)
    checks = {
        "commands": (2, _page.COMMAND_STATUS, "Status"),
        "rules": (0, _page.RULE_AREAS, "Area"),
    }
    issues = []
    wanted = []
    if kind in checks:
        wanted.append(checks[kind])
    if kind == "rules":
        wanted.append((2, _page.ENFORCED_BY, "Enforced by"))
    for index, allowed, name in wanted:
        if cells[index] not in allowed:
            issues.append(
                _issue(
                    page, row.line, "table-values",
                    f"{name} {cells[index]!r} is not allowed",
                    f"Use one of: {', '.join(allowed)}.",
                )
            )
    if kind == "change_guide":
        for index, name in ((1, "Start at"), (3, "Verify")):
            if not cells[index] or cells[index] in ("-", "—"):
                issues.append(
                    _issue(
                        page, row.line, "table-values", f"change guide row has no {name}: {cells[0][:60]!r}",
                        ("Name the file or symbol to open first." if index == 1 else
                         "Name the test, command or manual check that shows the change works."),
                    )
                )
    if kind == "not_covered" and not cells[1]:
        issues.append(
            _issue(
                page, row.line, "not-covered", f"Not covered row {cells[0]!r} has no reason",
                "Say why an agent can skip this path, e.g. vendored or generated code.",
            )
        )
    return issues


def _section_issues(ws, page) -> list[Issue]:
    titles = {" ".join(s.title.split()).casefold() for s in page.structure.sections}
    issues = []
    for variants in _page.REQUIRED_SECTIONS.get(_page.role(ws, page), ()):
        if not any(v.casefold() in titles for v in variants):
            en, zh = variants
            issues.append(
                _issue(
                    page.path, None, "section", f"{page.type} page lacks the section {en!r} ({zh})",
                    f"Keep the template heading '## {en}' (zh '## {zh}') and write its content under it.",
                )
            )
    return issues


def _scope_issues(facts, page) -> list[Issue]:
    return [
        _issue(
            page.path, 1, "scope", f"scope glob {glob!r} matches no tracked file",
            "Fix the glob (hub paths start with the source name) or remove it.",
        )
        for glob in scope_globs(page)
        if not facts.matches(glob)
    ]


def stamped(page) -> bool:
    """A stable page whose body and stamped frontmatter still hash to its stamp and
    whose ``verified`` list is the one stamp and ``okf verify`` wrote."""
    return page.status == "stable" and _stamp_problem(page) is None


def _stamp_problem(page) -> str | None:
    stamp = page.meta.get("stamp")
    recorded = stamp.get("content_sha256") if isinstance(stamp, dict) else None
    if recorded != page.content_sha256():
        return (
            "the body or frontmatter (such as revision, scope or description) of this "
            "stable page changed after it was stamped"
        )
    return verified_problem(page)


def verified_problem(page) -> str | None:
    """Why ``verified`` is not what stamp and okf verify wrote, or None.

    Stamp writes one entry for the approving reviewer (``stamp.reviewed_by``, inside
    the stamp hash) or none for --unreviewed; okf verify appends only ``human:``
    entries, dated at or after the stamp."""
    reviewer = page.meta["stamp"].get("reviewed_by")
    verified = page.meta.get("verified", [])
    if verified is None:
        verified = []
    if not isinstance(verified, list) or not all(
        isinstance(e, dict) and set(e) == {"by", "at"} and isinstance(e["by"], str) and isinstance(e["at"], str)
        for e in verified
    ):
        return "verified must be a list of {by, at} entries written by okf stamp and okf verify"
    rest = verified
    if reviewer is not None:
        if not verified or verified[0]["by"] != reviewer:
            return f"verified does not start with the approving reviewer {reviewer} recorded in the stamp"
        rest = verified[1:]
    generated = page.meta.get("generated")
    stamped_at = generated.get("at") if isinstance(generated, dict) else None
    for entry in rest:
        by = entry["by"]
        if not by.startswith("human:") or not _review.ACTOR.fullmatch(by):
            return (
                f"verified entry {by!r} was not recorded by okf stamp (reviewer "
                f"{reviewer or 'none: stamped --unreviewed'}) or okf verify (human:<id> only)"
            )
        if isinstance(stamped_at, str) and entry["at"] < stamped_at:
            return f"verified entry {by} at {entry['at']} predates the stamp ({stamped_at})"
    return None


def _stamp_issues(page) -> list[Issue]:
    if page.status != "stable":
        return []
    problem = _stamp_problem(page)
    if problem is None:
        return []
    return [
        _issue(
            page.path, 1, "unreviewed-edit", problem,
            "Set status: draft (keep the edit) so it is reviewed and stamped again, or restore it from git; "
            "record a human review only with okf verify.",
        )
    ]


def _link_issues(ws, page) -> list[Issue]:
    issues = []
    base = PurePosixPath(page.path).parent
    for target, line in page.structure.links:
        target = target.strip("<>")
        path = target.split("#", 1)[0].split("?", 1)[0]
        if not path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
            continue
        if path.startswith("/"):
            rel = PurePosixPath(path.lstrip("/"))
        else:
            parts: list[str] = []
            for part in (base / path).parts:
                if part == "..":
                    if not parts:
                        parts = None
                        break
                    parts.pop()
                elif part != ".":
                    parts.append(part)
            if parts is None:
                continue  # leaves the wiki: a source link, not checked here
            rel = PurePosixPath(*parts) if parts else PurePosixPath(".")
        if not rel.as_posix().endswith(".md"):
            continue
        if ws.hub and rel.as_posix() == _page.MAP:
            continue  # written by okf stamp; linking it before the first stamp is fine
        if not (ws.wiki / rel).is_file():
            issues.append(
                _issue(
                    page, line, "link", f"link target {target} does not exist",
                    "Link an existing page with a bundle-absolute path such as /modules/billing.md.",
                )
            )
    return issues


def _secret_issues(page) -> list[Issue]:
    """Frontmatter (copied into index.md) and body lines; line numbers are file lines."""
    issues = []
    lines = _files.text_lines(page.front) + _files.text_lines(page.body)
    first_body = page.body_offset + 1
    for number, text in enumerate(lines, 1):
        if any(pattern.search(text) for pattern in _SECRETS):
            issues.append(
                _issue(
                    page.path, number, "secret",
                    "line looks like a credential" + (" (frontmatter)" if number < first_body else ""),
                    "Remove the value; describe where the setting is read instead.",
                )
            )
    return issues


def _mermaid_issues(page) -> list[Issue]:
    return [
        _issue(page, line, "mermaid", message, fix)
        for line, message, fix in _diagram.check(page.structure)
    ]


def _todo_issues(page) -> list[Issue]:
    return [
        _issue(
            page, line, "todo", "page still has a todo block",
            "Fold what you verified into the body, drop the rest, then delete the whole block.",
            severity="pending",
        )
        for line, _ in page.todos
    ]


def _hint_issues(page) -> list[Issue]:
    return [
        _issue(
            page, line, "hint", "page still has a template hint",
            "Answer the hint in the section it sits in, then delete the whole <!-- okf:hint --> comment.",
            severity="pending",
        )
        for line, _ in page.structure.hints
    ]


def _change_guide_issues(ws, page) -> list[Issue]:
    """A Module, Workflow or Flow page must tell an agent where to start a change and
    how to check it; skipped while a todo block says the page is still being written."""
    if _page.role(ws, page) not in _page.CHANGE_GUIDE_ROLES or page.todos:
        return []
    if any(t.rows for t in _page.tables(page).get("change_guide", [])):
        return []
    return [
        _issue(
            page.path, None, "change-guide", f"{page.type} page has no change guide row",
            ("Under Making changes (修改指南) add a Change | Start at | Also change | Verify row "
             "for a change this scope really gets (git log on the scope shows them)."),
        )
    ]


def _flow_issues(ws, page) -> list[Issue]:
    """A Flow page shows its call chain: at least one call chain row and a mermaid
    sequenceDiagram with the sources as participants; skipped while a todo block
    says the page is still being written."""
    if page.type != "Flow" or page.todos:
        return []
    issues = []
    if not any(t.rows for t in _page.tables(page).get("hops", [])):
        issues.append(
            _issue(
                page.path, None, "flow-hops", "Flow page has no call chain row",
                "Under Call chain (跨仓调用链) add a Step | Source | Entry | Contract | Next row per hop.",
            )
        )
    diagrams = [
        fence for fence in page.structure.fences
        if fence.language == "mermaid" and fence.content.lstrip().startswith("sequenceDiagram")
    ]
    if not diagrams:
        issues.append(
            _issue(
                page.path, None, "flow-hops", "Flow page has no mermaid sequenceDiagram",
                "Add a ```mermaid sequenceDiagram with the sources as participants, one arrow per cited hop.",
            )
        )
    return issues


def _aliases(pages) -> dict[str, tuple[str, re.Pattern]]:
    """Alias -> (canonical term, pattern) from every Glossary page."""
    found = {}
    for page in pages:
        if page.type != "Glossary" or page.error:
            continue
        for table in _page.tables(page).get("glossary", []):
            for row in table.rows:
                cells = row.cells + ["", "", "", ""]
                term = _plain(cells[0])
                for alias in _plain(cells[2]).replace("，", ",").replace("、", ",").split(","):
                    alias = alias.strip()
                    if not alias or alias in ("-", "—") or alias.casefold() == term.casefold():
                        continue
                    if alias.isascii():
                        pattern = re.compile(rf"(?<![\w-]){re.escape(alias)}(?![\w-])", re.IGNORECASE)
                    else:
                        pattern = re.compile(re.escape(alias))
                    found[alias] = (term, pattern)
    return found


def _alias_issues(page, glossary) -> list[Issue]:
    if page.type == "Glossary" or not glossary:
        return []
    issues = []
    lines = list(page.structure.prose)
    lines += [(s.start_line, s.title) for s in page.structure.sections]
    for table in page.structure.tables:
        for row in table.rows:
            lines.append((row.line, " ".join(row.cells)))
    for line, text in sorted(lines):
        text = strip_code_spans(text)
        for alias, (term, pattern) in glossary.items():
            if pattern.search(text):
                issues.append(
                    _issue(
                        page, line, "alias",
                        f"uses {alias!r}, which the glossary lists as an alias of {term!r}",
                        f"Write {term!r}, or put the alias in a code span when quoting code.",
                        severity="warning",
                    )
                )
    return issues


def _why_issues(page) -> list[Issue]:
    refs = {line for _, line in page.structure.footnote_refs}
    return [
        _issue(
            page, line, "uncited-why", "causal claim without a citation",
            "Cite the code, comment, commit or doc that records the reason, or write 'rationale not recorded'.",
            severity="warning",
        )
        for line, text in page.structure.prose
        if line not in refs and _CAUSAL.search(text) and not _NO_RATIONALE.search(text)
        and not text.lstrip().startswith("[^")
    ]


def _parrot_issues(page) -> list[Issue]:
    issues = []
    size = len(page.body.encode("utf-8"))
    if size > MAX_PAGE_BYTES:
        issues.append(
            _issue(
                page.path, 1, "parrot", f"page body is {size // 1024} KiB",
                "Cut what grep and two or three files answer; split only if two real topics remain.",
                severity="warning",
            )
        )
    known = {md.line for kind in _page.tables(page).values() for md in kind}
    for md in page.structure.tables:
        if md.line in known or not md.rows:
            continue
        cells = [c.strip() for row in md.rows for c in row.cells if c.strip()]
        cited = any(_FOOTNOTE_REF.search(c) for c in cells)
        if cells and not cited and sum(bool(_IDENT_CELL.match(c)) for c in cells) >= 0.8 * len(cells):
            issues.append(
                _issue(
                    page, md.line, "parrot", "table lists code identifiers without explanation",
                    "Replace the listing with what an agent cannot read off the code: roles, constraints, why.",
                    severity="warning",
                )
            )
    return issues


# --- cross page ----------------------------------------------------------------------------


def _db_binding_issues(ws, pages) -> list[Issue]:
    """In a hub, a page scoped to some sources that links a database page whose
    database is bound (repo-wiki.yaml ``repos``) to none of them: a table of the
    wrong database, or a binding the config is missing."""
    if not ws.hub:
        return []
    names = {source.name for source in ws.sources}
    by_path = {page.path: page for page in pages}
    issues = []
    for page in pages:
        if page.error or page.is_generated or not page.scope:
            continue
        firsts = {str(glob).split("/", 1)[0] for glob in page.scope}
        if not firsts <= names:
            continue  # a glob starting with a wildcard may reach every source
        base = PurePosixPath(page.path).parent
        for target, line in page.structure.links:
            path = target.strip("<>").split("#", 1)[0]
            if not path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
                continue
            rel = path.lstrip("/") if path.startswith("/") else (base / path).as_posix()
            other = by_path.get(PurePosixPath(rel).as_posix())
            db = other.meta.get("db") if other is not None and other.is_generated else None
            repos = db.get("repos") if isinstance(db, dict) else None
            if not isinstance(repos, list) or firsts & set(repos):
                continue
            issues.append(
                _issue(
                    page, line, "db-binding",
                    f"links {other.path} of database {db.get('name')}, which repo-wiki.yaml binds to "
                    f"{', '.join(repos)}, while this page covers {', '.join(sorted(firsts))}",
                    "Link the table of the database this code uses, or add the source to that "
                    "database's repos and re-run okf db capture.",
                    severity="warning",
                )
            )
    return issues


def _canon_issues(ws, pages) -> list[Issue]:
    by_path = {page.path: page for page in pages}
    issues = []
    for path, (page_role, source) in _page.canon(ws).items():
        type = _page.ROLE_TYPES[page_role]
        page = by_path.get(path)
        if page is None or page.error or page.type != type:
            command = f"okf new --type {type}" + (f" --source {shlex.quote(source)}" if source else "")
            issues.append(
                _issue(
                    path, None, "canon-missing", f"canon page {path} ({type}) is missing",
                    f"Create it with {command}.",
                )
            )
            continue
        found = _page.tables(page)
        for kind in _page.CANON_TABLES[page_role]:
            label = kind.replace("_", " ")
            if kind not in found:
                issues.append(
                    _issue(
                        path, None, "canon-table", f"{type} page has no {label} table",
                        "Keep the table header from the template (en or zh) exactly.",
                    )
                )
            elif kind not in ("not_covered", "contracts") and not any(t.rows for t in found[kind]) and not page.todos:
                issues.append(
                    _issue(
                        path, None, "canon-empty", f"{label} table has no rows",
                        f"Add grounded {label} rows, or confirm the repository truly has none.",
                        severity="warning",
                    )
                )
    return issues


def coverage_page(ws, path: str) -> str:
    """The page that answers for a module or trigger file: the source's overview in a
    hub, architecture.md in a single repository."""
    if ws.hub:
        return f"{_page.SOURCES_DIR}/{path.split('/', 1)[0]}/overview.md"
    return "architecture.md"


def _coverage_issues(ws, facts, pages) -> list[Issue]:
    issues = []
    covered = module_pages(facts, pages)
    excluded = module_exclusions(facts, pages)
    for module in facts.modules:
        if covered[module.path] or module.path in excluded:
            continue
        issues.append(
            _issue(
                coverage_page(ws, module.path), None, "coverage", f"module {module.path} is in no page scope",
                f"Add {module.path}/** to a page scope, or add a Not covered row with a reason.",
            )
        )
    for path, kinds in unclaimed_triggers(facts, pages):
        issues.append(
            _issue(
                coverage_page(ws, path), None, "trigger-coverage",
                f"trigger file {path} ({', '.join(kinds)}) is in no Workflow page scope",
                f"Trace the flow {path} starts into a Workflow page and add the file to its scope, "
                "or add a Not covered row (path or glob) saying why no workflow page is needed.",
            )
        )
    for page, row, path, _ in not_covered_rows(pages):
        if path and not facts.matches(path):
            issues.append(
                _issue(
                    page, row.line, "not-covered", f"Not covered path {path} matches no tracked file",
                    "Fix the path or delete the row.",
                )
            )
        elif path and page.type == "Overview" and ws.hub:
            source = _page.path_source(ws, page.path)
            if source and not (path == source or path.startswith(source + "/")):
                issues.append(
                    _issue(
                        page, row.line, "not-covered", f"Not covered path {path} is outside source {source}",
                        f"Start the path with {source}/, or move the row to the overview of its source.",
                    )
                )
    return issues


def _contract_issues(ws, facts, pages) -> list[Issue]:
    """Every contract is claimed (link-coverage); every claim names a contract; a page
    without a todo block backs each claim with a contracts or call chain row
    (contract-row); a row naming no contract is flagged (contract-unknown)."""
    if not ws.hub:
        return []
    issues = []
    ids = [c.id for c in facts.contracts]
    for contract in unclaimed_contracts(ws, facts, pages):
        sides = ", ".join(f"{s.source} {s.locator}" for s in contract.sites[:4])
        issues.append(
            _issue(
                "architecture.md", None, "link-coverage",
                f"contract {contract.id} ({sides}) is claimed by no page",
                "Claim it in the contracts frontmatter of a Flow page that traces it or of architecture.md "
                "(and describe it there), or add a Not covered row matching one of its site files.",
            )
        )
    for page in pages:
        if page.error or page.is_generated or not page.contracts:
            continue
        for claim in page.contracts:
            if isinstance(claim, str) and claim.strip() and not any(_page.contract_match(claim, i) for i in ids):
                issues.append(
                    _issue(
                        page.path, 1, "contract-claim", f"claimed contract {claim!r} matches no contract",
                        "Fix the id or glob (okf links --json lists the contracts), or remove the claim.",
                    )
                )
        kind = {"Flow": "hops", "Architecture": "contracts"}.get(page.type)
        if kind is None:
            continue
        cells = _contract_cells(page, kind)
        if not page.todos:
            for contract in claimed_contracts(ws, facts, page):
                if not any(_page.contract_match(cell, contract.id) for cell, _ in cells):
                    table = "call chain" if kind == "hops" else "Contracts"
                    issues.append(
                        _issue(
                            page.path, None, "contract-row",
                            f"claimed contract {contract.id} has no row in the {table} table",
                            f"Add a {table} row naming {contract.id} (cited), or drop it from contracts.",
                        )
                    )
    for page in pages:
        if page.error or page.is_generated:
            continue
        for kind in ("contracts", "hops"):
            for cell, line in _contract_cells(page, kind):
                if not any(_page.contract_match(cell, i) for i in ids):
                    issues.append(
                        _issue(
                            page, line, "contract-unknown", f"{cell!r} names no contract between sources",
                            "Use a contract id as okf links --json prints it ('http POST /orders', 'topic x').",
                            severity="warning",
                        )
                    )
    return issues


def _contract_cells(page, kind: str) -> list[tuple[str, int]]:
    """(contract id or glob, body line) named in the Contract cells of a contracts or
    call chain table; several ids in one cell are separated by ';'."""
    column = 0 if kind == "contracts" else 3
    found = []
    for table in _page.tables(page).get(kind, []):
        for row in table.rows:
            cells = row.cells + [""] * 5
            for part in re.split(r";|<br\s*/?>", _plain(cells[column])):
                part = part.strip()
                if part and part not in ("-", "—"):
                    found.append((part, row.line))
    return found


def _orphan_issues(ws, pages) -> list[Issue]:
    """A Module, Workflow or Flow page no other author page links to: only the index
    reaches it, so a reader following the pages never does."""
    linked: set[str] = set()
    for page in pages:
        if page.error or page.is_generated:
            continue
        base = PurePosixPath(page.path).parent
        for target, _ in page.structure.links:
            path = target.strip("<>").split("#", 1)[0]
            if not path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
                continue
            rel = path.lstrip("/") if path.startswith("/") else (base / path).as_posix()
            rel = PurePosixPath(rel).as_posix()
            if rel != page.path:
                linked.add(_normalize_rel(rel))
    return [
        _issue(
            page.path, None, "orphan", f"no other page links to {page.path}",
            ("Link it from the page that explains where it fits (the source's overview.md, the "
             "architecture page or a Flow page that crosses it)."),
            severity="warning",
        )
        for page in pages
        if not page.error and not page.is_generated and _page.role(ws, page) in _page.CHANGE_GUIDE_ROLES
        and page.path not in linked
    ]


def _normalize_rel(path: str) -> str:
    parts: list[str] = []
    for part in path.split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def _derived_issues(ws, facts, pages) -> list[Issue]:
    """index.md files, log.md and the System map equal their derivation once no page is
    a draft; a stale index.md left in a directory is reported too."""
    if any(p.status == "draft" for p in pages if not p.is_generated) or any(p.error for p in pages):
        return []
    import _stamp

    expected = _stamp.render_derived(ws, pages, facts)
    issues = []
    for path, text in expected.items():
        lines = text.count("\n")
        if PurePosixPath(path).name == "index.md" and lines > _stamp.INDEX_MAX_LINES:
            issues.append(
                _issue(
                    path, None, "index-size", f"{path} has {lines} lines (budget {_stamp.INDEX_MAX_LINES})",
                    "Merge pages that answer the same changes, or give modules that need no page a Not "
                    "covered row; an agent reads an index whole.",
                    severity="warning",
                )
            )
    stale = sorted(set(_stamp.derived_on_disk(ws)) - set(expected))
    for path in sorted(expected) + stale:
        file = ws.wiki / path
        actual = file.read_text(encoding="utf-8") if file.is_file() else None
        if actual == expected.get(path):
            continue
        name = PurePosixPath(path).name
        code = {"log.md": "log", _page.MAP: "map"}.get(name, "index")
        issues.append(
            _issue(
                path, None, code, f"{path} is missing or out of date" if path in expected else f"{path} is stale",
                "Run okf stamp --by <actor>; it rewrites the indexes, log.md and the System map when no page is a draft.",
            )
        )
    return issues


def counts(issues: list[Issue]) -> dict[str, int]:
    return {
        "errors": sum(i.severity == "error" for i in issues),
        "pending": sum(i.severity == "pending" for i in issues),
        "warnings": sum(i.severity == "warning" for i in issues),
    }
