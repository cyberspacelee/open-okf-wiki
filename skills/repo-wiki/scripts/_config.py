"""Workspace config, locators, workspace path resolution and glob matching."""

import bisect
import fnmatch
import re
import shlex
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath

import yaml

import _files
import _frontmatter
import _git

CONFIG = "repo-wiki.yaml"
LANGS = ("en", "zh")
_KEYS = {"lang", "sources", "databases"}
_SOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_DB_KEYS = {"name", "url_env", "repos", "schemas"}
_SCHEMA_KEYS = {"name", "include", "exclude"}
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CATALOG_NAME = re.compile(r"[^\s/\\]+")  # a schema or table name, or a glob over them
_WILDCARD = re.compile(r"[*?[]")
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_LOCATOR = re.compile(r"(?P<path>[^#]*)(?:#L(?P<start>\d+)(?:-L(?P<end>\d+))?)?")
_BRACKETED = re.compile(r"<(?P<path>[^<>\n]+)>(?P<lines>#L\d+(?:-L\d+)?)?")
_FORBIDDEN = (
    ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
    "id_rsa*", "id_ed25519*", "*.kdbx",
)


@dataclass(frozen=True)
class Source:
    name: str  # "." for a single repository; directory name in a hub
    path: Path  # absolute repository root of this source
    prefix: str  # "" for single; "api/" in a hub


@dataclass(frozen=True)
class SchemaRule:
    """Which tables of which schemas a database capture takes: ``name`` is a schema
    name or a glob over schema names; a table is taken when it matches an
    ``include`` glob and no ``exclude`` glob (``t_order*`` starts with, ``*_log``
    ends with). Globs are case-sensitive, like unquoted catalog names."""

    name: str
    include: tuple[str, ...] = ("*",)
    exclude: tuple[str, ...] = ()

    def matches_schema(self, schema: str) -> bool:
        return fnmatch.fnmatchcase(schema, self.name)

    def includes(self, table: str) -> bool:
        return any(fnmatch.fnmatchcase(table, g) for g in self.include)

    def takes(self, table: str) -> bool:
        return self.includes(table) and not any(fnmatch.fnmatchcase(table, g) for g in self.exclude)


@dataclass(frozen=True)
class Database:
    """A database the wiki documents. ``repos`` are the sources whose code uses it
    (``(".",)`` in a single repository): a repository usually uses one database,
    and one database may serve several repositories."""

    name: str
    url_env: str  # the variable holding its opengauss:// URL; never the URL itself
    repos: tuple[str, ...]
    schemas: tuple[SchemaRule, ...]


@dataclass(frozen=True)
class Workspace:
    root: Path
    wiki: Path
    wiki_rel: str
    lang: str
    hub: bool
    sources: tuple[Source, ...]
    databases: tuple[Database, ...] = ()

    def database(self, name: str) -> Database:
        for db in self.databases:
            if db.name == name:
                return db
        known = ", ".join(db.name for db in self.databases) or "none configured"
        raise ConfigError(
            f"database {name!r} is not in {self.wiki_rel}/{CONFIG} ({known}); add it "
            "under databases or pass one of the configured names"
        )


class ConfigError(Exception):
    """User-facing; the message names the fix."""


class NotInitialized(ConfigError):
    """No wiki is configured here: status reports phase init."""


class LocatorError(ValueError):
    pass


# --- config ------------------------------------------------------------------


def load(root: Path, wiki: str | None = None) -> Workspace:
    root = _toplevel(root)
    wiki_rel = _find_wiki(root) if wiki is None else _wiki_rel(root, wiki)
    config = root / wiki_rel / CONFIG
    if not config.is_file():
        found = _git.ls_candidates(root, CONFIG)
        if found:
            dirs = [PurePosixPath(f).parent.as_posix() for f in found]
            raise ConfigError(
                f"{wiki_rel}/{CONFIG} not found, but a wiki is configured at "
                f"{', '.join(found)}; pass --wiki {shlex.quote(dirs[0])}"
                + (f" (or one of {', '.join(map(shlex.quote, dirs))})" if len(dirs) > 1 else "")
            )
        _refuse_hub_source(root)
        raise NotInitialized(
            f"{wiki_rel}/{CONFIG} not found; pass the directory that contains "
            f"{CONFIG} to --wiki, or run okf init"
        )
    lang, names, databases = _parse(config, f"{wiki_rel}/{CONFIG}")
    if names is None:
        sources = (Source(".", root, ""),)
    else:
        _check_sources(root, names, require_ignored=True)
        sources = tuple(Source(n, (root / n).resolve(), f"{n}/") for n in names)
        _check_wiki_outside(wiki_rel, names)
    return Workspace(
        root=root,
        wiki=root / wiki_rel,
        wiki_rel=wiki_rel,
        lang=lang,
        hub=names is not None,
        sources=sources,
        databases=databases,
    )


