"""Page model: discovery, frontmatter writing, templates, canon tables."""

import hashlib
import json
import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path, PurePosixPath

import yaml

import _config
import _files
import _frontmatter
import _git
import _markdown

AUTHOR_TYPES = ("Architecture", "Glossary", "Conventions", "Module", "Workflow")
GENERATED_TYPES = ("Schema", "Table")
CANON = {
    "Architecture": "architecture.md",
    "Glossary": "glossary.md",
    "Conventions": "conventions.md",
}
FRONTMATTER_ORDER = (
    "type", "title", "description", "tags", "scope", "status", "revision",
    "sources", "generated", "verified", "stamp", "catalogs",
)  # other keys follow, sorted
KERNEL_KEYS = ("sources", "generated", "verified", "stamp", "catalogs")
# Frontmatter keys outside the stamp hash: status (setting draft is the legitimate
# way to edit a stable page), sources (derived from and join-checked against the
# footnotes), verified (appended by okf verify; validate checks it against the
# hashed stamp.reviewed_by) and the stamp itself.
UNSTAMPED_KEYS = ("status", "sources", "verified", "stamp")
TEMPLATE_TODO = "<!-- okf:todo\n-->"
TEMPLATES = Path(__file__).resolve().parent.parent / "assets" / "templates"

_CANON_TEXT = {
    "en": {
        "Architecture": (
            "Architecture",
            ("Read first: how the system is split, which way dependencies point, "
             "cross-module changes and what has no page."),
        ),
        "Glossary": (
            "Glossary",
            ("Read when a project term, abbreviation or state name is unclear, or "
             "before naming something new."),
        ),
        "Conventions": (
            "Conventions",
            ("Read before changing code: commands, where new code goes, how to extend, "
             "and the rules for errors, config, tests and CI."),
        ),
    },
    "zh": {
        "Architecture": ("架构", "先读：系统怎么拆分、依赖方向、跨模块改动，以及哪些代码没有单独成页。"),
        "Glossary": (
            "术语表",
            "遇到不清楚的项目术语、缩写或状态名时，或在给新事物命名前阅读。",
        ),
        "Conventions": (
            "开发规范",
            "修改代码前阅读：常用命令、新代码放在哪里、如何扩展，以及错误处理、配置、测试和 CI 的规则。",
        ),
    },
}

TABLE_KINDS = {
    "glossary": (("term", "meaning", "avoid", "where"), ("术语", "定义", "勿用别名", "代码位置")),
    "commands": (("purpose", "command", "status"), ("用途", "命令", "状态")),
    "rules": (("area", "rule", "enforced by"), ("类别", "规则", "检查方式")),
    "invariants": (
        ("invariant", "enforced at", "breaks when"),
        ("关键约束", "由谁保证", "违反会怎样"),
    ),
    "change_guide": (
        ("change", "start at", "also change", "verify"),
        ("修改场景", "从这里改", "同步修改", "如何验证"),
    ),
    "not_covered": (("path", "reason"), ("路径", "原因")),
}
CITED_KINDS = ("glossary", "commands", "rules", "invariants", "change_guide")
COMMAND_STATUS = ("verified", "not-run", "failed")
# Extension knowledge is not a rule area: steps to add a new X are an extension
# recipe (Conventions, or the owning Module page). vcs: commit message, pull
# request and branch conventions.
RULE_AREAS = (
    "layout", "naming", "api", "errors", "logging", "config", "testing",
    "build-ci", "dependencies", "vcs",
)
# Headings every page of a type must keep from its template (en or zh, any level,
# case-insensitive). Every other heading is the writer's choice.
REQUIRED_SECTIONS = {
    "Architecture": (("Structure", "整体结构"), ("Not covered", "未单独成页")),
    "Conventions": (("Commands", "常用命令"), ("Rules", "开发规则")),
    "Module": (("Responsibility", "模块职责"), ("How it works", "工作原理"), ("Making changes", "修改指南")),
    "Workflow": (("Flow", "执行流程"), ("Making changes", "修改指南")),
}
# Page types that must carry at least one change guide row: the pages an agent
# opens right before editing their scope.
CHANGE_GUIDE_TYPES = ("Module", "Workflow")
ENFORCED_BY = ("lint", "typecheck", "test", "ci", "review", "convention")
FOOTNOTE_LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

