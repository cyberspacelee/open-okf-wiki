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

AUTHOR_TYPES = ("Architecture", "Glossary", "Conventions", "Overview", "Module", "Workflow", "Flow")
GENERATED_TYPES = ("Schema", "Table", "Map")
# Reserved at every level of the wiki: generated navigation and history (OKF §8, §9).
RESERVED_NAMES = ("index.md", "log.md")
MAP = "system-map.md"  # the generated contract map of a hub
SOURCES_DIR = "sources"
FLOWS_DIR = "flows"
# A page's role decides its path, template, required sections and canon tables. The
# type alone is not enough: the system Architecture of a hub carries the contracts,
# the system Conventions of a hub has no commands of its own.
ROLE_TYPES = {
    "glossary": "Glossary",
    "architecture": "Architecture",
    "system-architecture": "Architecture",
    "overview": "Overview",
    "conventions": "Conventions",
    "system-conventions": "Conventions",
    "module": "Module",
    "workflow": "Workflow",
    "flow": "Flow",
}
CANON_ROLES = ("glossary", "architecture", "system-architecture", "overview", "conventions", "system-conventions")
FRONTMATTER_ORDER = (
    "type", "title", "description", "tags", "scope", "contracts", "status", "revision",
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

# Localized default (title, description) of each canon role; {source} is the source name.
_CANON_TEXT = {
    "en": {
        "architecture": (
            "Architecture",
            ("Read first: how the system is split, which way dependencies point, "
             "cross-module changes and what has no page."),
        ),
        "system-architecture": (
            "Architecture",
            ("Read first: which repository owns what, the contracts between repositories, "
             "the order cross-repository changes ship in, and what has no page."),
        ),
        "overview": (
            "{source} overview",
            ("Read before changing {source}: how it is split, which way its dependencies point, "
             "cross-module changes and what has no page."),
        ),
        "glossary": (
            "Glossary",
            ("Read when a project term, abbreviation or state name is unclear, or "
             "before naming something new."),
        ),
        "conventions": (
            "Conventions",
            ("Read before changing code: commands, where new code goes, how to extend, "
             "and the rules for errors, config, tests and CI."),
        ),
        "source-conventions": (
            "{source} conventions",
            ("Read before changing code in {source}: commands, where new code goes, how to "
             "extend, and the rules for errors, config, tests and CI."),
        ),
        "system-conventions": (
            "Conventions",
            ("Read before a change that spans repositories: branch, release and contract "
             "rules, and the order cross-repository changes ship in."),
        ),
    },
    "zh": {
        "architecture": ("架构", "先读：系统怎么拆分、依赖方向、跨模块改动，以及哪些代码没有单独成页。"),
        "system-architecture": (
            "架构",
            "先读：每个仓库负责什么、仓库之间的契约、跨仓改动的上线顺序，以及哪些内容没有单独成页。",
        ),
        "overview": (
            "{source} 概览",
            "修改 {source} 前阅读：它怎么拆分、依赖方向、跨模块改动，以及哪些代码没有单独成页。",
        ),
        "glossary": (
            "术语表",
            "遇到不清楚的项目术语、缩写或状态名时，或在给新事物命名前阅读。",
        ),
        "conventions": (
            "开发规范",
            "修改代码前阅读：常用命令、新代码放在哪里、如何扩展，以及错误处理、配置、测试和 CI 的规则。",
        ),
        "source-conventions": (
            "{source} 开发规范",
            "修改 {source} 的代码前阅读：常用命令、新代码放在哪里、如何扩展，以及错误处理、配置、测试和 CI 的规则。",
        ),
        "system-conventions": (
            "开发规范",
            "做跨仓库的改动前阅读：分支、发布和契约规则，以及跨仓改动的上线顺序。",
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
    # Hub only: the system Architecture's contracts and a Flow page's call chain.
    "contracts": (
        ("contract", "provider", "consumers", "change order", "verify"),
        ("契约", "提供方", "消费方", "变更顺序", "如何验证"),
    ),
    "hops": (
        ("step", "source", "entry", "contract", "next"),
        ("步骤", "仓库", "入口", "契约", "下一步"),
    ),
}
CITED_KINDS = ("glossary", "commands", "rules", "invariants", "change_guide", "contracts", "hops")
COMMAND_STATUS = ("verified", "not-run", "failed")
# Extension knowledge is not a rule area: steps to add a new X are an extension
# recipe (Conventions, or the owning Module page). vcs: commit message, pull
# request and branch conventions.
RULE_AREAS = (
    "layout", "naming", "api", "errors", "logging", "config", "testing",
    "build-ci", "dependencies", "vcs",
)
# Headings every page of a role must keep from its template (en or zh, any level,
# case-insensitive). Every other heading is the writer's choice.
REQUIRED_SECTIONS = {
    "architecture": (("Structure", "整体结构"), ("Not covered", "未单独成页")),
    "system-architecture": (("Structure", "整体结构"), ("Contracts", "跨仓契约"), ("Not covered", "未单独成页")),
    "overview": (("Structure", "整体结构"), ("Not covered", "未单独成页")),
    "conventions": (("Commands", "常用命令"), ("Rules", "开发规则")),
    "system-conventions": (("Rules", "开发规则"),),
    "module": (("Responsibility", "模块职责"), ("How it works", "工作原理"), ("Making changes", "修改指南")),
    "workflow": (("Flow", "执行流程"), ("Making changes", "修改指南")),
    "flow": (("Call chain", "跨仓调用链"), ("Making changes", "修改指南")),
}
# Tables each canon role must hold (canon-table), and whose rows must not be empty
# (canon-empty) except Not covered.
CANON_TABLES = {
    "glossary": ("glossary",),
    "conventions": ("commands", "rules"),
    "system-conventions": ("rules",),
    "architecture": ("not_covered",),
    "system-architecture": ("contracts", "not_covered"),
    "overview": ("not_covered",),
}
# Roles that must carry at least one change guide row: the pages an agent opens
# right before editing their scope.
CHANGE_GUIDE_ROLES = ("module", "workflow", "flow")
# Roles that may claim contracts in their frontmatter.
CONTRACT_ROLES = ("system-architecture", "flow")
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
        return any(
            body == template(lang, role).strip()
            for lang in _config.LANGS
            for role, type in ROLE_TYPES.items()
            if type == self.type
        )

    @property
    def contracts(self) -> list:
        value = self.meta.get("contracts")
        return value if isinstance(value, list) else []

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
    return name.endswith(".md") and name not in RESERVED_NAMES and not name.startswith("_")


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


# --- roles, paths and creation -----------------------------------------------------


@cache
def template(lang: str, role: str) -> str:
    return (TEMPLATES / lang / f"{role}.md").read_text(encoding="utf-8")


def canon(ws: _config.Workspace) -> dict[str, tuple[str, str | None]]:
    """Canon page path -> (role, source name or None), in creation order.

    A single repository has the glossary, conventions and architecture; a hub has
    the system glossary, conventions and architecture plus, per source, its
    conventions and its overview."""
    if not ws.hub:
        return {
            "glossary.md": ("glossary", None),
            "conventions.md": ("conventions", None),
            "architecture.md": ("architecture", None),
        }
    found = {
        "glossary.md": ("glossary", None),
        "conventions.md": ("system-conventions", None),
        "architecture.md": ("system-architecture", None),
    }
    for source in ws.sources:
        found[f"{SOURCES_DIR}/{source.name}/conventions.md"] = ("conventions", source.name)
        found[f"{SOURCES_DIR}/{source.name}/overview.md"] = ("overview", source.name)
    return found


def path_source(ws: _config.Workspace, path: str) -> str | None:
    """The source a page path belongs to: ``sources/<s>/...`` in a hub, "." for every
    page of a single repository, None for a hub's system-level pages."""
    if not ws.hub:
        return "."
    parts = path.split("/")
    if len(parts) >= 3 and parts[0] == SOURCES_DIR and any(s.name == parts[1] for s in ws.sources):
        return parts[1]
    return None


def role(ws: _config.Workspace, page: "Page") -> str | None:
    """The page's role: its canon position, or its type for body pages. A canon type
    at a non-canon path gets the role it would have at the canon path of its level."""
    entry = canon(ws).get(page.path)
    if entry is not None and ROLE_TYPES[entry[0]] == page.type:
        return entry[0]
    return {
        "Glossary": "glossary",
        "Architecture": "system-architecture" if ws.hub else "architecture",
        "Conventions": "conventions" if path_source(ws, page.path) else "system-conventions",
        "Overview": "overview",
        "Module": "module",
        "Workflow": "workflow",
        "Flow": "flow",
    }.get(page.type)


def scope_sources(ws: _config.Workspace, scope) -> set[str] | None:
    """Sources a scope reaches: every glob's first segment in a hub ({"."} in a single
    repository); None when a hub glob starts with a wildcard (it may reach any source)."""
    if not ws.hub:
        return {"."}
    names = {source.name for source in ws.sources}
    found = set()
    for glob in scope:
        first = str(glob).split("/", 1)[0]
        if first not in names:
            return None
        found.add(first)
    return found


def _check_name(name) -> str:
    if not isinstance(name, str) or not name.strip():
        raise PageError("the page needs a name, such as billing (--name)")
    name = name.strip().removesuffix(".md")
    if not name or "/" in name or "\\" in name or name in (".", "..") or any(ch.isspace() for ch in name):
        raise PageError(
            f"page name {name!r} must be one path segment without spaces, such as billing or order-checkout"
        )
    if name.startswith("_") or f"{name}.md" in RESERVED_NAMES:
        raise PageError(f"page name {name!r} is reserved (index, log and names starting with _)")
    return name


def page_path(
    ws: _config.Workspace,
    type: str,
    name: str | None = None,
    source: str | None = None,
    scope=(),
) -> str:
    """The one wiki path a page of this type, name, source and scope may have.

    Module and Workflow pages live with the one source their scope reaches
    (``modules/`` in a single repository, ``sources/<s>/modules/`` in a hub); a
    Flow page spans sources (``flows/``, hub only). Raises PageError naming the fix."""
    names = [s.name for s in ws.sources]
    if source is not None and ws.hub and source not in names:
        raise PageError(f"source {source!r} is not configured; use one of: {', '.join(names)}")
    if type == "Glossary":
        return "glossary.md"
    if type == "Architecture":
        return "architecture.md"
    if type == "Conventions":
        if source is None or not ws.hub:
            return "conventions.md"
        return f"{SOURCES_DIR}/{source}/conventions.md"
    if type == "Overview":
        if not ws.hub:
            raise PageError(
                "an Overview page describes one source of a hub; a single repository uses architecture.md"
            )
        if source is None:
            raise PageError(f"an Overview page needs its source (--source, one of: {', '.join(names)})")
        return f"{SOURCES_DIR}/{source}/overview.md"
    if type not in ("Module", "Workflow", "Flow"):
        raise PageError(f"unknown page type {type!r}; use one of {', '.join(AUTHOR_TYPES)}")
    name = _check_name(name)
    folder = {"Module": "modules", "Workflow": "workflows"}.get(type)
    reached = scope_sources(ws, scope) if scope else set()
    if type == "Flow":
        if not ws.hub:
            raise PageError(
                "a Flow page spans sources of a hub; in a single repository write a Workflow page"
            )
        if reached is None or len(reached) < 2:
            raise PageError(
                "a Flow page's scope must span two or more sources, each glob starting with a "
                "source name; a flow inside one source is a Workflow page"
            )
        return f"{FLOWS_DIR}/{name}.md"
    if not ws.hub:
        return f"{folder}/{name}.md"
    if reached is None or len(reached) != 1:
        raise PageError(
            f"a {type} page's scope must stay inside one source, every glob starting with that "
            "source's name; a flow across sources is a Flow page"
        )
    (only,) = reached
    if source is not None and source != only:
        raise PageError(f"--source {source} does not match the scope, which lies in {only}")
    return f"{SOURCES_DIR}/{only}/{folder}/{name}.md"


def path_problem(ws: _config.Workspace, page: "Page") -> str | None:
    """Why the page does not sit at the path its type, name and scope derive, or None."""
    if page.type == "Map":
        return None if ws.hub and page.path == MAP else f"the System map is generated at {MAP} in a hub"
    if page.is_generated or page.type not in AUTHOR_TYPES:
        return None
    try:
        expected = page_path(
            ws, page.type, PurePosixPath(page.path).stem, path_source(ws, page.path)
            if page.type in ("Conventions", "Overview") and ws.hub else None, page.scope,
        )
    except PageError as exc:
        return str(exc)
    if expected != page.path:
        return f"a {page.type} page with this scope belongs at {expected}"
    return None


def default_title(path: str, lang: str) -> str:
    stem = PurePosixPath(path).stem
    if lang == "zh":
        return stem
    words = [word for word in re.split(r"[-_\s]+", stem) if word]
    return " ".join(word[:1].upper() + word[1:] for word in words) or stem


def new_page(
    ws: _config.Workspace,
    type: str,
    name: str | None = None,
    description: str | None = None,
    scope=(),
    title: str | None = None,
    source: str | None = None,
    contracts=(),
) -> Page:
    """Create a draft stub at the path ``page_path`` derives. Canon pages take their
    localized default title and description when none is given."""
    if type not in AUTHOR_TYPES:
        raise PageError(f"unknown page type {type!r}; use one of {', '.join(AUTHOR_TYPES)}")
    scope = [scope] if isinstance(scope, str) else list(scope)
    contracts = [contracts] if isinstance(contracts, str) else list(contracts)
    if ws.hub:
        names = [s.name for s in ws.sources]
        for glob in scope:
            first = glob.split("/", 1)[0]
            if first not in names and not any(char in first for char in "*?["):
                raise PageError(
                    f"scope glob {glob!r} does not start with a source directory; in a "
                    f"hub prefix it with one of: {', '.join(names)}"
                )
    path = page_path(ws, type, name, source, scope)
    file = ws.wiki / path
    if file.exists():
        raise PageError(f"{path} already exists; edit it instead of creating it")
    page_role = canon(ws).get(path, (None,))[0] or type.lower()
    if page_role in CANON_ROLES:
        if scope:
            raise PageError(f"a {type} page has no scope; its place in the wiki says what it covers")
        default_title_text, default_description = canon_text(ws.lang, page_role, path_source(ws, path))
        title = title if title is not None else default_title_text
        description = description if description is not None else default_description
    elif not isinstance(description, str) or not description.strip():
        raise PageError('the page needs a description saying when to read it: "Read before changing ..."')
    if contracts and page_role not in CONTRACT_ROLES:
        raise PageError("only Flow pages and the hub's architecture.md claim contracts")
    _check_scope_matches(ws, scope)
    if contracts:
        _check_contracts(ws, contracts)
    meta = {
        "type": type,
        "title": title if title is not None else default_title(path, ws.lang),
        "description": description,
        "scope": scope,
        "status": "draft",
        "revision": current_revision(ws),
    }
    if contracts:
        meta["contracts"] = contracts
    body = template(ws.lang, page_role)
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


def _check_contracts(ws: _config.Workspace, contracts: list) -> None:
    """Every claimed contract id or glob must match a contract scan derives at HEAD."""
    import _scan  # lazy: _scan does not depend on pages

    ids = [contract.id for contract in _scan.contracts(ws)]
    for claim in contracts:
        if not isinstance(claim, str) or not claim.strip() or not any(contract_match(claim, i) for i in ids):
            raise PageError(
                f"contract {claim!r} matches no contract between sources; okf links --json lists them "
                "(ids such as 'http POST /orders' or 'topic order-created', or globs such as 'http * /orders/*')"
            )


def contract_match(pattern: str, contract_id: str) -> bool:
    """A claimed contract (an id, or a glob over ids with * and ?) names this id.
    Whitespace is collapsed and HTTP path parameters normalized on both sides."""
    import fnmatch

    import _code

    return fnmatch.fnmatchcase(contract_id, _code.normalize_contract_id(pattern))


def canon_text(lang: str, role: str, source: str | None = None) -> tuple[str, str]:
    """Localized default (title, description) of a canon page."""
    key = "source-conventions" if role == "conventions" and source not in (None, ".") else role
    title, description = _CANON_TEXT[lang][key]
    name = source or ""
    return title.replace("{source}", name), description.replace("{source}", name)


def create_canon(ws: _config.Workspace) -> list[Page]:
    """Create every canon stub of the workspace; files that already exist are left alone."""
    pages = []
    for path, (page_role, source) in canon(ws).items():
        if (ws.wiki / path).exists():
            pages.append(load_page(ws, path))
            continue
        pages.append(new_page(ws, ROLE_TYPES[page_role], source=source))
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