def init(
    root: Path,
    wiki: str = "docs/wiki",
    lang: str = "en",
    hub_sources: list[str] | None = None,
    create_canon: bool = True,
) -> Workspace:
    root = _toplevel(root)
    wiki_rel = _wiki_rel(root, wiki)
    hub = enclosing_hub(root)
    if hub is not None:
        raise ConfigError(
            f"{root} is source {root.name} of the hub at {hub}; its wiki lives in the "
            f"hub, so run okf from {hub} instead of init"
        )
    existing = _git.ls_candidates(root, CONFIG)
    if existing or (root / wiki_rel / CONFIG).exists():
        found = ", ".join(existing) or f"{wiki_rel}/{CONFIG}"
        raise ConfigError(
            f"a wiki is already configured ({found}); use okf status instead of init"
        )
    if lang not in LANGS:
        raise ConfigError(f"unsupported lang {lang!r}; use --lang en or --lang zh")
    data: dict = {"lang": lang}
    if hub_sources is not None:
        names = _source_names(hub_sources, "--source")
        _check_sources(root, names, require_ignored=False)
        _check_wiki_outside(wiki_rel, names)
        data["sources"] = names
        repos = [(name, root / name) for name in names]
    else:
        repos = [(".", root)]
    # Every precondition is checked before anything is written: canon stubs record
    # each source's HEAD, so a repository without a commit is refused up front.
    for name, path in repos:
        if not _git.rev_exists(path, "HEAD"):
            where = "the repository" if name == "." else f"source {name}"
            raise ConfigError(
                f"{where} has no commit yet ({path}); commit the source files first, "
                "then run okf init"
            )
    # safe_dump quotes names YAML would read as another type (on, yes, 1, null).
    text = yaml.safe_dump(data, sort_keys=False, default_flow_style=False, allow_unicode=True)
    if yaml.load(text, Loader=_frontmatter._Loader) != data:  # never leave a config load rejects
        raise ConfigError(f"cannot write {CONFIG} for {data!r}; report this as a bug")
    undo = _Undo(root)
    try:
        if hub_sources is not None:
            undo.keep(root / ".gitignore")
            _ignore(root, data["sources"])
        undo.create(root / wiki_rel / CONFIG)
        _files.atomic_text(root / wiki_rel / CONFIG, text)
        ws = load(root, wiki_rel)
        if create_canon:
            import _page

            for path in _page.canon(ws):
                undo.create(ws.wiki / path)
            _page.create_canon(ws)
    except BaseException:
        undo.rollback()
        raise
    return ws


class _Undo:
    """Restores the files and directories ``init`` touched when it fails midway, so a
    failed init leaves no half-created wiki behind."""

    def __init__(self, root: Path):
        self.root = root
        self.saved: list[tuple[Path, bytes | None]] = []
        self.dirs: list[Path] = []

    def keep(self, file: Path) -> None:
        self.saved.append((file, file.read_bytes() if file.is_file() else None))

    def create(self, file: Path) -> None:
        missing = []
        parent = file.parent
        while parent != self.root and not parent.exists():
            missing.append(parent)
            parent = parent.parent
        self.dirs += [d for d in missing if d not in self.dirs]
        self.keep(file)

    def rollback(self) -> None:
        for file, data in reversed(self.saved):
            try:
                if data is None:
                    file.unlink(missing_ok=True)
                else:
                    file.write_bytes(data)
            except OSError:
                pass
        for directory in sorted(self.dirs, key=lambda d: len(d.parts), reverse=True):
            try:
                directory.rmdir()  # only when empty: never removes a file okf did not write
            except OSError:
                pass