_TODO_OPEN = "<!-- okf:todo"
_LEADING_TODO = re.compile(r"<!--\s*okf:todo")  # same recognition as _markdown


class PageError(ValueError):
    """User-facing; the message names the fix."""


@dataclass
class Page:
    path: str  # posix path relative to ws.wiki, e.g. "modules/billing.md"
    file: Path
    meta: dict
    body: str  # text after the frontmatter and its one separating blank line
    structure: _markdown.Structure
    error: str | None = None
    body_offset: int = 0  # file line number = body line number + body_offset
    front: str = ""  # file text before the body (frontmatter and separator), LF newlines

    @property
    def type(self):
        return self.meta.get("type")

    @property
    def status(self):
        return self.meta.get("status")

    @property
    def scope(self) -> list:
        value = self.meta.get("scope")
        return value if isinstance(value, list) else []

    @property
    def revision(self) -> dict:
        value = self.meta.get("revision")
        return value if isinstance(value, dict) else {}

    @property
    def is_generated(self) -> bool:
        return self.type in GENERATED_TYPES

    @property
    def todos(self) -> list[tuple[int, str]]:
        return self.structure.todos

    @property
    def is_untouched_stub(self) -> bool:
        if self.type not in AUTHOR_TYPES:
            return False
        body = self.body.strip()
        return any(body == template(lang, self.type).strip() for lang in _config.LANGS)

    def content_sha256(self, reviewed_by=...) -> str:
        """sha256 of the reviewed content: the body (LF newlines), every frontmatter
        key but UNSTAMPED_KEYS, and the approving reviewer (``stamp.reviewed_by``,
        None for an unreviewed stamp), as sorted compact JSON. ``reviewed_by``
        defaults to the value recorded in the page's stamp."""
        if reviewed_by is ...:
            stamp = self.meta.get("stamp")
            reviewed_by = stamp.get("reviewed_by") if isinstance(stamp, dict) else None
        meta = {k: v for k, v in self.meta.items() if k not in UNSTAMPED_KEYS}
        payload = {"body": _files.normalize_newlines(self.body), "meta": meta, "reviewed_by": reviewed_by}
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def file_sha256(self) -> str:
        """sha256 of the file bytes with CRLF and lone CR read as LF."""
        data = self.file.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        return hashlib.sha256(data).hexdigest()


@dataclass
class Row:
    cells: list[str]
    line: int
    footnotes: list[str] = field(default_factory=list)


@dataclass
class Table:
    kind: str
    header: list[str]
    rows: list[Row]
    line: int


# --- discovery and io ------------------------------------------------------------


def is_page_path(path: str) -> bool:
    name = PurePosixPath(path).name
    return name.endswith(".md") and name != "index.md" and not name.startswith("_")


def load_pages(ws: _config.Workspace) -> list[Page]:
    if not ws.wiki.is_dir():
        return []
    paths = sorted(
        file.relative_to(ws.wiki).as_posix()
        for file in ws.wiki.rglob("*.md")
        if file.is_file()
    )
    return [load_page(ws, path) for path in paths if is_page_path(path)]


def load_page(ws: _config.Workspace, path: str) -> Page:
    file = ws.wiki / path
    raw = file.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        text = raw.decode("utf-8", errors="replace")
        return _page(path, file, {}, text, f"File is not valid UTF-8: {exc}", 0)
    text = _files.normalize_newlines(text)  # a CRLF checkout reads like the commit
    parsed = _frontmatter.parse_page(text)
    if parsed.errors:
        return _page(path, file, {}, text, "; ".join(parsed.errors), 0)
    body = parsed.body
    # The single blank line after the closing '---' belongs to the frontmatter.
    body = body.removeprefix("\n")
    front = text[: len(text) - len(body)]
    return _page(path, file, parsed.meta, body, None, front.count("\n"), front)


def _page(path, file, meta, body, error, offset, front="") -> Page:
    return Page(
        path=path,
        file=file,
        meta=meta,
        body=body,
        structure=_markdown.extract(body),
        error=error,
        body_offset=offset,
        front=front,
    )