def _toplevel(root: Path) -> Path:
    root = Path(root).resolve()
    top = _git.toplevel(root)
    if top != root:
        # Below a hub source, the source root would only refuse again: name the hub.
        hub = enclosing_hub(top) if top else None
        if hub is not None:
            raise ConfigError(
                f"{root} is inside source {top.name} of the hub at {hub}; run okf "
                f"from the hub root {hub}"
            )
        where = f"the repository root is {top}" if top else "it is not in a git repository"
        raise ConfigError(
            f"{root} is not a git repository root ({where}); run okf from the "
            "repository root, or run git init first"
        )
    return root


def _find_wiki(root: Path) -> str:
    found = _git.ls_candidates(root, CONFIG)
    if not found:
        _refuse_hub_source(root)
        raise NotInitialized(f"no {CONFIG} found in {root}; run okf init")
    if len(found) > 1:
        raise ConfigError(
            f"several {CONFIG} files found ({', '.join(found)}); pass --wiki DIR"
        )
    parent = PurePosixPath(found[0]).parent.as_posix()
    if parent == ".":
        raise ConfigError(
            f"{CONFIG} is at the repository root; move it into a wiki directory "
            "such as docs/wiki"
        )
    return parent


def _refuse_hub_source(root: Path) -> None:
    hub = enclosing_hub(root)
    if hub is not None:
        raise ConfigError(
            f"{root} is source {root.name} of the hub at {hub}; run okf from {hub}"
        )


def enclosing_hub(root: Path) -> Path | None:
    """The hub root when ``root`` is one of its configured sources, else None."""
    hub = _git.toplevel(root.parent) if root.parent != root else None
    if hub is None or hub != root.parent:
        return None
    for found in _git.ls_candidates(hub, CONFIG):
        try:
            _, names, _ = _parse(hub / found, found)
        except ConfigError:
            continue
        if names and root.name in names:
            return hub
    return None


def _wiki_rel(root: Path, wiki: str) -> str:
    target = (root / wiki).resolve()
    try:
        rel = target.relative_to(root).as_posix()
    except ValueError:
        raise ConfigError(
            f"wiki directory {wiki} is outside {root}; choose a directory inside "
            "the repository, such as docs/wiki"
        ) from None
    if rel == ".":
        raise ConfigError(
            "the wiki directory cannot be the repository root; choose a "
            "subdirectory such as docs/wiki"
        )
    return rel


def _parse(config: Path, shown: str) -> tuple[str, list[str] | None, tuple[Database, ...]]:
    try:
        data = yaml.load(config.read_text(encoding="utf-8"), Loader=_frontmatter._Loader)
    except (yaml.YAMLError, _frontmatter.FrontmatterError, UnicodeDecodeError) as exc:
        hint = ""
        if "alias" in str(exc):
            hint = "; quote globs that start with *, e.g. exclude: ['*_bak']"
        raise ConfigError(f"{shown} is not valid YAML ({exc}){hint}; fix the file") from None
    if not isinstance(data, dict):
        raise ConfigError(f"{shown} must be a mapping such as 'lang: en'; fix the file")
    unknown = sorted(str(key) for key in data if key not in _KEYS)
    if unknown:
        raise ConfigError(
            f"{shown} has unknown keys {', '.join(unknown)}; only lang, sources and "
            "databases are allowed, remove the others"
        )
    lang = data.get("lang")
    if lang not in LANGS:
        raise ConfigError(f"{shown}: lang must be en or zh (got {lang!r}); fix the file")
    names = _source_names(data["sources"], f"{shown}: sources") if "sources" in data else None
    databases = _databases(data["databases"], f"{shown}: databases", names) if "databases" in data else ()
    return lang, names, databases