def ordered_meta(meta: dict) -> dict:
    head = {key: meta[key] for key in FRONTMATTER_ORDER if key in meta}
    rest = {key: meta[key] for key in sorted(k for k in meta if k not in head)}
    return head | rest


class _Dumper(yaml.SafeDumper):
    """Keeps every scalar on one line so no value line can read as a '---' fence."""


def _str(dumper: yaml.SafeDumper, value: str):
    style = '"' if "\n" in value or "\r" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_Dumper.add_representer(str, _str)


def render_page(meta: dict, body: str) -> str:
    raw = yaml.dump(
        ordered_meta(meta),
        Dumper=_Dumper,
        sort_keys=False,
        allow_unicode=True,
        width=10**9,
    )
    return f"---\n{raw}---\n\n{body}"


def write_page(page: Page) -> None:
    if page.error is not None:
        raise PageError(
            f"{page.path} has unparsable frontmatter ({page.error}); fix the file by hand"
        )
    page.meta = ordered_meta(page.meta)
    page.structure = _markdown.extract(page.body)  # the body may have been edited
    text = render_page(page.meta, page.body)
    _files.atomic_text(page.file, text)
    page.front = text[: len(text) - len(page.body)]
    page.body_offset = page.front.count("\n")


def current_revision(ws: _config.Workspace) -> dict[str, str]:
    return {source.name: _git.head(source.path) for source in ws.sources}


# --- templates and creation --------------------------------------------------------


@cache
def template(lang: str, type: str) -> str:
    return (TEMPLATES / lang / f"{type.lower()}.md").read_text(encoding="utf-8")


def _check_path(path: str) -> None:
    if not isinstance(path, str) or not path:
        raise PageError("page path is empty; pass a path such as modules/billing.md")
    if "\\" in path or path.startswith("/"):
        raise PageError(
            f"page path {path!r} must be a relative posix path under the wiki, "
            "such as modules/billing.md"
        )
    if any(part in ("", ".", "..") for part in path.split("/")):
        raise PageError(f"page path {path!r} must not contain empty, . or .. segments")
    name = path.rsplit("/", 1)[-1]
    if not name.endswith(".md") or name == ".md":
        raise PageError(f"page path {path!r} must end with .md")
    if name == "index.md":
        raise PageError("index.md is generated by okf stamp; choose another name")
    if name.startswith("_"):
        raise PageError(
            f"page file names must not start with _ ({path!r}); those are kernel files"
        )


def default_title(path: str, lang: str) -> str:
    stem = PurePosixPath(path).stem
    if lang == "zh":
        return stem
    words = [word for word in re.split(r"[-_\s]+", stem) if word]
    return " ".join(word[:1].upper() + word[1:] for word in words) or stem


def new_page(
    ws: _config.Workspace,
    path: str,
    type: str,
    description: str,
    scope=(),
    title: str | None = None,
) -> Page:
    _check_path(path)
    if type not in AUTHOR_TYPES:
        raise PageError(
            f"unknown page type {type!r}; use one of {', '.join(AUTHOR_TYPES)}"
        )
    file = ws.wiki / path
    if file.exists():
        raise PageError(f"{path} already exists; edit it instead of creating it")
    scope = [scope] if isinstance(scope, str) else list(scope)
    if ws.hub:
        names = [source.name for source in ws.sources]
        for glob in scope:
            first = glob.split("/", 1)[0]
            if first not in names and not any(char in first for char in "*?["):
                raise PageError(
                    f"scope glob {glob!r} does not start with a source directory; in a "
                    f"hub prefix it with one of: {', '.join(names)}"
                )
    _check_scope_matches(ws, scope)
    meta = {
        "type": type,
        "title": title if title is not None else default_title(path, ws.lang),
        "description": description,
        "scope": scope,
        "status": "draft",
        "revision": current_revision(ws),
    }
    body = template(ws.lang, type)
    write_page(_page(path, file, meta, body, None, 0))
    return load_page(ws, path)