def _databases(value: object, shown: str, sources: list[str] | None) -> tuple[Database, ...]:
    if not isinstance(value, list) or not value:
        raise ConfigError(
            f"{shown} must be a non-empty list of databases, each with name, url_env and "
            "schemas (plus repos in a hub); or remove databases"
        )
    found: list[Database] = []
    for index, item in enumerate(value):
        where = f"{shown}[{index}]"
        if not isinstance(item, dict):
            raise ConfigError(f"{where} must be a mapping with name, url_env and schemas; fix the entry")
        unknown = sorted(str(key) for key in item if key not in _DB_KEYS)
        if unknown:
            raise ConfigError(
                f"{where} has unknown keys {', '.join(unknown)}; a database takes only "
                "name, url_env, repos and schemas (never a URL or password)"
            )
        name = item.get("name")
        if not isinstance(name, str) or not _SOURCE_NAME.fullmatch(name):
            raise ConfigError(
                f"{where}: name {name!r} must be a plain name such as order_db; it names "
                "the wiki directory of this database's pages"
            )
        where = f"{shown} {name}"
        if any(db.name == name for db in found):
            raise ConfigError(f"{where} is listed twice; merge the entries")
        env = item.get("url_env")
        if not isinstance(env, str) or not _ENV_NAME.fullmatch(env):
            raise ConfigError(
                f"{where}: url_env must be the name of an environment variable (or .env "
                "key) holding the opengauss:// URL, such as ORDER_DB_URL; never the URL itself"
            )
        found.append(Database(name, env, _db_repos(item.get("repos"), where, sources),
                              _schema_rules(item.get("schemas"), where)))
    return tuple(found)


def _db_repos(value: object, where: str, sources: list[str] | None) -> tuple[str, ...]:
    if sources is None:
        if value is not None:
            raise ConfigError(
                f"{where}: repos is only for a hub, where it names the sources using this "
                "database; in a single repository remove it"
            )
        return (".",)
    if not isinstance(value, list) or not value:
        raise ConfigError(
            f"{where}: repos must list the hub sources whose code uses this database, "
            f"from: {', '.join(sources)}"
        )
    repos: list[str] = []
    for repo in value:
        if repo not in sources:
            raise ConfigError(
                f"{where}: repos names {repo!r}, which is not a source; use one of: "
                f"{', '.join(sources)}"
            )
        if repo in repos:
            raise ConfigError(f"{where}: repos lists {repo} twice; remove the duplicate")
        repos.append(repo)
    return tuple(repos)


def _schema_rules(value: object, where: str) -> tuple[SchemaRule, ...]:
    if value is None:
        return (SchemaRule("public"),)
    if not isinstance(value, list) or not value:
        raise ConfigError(
            f"{where}: schemas must be a non-empty list of schema names or mappings "
            "with name, include and exclude; or remove it to capture schema public"
        )
    rules: list[SchemaRule] = []
    for item in value:
        item = {"name": item} if isinstance(item, str) else item
        if not isinstance(item, dict):
            raise ConfigError(f"{where}: schema entry {item!r} must be a name or a mapping with name")
        unknown = sorted(str(key) for key in item if key not in _SCHEMA_KEYS)
        if unknown:
            raise ConfigError(
                f"{where}: schema entry has unknown keys {', '.join(unknown)}; use name, "
                "include and exclude"
            )
        name = item.get("name")
        if not isinstance(name, str) or not _CATALOG_NAME.fullmatch(name):
            raise ConfigError(
                f"{where}: schema name {name!r} must be a schema name or a glob such as "
                "tenant_*"
            )
        if any(rule.name == name for rule in rules):
            raise ConfigError(f"{where}: schema {name} is listed twice; merge its include and exclude")
        include = _globs(item.get("include"), f"{where} schema {name} include", ("*",))
        exclude = _globs(item.get("exclude"), f"{where} schema {name} exclude", ())
        rules.append(SchemaRule(name, include, exclude))
    return tuple(rules)


def _globs(value: object, where: str, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value or not all(
        isinstance(g, str) and _CATALOG_NAME.fullmatch(g) for g in value
    ):
        raise ConfigError(
            f"{where} must be a non-empty list of table name globs, e.g. ['t_order*', "
            "'*_config']: * matches any run of characters, so t_order* starts with "
            "t_order and *_log ends with _log"
        )
    return tuple(value)


def _source_names(value: object, shown: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ConfigError(
            f"{shown} must be a non-empty list of directory names; list the "
            "source repositories, or remove sources for a single repository"
        )
    names: list[str] = []
    for name in value:
        if isinstance(name, (bool, int, float)) or name is None:
            raise ConfigError(
                f"{shown}: YAML read an entry as {name!r} ({type(name).__name__}), not a "
                "directory name; quote it, e.g. - 'on', - 'yes' or - '1'"
            )
        if not isinstance(name, str) or not _SOURCE_NAME.fullmatch(name):
            raise ConfigError(
                f"{shown}: {name!r} is not a plain directory name; use the name of "
                "a direct child directory such as api"
            )
        if name in names:
            raise ConfigError(f"{shown}: {name} is listed twice; remove the duplicate")
        names.append(name)
    return names


def _check_sources(root: Path, names: list[str], require_ignored: bool) -> None:
    for name in names:
        path = root / name
        if not path.is_dir():
            raise ConfigError(
                f"source {name} is missing: {path} is not a directory; clone or "
                "mount the repository there"
            )
        if _git.toplevel(path) != path.resolve():
            raise ConfigError(
                f"source {name} is not a git repository root ({path}); clone the "
                "repository there or run git init in it"
            )
        if require_ignored and not _git.check_ignore(root, name):
            raise ConfigError(
                f"source {name} is not ignored by the hub repository; add the line "
                f"/{name}/ to {root / '.gitignore'}"
            )


def _check_wiki_outside(wiki_rel: str, names: list[str]) -> None:
    first = wiki_rel.split("/", 1)[0]
    if first in names:
        raise ConfigError(
            f"wiki directory {wiki_rel} is inside source {first}; put the wiki in "
            "the hub repository, such as docs/wiki"
        )


def _ignore(root: Path, names: list[str]) -> None:
    gitignore = root / ".gitignore"
    text = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    lines = text.splitlines()
    missing = [f"/{n}/" for n in names if f"/{n}/" not in lines]
    if not missing:
        return
    if text and not text.endswith("\n"):
        text += "\n"
    _files.atomic_text(gitignore, text + "".join(f"{line}\n" for line in missing))


# --- locators and paths --------------------------------------------------------


@dataclass(frozen=True)
class Locator:
    path: str
    start: int | None
    end: int | None

    def text(self) -> str:
        """Canonical text; a path with whitespace is written ``<path>#Lx-Ly``."""
        path = f"<{self.path}>" if any(ch.isspace() for ch in self.path) else self.path
        if self.start is None:
            return path
        if self.end == self.start:
            return f"{path}#L{self.start}"
        return f"{path}#L{self.start}-L{self.end}"


def definition_locator(text: str) -> tuple[str, str]:
    """(locator text, note) of a footnote definition ``<locator>( <note>)?``.

    The locator is the first whitespace-separated token, or, for a path with
    spaces, the angle-bracket form ``<my app/x.py>#L3-L5``; ("", "") when empty."""
    text = text.strip()
    match = _BRACKETED.match(text)
    if match and (match.end() == len(text) or text[match.end()].isspace()):
        return text[: match.end()], text[match.end():].strip()
    parts = text.split(None, 1)
    return (parts[0], parts[1] if len(parts) > 1 else "") if parts else ("", "")


def parse_locator(text: str) -> Locator:
    """``path``, ``path#L<n>`` or ``path#L<n>-L<m>``; ``<path with spaces>#L<n>-L<m>``
    for a path containing whitespace."""
    if isinstance(text, str) and text.startswith("<"):
        bracketed = _BRACKETED.fullmatch(text)
        if bracketed is None:
            raise LocatorError(
                f"invalid locator {text!r}: expected <path>, <path>#L<n> or <path>#L<n>-L<m>"
            )
        text = bracketed["path"] + (bracketed["lines"] or "")
    match = _LOCATOR.fullmatch(text) if isinstance(text, str) else None
    if match is None:
        raise LocatorError(
            f"invalid locator {text!r}: expected path, path#L<n> or path#L<n>-L<m>"
        )
    path = match["path"]
    problem = _path_problem(path)
    if problem:
        raise LocatorError(f"invalid locator {text!r}: {problem}")
    if match["start"] is None:
        return Locator(path, None, None)
    start = int(match["start"])
    end = int(match["end"]) if match["end"] is not None else start
    if not 1 <= start <= end:
        raise LocatorError(
            f"invalid locator {text!r}: line range must satisfy 1 <= start <= end"
        )
    return Locator(path, start, end)


def _path_problem(path: str) -> str | None:
    if not path:
        return "path is empty"
    if "\\" in path:
        return "use / instead of \\"
    if _SCHEME.match(path):
        return "no URI scheme or drive prefix; use a plain repository-relative path"
    if path.startswith("/"):
        return "path must be relative to the workspace root"
    if path.endswith("/"):
        return "path must not end with /"
    if any(part in ("", ".", "..") for part in path.split("/")):
        return "path must not contain empty, . or .. segments"
    return None


def resolve(ws: Workspace, path: str) -> tuple[Source, str]:
    """Split a workspace-relative path into its source and source-relative path."""
    if path == ws.wiki_rel or path.startswith(ws.wiki_rel + "/"):
        raise LocatorError(
            f"{path} is inside the wiki directory; cite source files, not wiki pages"
        )
    if not ws.hub:
        return ws.sources[0], path
    name, _, rest = path.partition("/")
    for source in ws.sources:
        if source.name == name and rest:
            return source, rest
    names = ", ".join(s.name for s in ws.sources)
    raise LocatorError(
        f"{path} does not start with a source directory; prefix it with one of: {names}"
    )


def glob_match(pattern: str, path: str) -> bool:
    return glob_regex(pattern).fullmatch("/" + path.rstrip("/")) is not None


@lru_cache(maxsize=8192)
def glob_regex(pattern: str) -> re.Pattern:
    """Compiled form of a scope glob, matched against "/" + path.

    ``**`` matches zero or more whole segments, ``*`` and ``?`` stay within one
    segment, ``[...]`` is a character class; a pattern without wildcards also
    matches every path below it.
    """
    pattern = pattern.rstrip("/")
    if not _WILDCARD.search(pattern):
        return re.compile(re.escape("/" + pattern) + "(?:/.*)?", re.DOTALL)
    out = []
    for segment in pattern.split("/"):
        out.append("(?:/[^/]+)*" if segment == "**" else "/" + _segment(segment))
    return re.compile("".join(out), re.DOTALL)


def _segment(segment: str) -> str:
    """fnmatch semantics for one path segment; nothing matches '/'."""
    out, index, size = [], 0, len(segment)
    while index < size:
        char = segment[index]
        index += 1
        if char == "*":
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        elif char == "[":
            end = index
            if end < size and segment[end] == "!":
                end += 1
            if end < size and segment[end] == "]":
                end += 1
            while end < size and segment[end] != "]":
                end += 1
            if end >= size:
                out.append("\\[")
                continue
            body = segment[index:end].replace("\\", "\\\\")
            index = end + 1
            if body.startswith("!"):
                body = "^/" + body[1:]
            elif body.startswith("^"):
                body = "\\" + body
            out.append(f"[{body}]")
        else:
            out.append(re.escape(char))
    return "".join(out)


def glob_prefix(pattern: str) -> str:
    """Leading literal segments of a glob: every match equals it or lies below it."""
    literal = []
    for segment in pattern.rstrip("/").split("/"):
        if _WILDCARD.search(segment):
            break
        literal.append(segment)
    return "/".join(literal)


def glob_filter(pattern: str, paths: list[str]) -> list[str]:
    """The paths of a sorted list that match ``pattern``, narrowed by its literal prefix."""
    prefix = glob_prefix(pattern)
    lo, hi = 0, len(paths)
    if prefix:
        # Everything equal to or below the prefix sorts between it and prefix + "0"
        # ("0" follows "/"); the regex drops the siblings that share the prefix.
        lo = bisect.bisect_left(paths, prefix)
        hi = bisect.bisect_left(paths, prefix + "0", lo)
    regex = glob_regex(pattern)
    return [path for path in paths[lo:hi] if regex.fullmatch("/" + path)]


_ENV_SAMPLES = (".env.example", ".env.sample", ".env.template", ".env.dist")


def is_forbidden(path: str) -> bool:
    name = path.rstrip("/").rsplit("/", 1)[-1].lower()
    if name in _ENV_SAMPLES:
        return False
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in _FORBIDDEN)