def _check_scope_matches(ws: _config.Workspace, scope: list) -> None:
    """Every scope glob must match a tracked source file at HEAD (the wiki excluded)."""
    if not scope:
        return
    files = sorted(
        source.prefix + path
        for source in ws.sources
        for path in _git.ls_files(source.path, _git.head(source.path))
        if not (source.prefix + path == ws.wiki_rel or (source.prefix + path).startswith(ws.wiki_rel + "/"))
    )
    empty = [glob for glob in scope if not isinstance(glob, str) or not _config.glob_filter(glob, files)]
    if empty:
        raise PageError(
            f"scope glob {empty[0]!r} matches no tracked file; fix the glob (a directory "
            "such as src/billing or src/billing/** covers everything below it; hub globs "
            "start with a source name), or commit the files first"
        )


def canon_text(lang: str, type: str) -> tuple[str, str]:
    """Localized default (title, description) of a canon page."""
    return _CANON_TEXT[lang][type]


def create_canon(ws: _config.Workspace) -> list[Page]:
    """Create the three canon stubs; files that already exist are left alone."""
    pages = []
    for type, path in CANON.items():
        if (ws.wiki / path).exists():
            pages.append(load_page(ws, path))
            continue
        title, description = canon_text(ws.lang, type)
        pages.append(new_page(ws, path, type, description, (), title))
    return pages


# --- drafts --------------------------------------------------------------------


def reason_text(reason: str) -> str:
    """A todo reason as written into the block: one line, no comment terminator."""
    return " ".join(str(reason).split()).replace("-->", "->")


def _reason_line(reason: str) -> str:
    return f"- {reason_text(reason)}\n"


def mark_draft(ws: _config.Workspace, page: Page, reasons: list[str]) -> None:
    if page.error is not None:
        raise PageError(
            f"{page.path} has unparsable frontmatter ({page.error}); fix the file by hand"
        )
    meta = dict(page.meta)
    for key in KERNEL_KEYS:
        meta.pop(key, None)
    meta["status"] = "draft"
    meta["revision"] = current_revision(ws)
    lines = "".join(_reason_line(reason) for reason in reasons)

    body = page.body
    rest = body.lstrip()
    lead = body[: len(body) - len(rest)]
    close = rest.find("-->") if _LEADING_TODO.match(rest) else -1
    if close >= 0:
        inner = rest[:close].rstrip(" \t")
        if not inner.endswith("\n"):
            inner += "\n"
        body = lead + inner + lines + rest[close:]
    else:
        body = f"{_TODO_OPEN}\n{lines}-->\n\n{rest}"

    page.meta = meta
    page.body = body
    page.structure = _markdown.extract(body)
    write_page(page)


# --- canon tables and sources --------------------------------------------------------


def table_kind(header: list[str]) -> str | None:
    cells = tuple(cell.strip().casefold() for cell in header)
    for kind, variants in TABLE_KINDS.items():
        if cells in variants:
            return kind
    return None


def tables(page: Page) -> dict[str, list[Table]]:
    refs: dict[int, list[str]] = {}
    for label, line in page.structure.footnote_refs:
        labels = refs.setdefault(line, [])
        if label not in labels:
            labels.append(label)
    found: dict[str, list[Table]] = {}
    for md in page.structure.tables:
        kind = table_kind(md.header)
        if kind is None:
            continue
        rows = [Row(list(r.cells), r.line, list(refs.get(r.line, []))) for r in md.rows]
        found.setdefault(kind, []).append(Table(kind, list(md.header), rows, md.line))
    return found


def sources_from_footnotes(page: Page) -> list[dict[str, str]]:
    """[{"id": label, "resource": locator}] in first-reference order.

    Skips references without a definition, labels outside FOOTNOTE_LABEL and
    definitions whose first token is not a valid locator; validation reports those.
    """
    defs = page.structure.footnote_defs
    seen: set[str] = set()
    sources = []
    for label, _ in page.structure.footnote_refs:
        if label in seen or label not in defs or not FOOTNOTE_LABEL.fullmatch(label):
            continue
        seen.add(label)
        text, _ = _config.definition_locator(defs[label][0])
        if not text:
            continue
        try:
            locator = _config.parse_locator(text)
        except _config.LocatorError:
            continue
        sources.append({"id": label, "resource": locator.text()})
    return sources
