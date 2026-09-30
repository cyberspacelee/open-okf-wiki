"""Code structure read from source text: triggers (where work starts), imports
(which file uses which) and named resources (message topics, database tables).

Pure functions over workspace-relative paths and blob text; ``_scan`` feeds them
from git HEAD and folds the results into modules. Everything here is regex over
text, deterministic for a given input, and deliberately shallow: it points an
agent at the places to read, it does not replace reading them.
"""

import posixpath
import re
from collections import defaultdict
from dataclasses import dataclass

JVM = (".java", ".kt", ".scala", ".groovy")
PY = (".py",)
JS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
GO = (".go",)
CS = (".cs",)
TRIGGER_KINDS = ("http", "rpc", "listener", "job", "event", "cli", "startup")

_IMPLEMENTS = r"\bimplements\s+(?:[\w.<>]+\s*,\s*)*(?:[\w]+\.)*"

# (suffixes, kind, pattern). Patterns run on text whose comments (and, for brace
# languages, string literals) are blanked, so an annotation in a Javadoc example or
# a route in a log message is not a trigger.
_RULES = (
    (JVM, "http", (r"@(?:RestController|Controller|(?:Get|Post|Put|Delete|Patch|Request)Mapping)\b",
                   r"@Path\s*\(")),
    (JVM, "rpc", (r"@(?:DubboService|GrpcService)\b", r"\bextends\s+[\w.]*ImplBase\b")),
    (JVM, "listener", ((r"@(?:KafkaListener|RabbitListener|RabbitHandler|JmsListener|SqsListener"
                        r"|StreamListener|RocketMQMessageListener|PulsarListener)\b"),
                       rf"{_IMPLEMENTS}RocketMQListener\b")),
    (JVM, "job", (r"@(?:Scheduled|Schedules|XxlJob)\b", r"\bextends\s+QuartzJobBean\b",
                  rf"{_IMPLEMENTS}(?:Job|StatefulJob|SimpleJob|DataflowJob)\b")),
    (JVM, "event", (r"@(?:TransactionalEventListener|EventListener)\b",)),
    (JVM, "startup", (rf"{_IMPLEMENTS}(?:CommandLineRunner|ApplicationRunner)\b",)),
    (PY, "http", (r"^[ \t]*@[\w.]*\.(?:get|post|put|delete|patch|route|api_route|websocket)\s*\(",
                  (r"^[ \t]*class\s+\w+\s*\([^)]*\b(?:APIView|GenericAPIView|ViewSet|ModelViewSet"
                   r"|GenericViewSet|ReadOnlyModelViewSet|MethodView)\b"))),
    (PY, "rpc", (r"\badd_\w+Servicer_to_server\s*\(",)),
    (PY, "listener", (r"^[ \t]*@[\w.]*\.(?:agent|subscriber|consumer|subscribe)\s*\(",)),
    (PY, "job", (r"^[ \t]*@(?:[\w.]*\.)?(?:task|shared_task|periodic_task|scheduled_job|dag|flow)\b",
                 r"\bDAG\s*\(")),
    (PY, "event", (r"^[ \t]*@receiver\s*\(",)),
    (PY, "cli", (r"^[ \t]*class\s+Command\s*\([^)]*\bBaseCommand\b",
                 r"^[ \t]*@(?:\w+\.)+(?:command|group)\s*\(")),
    (JS, "http", (r"@(?:Controller|Get|Post|Put|Delete|Patch|All)\s*\(",
                  r"\b(?:app|router|server|api)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(\s*['\"`]/")),
    (JS, "listener", (r"@(?:EventPattern|MessagePattern|Processor)\s*\(",)),
    (JS, "job", (r"@(?:Cron|Interval|Timeout)\s*\(",)),
    (JS, "event", (r"@OnEvent\s*\(",)),
    (GO, "http", (r"\bhttp\.HandleFunc\s*\(",
                  r"\.\s*(?:GET|POST|PUT|DELETE|PATCH|Handle|HandleFunc)\s*\(\s*\"/")),
    (GO, "job", (r"\.\s*AddFunc\s*\(",)),
    (CS, "http", (r"\[\s*(?:ApiController|Http(?:Get|Post|Put|Delete|Patch))\b",
                  r":\s*(?:Controller|ControllerBase)\b")),
    (CS, "job", (r":\s*(?:BackgroundService|IHostedService)\b",)),
)
TRIGGER_RULES: tuple[tuple[tuple[str, ...], str, re.Pattern], ...] = tuple(
    (suffixes, kind, re.compile("|".join(patterns), re.MULTILINE)) for suffixes, kind, patterns in _RULES
)
# An interface whose mappings describe calls this code makes to another service.
_OUTBOUND = re.compile(r"@(?:FeignClient|RegisterRestClient)\b")
_DJANGO_ROUTE = re.compile(r"^[ \t]*(?:re_)?path\s*\(|^[ \t]*url\s*\(", re.MULTILINE)
TRIGGER_SUFFIXES = frozenset(s for suffixes, _, _ in TRIGGER_RULES for s in suffixes)

# Fixed strings at least one of which every trigger file contains: ``git grep -F``
# narrows the files to read before the rules run.
TRIGGER_TOKENS = (
    "Mapping", "Controller", "@Path", "DubboService", "GrpcService", "ImplBase", "Listener",
    "RabbitHandler", "Scheduled", "Schedules", "XxlJob", "QuartzJobBean", "Job", "Runner",
    "@EventListener", "Servicer_to_server", ".get", ".post", ".put", ".delete", ".patch",
    ".route", ".api_route", ".websocket", "View", "path(", "url(", ".agent", ".subscribe",
    ".consumer", "task", "scheduled_job", "dag", "flow", "DAG", "@receiver", "BaseCommand",
    "command", "group", "@Get", "@Post", "@Put", "@Delete", "@Patch", "@All", "Pattern",
    "@Processor", "@Cron", "@Interval", "@Timeout", "@OnEvent", ".all", "HandleFunc",
    ".GET", ".POST", ".PUT", ".DELETE", ".PATCH", ".Handle", "AddFunc", "Http",
    "BackgroundService", "IHostedService",
)

_C_NOISE = re.compile(r"\"\"\".*?\"\"\"|\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|//[^\n]*|/\*.*?\*/",
                      re.DOTALL)
_C_COMMENTS = re.compile(r"\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|//[^\n]*|/\*.*?\*/", re.DOTALL)
_PY_NOISE = re.compile(r"\"\"\".*?\"\"\"|'''.*?'''|#[^\n]*", re.DOTALL)


def _blank(match: re.Match) -> str:
    return re.sub(r"[^\n]", " ", match[0])


def _keep_strings(match: re.Match) -> str:
    text = match[0]
    return text if text[0] in "\"'" else _blank(match)


def code_only(path: str, text: str) -> str:
    """``text`` with comments blanked (and, in brace languages, string literals too),
    line breaks kept so offsets map to the same lines."""
    suffix = _suffix(path)
    if suffix in PY:
        return _PY_NOISE.sub(_blank, text)
    if suffix in JS or suffix in GO:
        # Route paths and module specifiers are strings; only comments go.
        return _C_COMMENTS.sub(_keep_strings, text)
    return _C_NOISE.sub(_blank, text)


def triggers_in(path: str, text: str) -> list[tuple[int, str]]:
    """(line, kind) of every trigger in one file, sorted; empty for other suffixes."""
    suffix = _suffix(path)
    if suffix not in TRIGGER_SUFFIXES:
        return []
    code = code_only(path, text)
    found = set()
    for suffixes, kind, pattern in TRIGGER_RULES:
        if suffix in suffixes:
            found |= {(_line(code, m.start()), kind) for m in pattern.finditer(code)}
    if suffix in JVM and _OUTBOUND.search(code):
        found = {item for item in found if item[1] != "http"}
    if suffix in PY and path.rsplit("/", 1)[-1] == "urls.py":
        found |= {(_line(code, m.start()), "http") for m in _DJANGO_ROUTE.finditer(code)}
    return sorted(found)


# --- imports ---------------------------------------------------------------------------------

_JVM_PACKAGE = re.compile(r"^[ \t]*package\s+([\w.]+)", re.MULTILINE)
_JVM_IMPORT = re.compile(r"^[ \t]*import\s+(?:static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?[ \t]*$",
                         re.MULTILINE)
_PY_IMPORT = re.compile(r"^[ \t]*import\s+([\w., \t]+)$", re.MULTILINE)
_PY_FROM = re.compile(r"^[ \t]*from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)", re.MULTILINE)
_JS_IMPORT = re.compile(
    r"""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]"""
    r"""|(?:^|[;\s])import\s*['"]([^'"\n]+)['"]"""
    r"""|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)""",
)
_GO_IMPORT_ONE = re.compile(r'^import\s+(?:[\w.]+\s+)?"([^"\n]+)"', re.MULTILINE)
_GO_IMPORT_BLOCK = re.compile(r"^import\s*\((.*?)^\)", re.MULTILINE | re.DOTALL)
_GO_SPEC = re.compile(r'^[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]+)"', re.MULTILINE)
_JS_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte")


class Imports:
    """Import statements of many files, resolved to the tracked files they name.

    Register each source root with ``root``, feed every production code file with
    ``add`` in a fixed order, register package names with ``package`` and Go
    modules with ``go_module``, then call ``edges``. Only added files are targets.
    """

    def __init__(self):
        self.files: set[str] = set()
        self.roots: list[str] = []  # source prefixes ("" or "api/"): where absolute imports start
        self.raw: list[tuple[str, int, str, tuple]] = []  # (path, line, language, spec)
        self.jvm_classes: dict[str, str] = {}  # fully qualified class -> file
        self.jvm_packages: dict[str, list[str]] = defaultdict(list)
        self.js_packages: dict[str, str] = {}  # package.json name -> its manifest path
        self.go_modules: dict[str, str] = {}  # go module path -> directory ("" for root)
        self.by_dir: dict[str, list[str]] = defaultdict(list)
        self._py_index: dict[str, str] | None = None

    def root(self, prefix: str) -> None:
        self.roots.append(prefix)

    def package(self, name: str, manifest: str) -> None:
        self.js_packages.setdefault(name, manifest)

    def go_module(self, module: str, directory: str) -> None:
        self.go_modules.setdefault(module.rstrip("/"), "" if directory == "." else directory)

    def add(self, path: str, text: str) -> None:
        self.files.add(path)
        self.by_dir[_parent(path)].append(path)
        suffix = _suffix(path)
        if suffix in JVM:
            self._jvm(path, text)
        elif suffix in PY or suffix == ".pyi":
            self._python(path, text)
        elif suffix in JS or suffix in (".vue", ".svelte"):
            for match in _JS_IMPORT.finditer(code_only(path, text) if suffix in JS else text):
                group = next(i for i in (1, 2, 3) if match[i])
                self.raw.append((path, _line(text, match.start(group)), "js", (match[group],)))
        elif suffix in GO:
            code = code_only(path, text)
            for match in _GO_IMPORT_ONE.finditer(code):
                self.raw.append((path, _line(code, match.start()), "go", (match[1],)))
            for block in _GO_IMPORT_BLOCK.finditer(code):
                for spec in _GO_SPEC.finditer(block[1]):
                    self.raw.append((path, _line(code, block.start(1) + spec.start()), "go", (spec[1],)))

    def _jvm(self, path: str, text: str) -> None:
        code = code_only(path, text)
        package = _JVM_PACKAGE.search(code)
        name = package[1] if package else ""
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        self.jvm_classes.setdefault(f"{name}.{stem}" if name else stem, path)
        self.jvm_packages[name].append(path)
        for match in _JVM_IMPORT.finditer(code):
            self.raw.append((path, _line(code, match.start()), "jvm", (match[1], bool(match[2]))))

    def _python(self, path: str, text: str) -> None:
        code = code_only(path, text)
        for match in _PY_IMPORT.finditer(code):
            for item in match[1].split(","):
                dotted = item.strip().split()[0] if item.strip() else ""
                if dotted:
                    self.raw.append((path, _line(code, match.start()), "py", (0, dotted, ())))
        for match in _PY_FROM.finditer(code):
            names = tuple(
                n.strip().split()[0] for n in match[3].strip("()").replace("\n", ",").split(",")
                if n.strip() and n.strip()[0] not in "*\\"
            )
            self.raw.append((path, _line(code, match.start()), "py", (len(match[1]), match[2], names)))

    def edges(self) -> list[tuple[str, int, str]]:
        """(importing file, line, imported file) for every import that names a tracked
        file other than the importer; sorted."""
        out = set()
        for path, line, language, spec in self.raw:
            for target in getattr(self, f"_resolve_{language}")(path, *spec):
                if target != path:
                    out.add((path, line, target))
        return sorted(out)

    def _resolve_jvm(self, path: str, name: str, wildcard: bool) -> list[str]:
        if wildcard:
            return self.jvm_packages.get(name, [])[:1]
        parts = name.split(".")
        for end in range(len(parts), 1, -1):  # a static import names a member of a class
            found = self.jvm_classes.get(".".join(parts[:end]))
            if found:
                return [found]
        return []

    def _resolve_py(self, path: str, level: int, dotted: str, names: tuple) -> list[str]:
        if level:
            base = _parent(path)
            for _ in range(level - 1):
                base = _parent(base)
            prefix = "" if base in (".", "") else base + "/"
            stem = prefix + dotted.replace(".", "/") if dotted else prefix.rstrip("/")
            found = [self._py_file(f"{stem}/{n}") for n in names] if names else []
            found = [f for f in found if f]
            return found or [f for f in [self._py_file(stem)] if f]
        index = self._python_index()
        found = [index[f"{dotted}.{n}"] for n in names if f"{dotted}.{n}" in index]
        if found:
            return found
        parts = dotted.split(".")
        for end in range(len(parts), 0, -1):
            hit = index.get(".".join(parts[:end]))
            if hit:
                return [hit]
        return []

    def _py_file(self, stem: str) -> str | None:
        stem = stem.strip("/")
        for candidate in (f"{stem}.py", f"{stem}/__init__.py", f"{stem}.pyi"):
            if candidate in self.files:
                return candidate
        return None

    def _python_index(self) -> dict[str, str]:
        """Dotted module name -> file, from every root absolute imports can start at:
        each source root, its ``src``, and the parent of every top-level package."""
        if self._py_index is not None:
            return self._py_index
        py = sorted(p for p in self.files if _suffix(p) in (".py", ".pyi"))
        roots = set()
        for prefix in self.roots:
            roots |= {prefix.rstrip("/"), prefix + "src"}
        for path in py:
            directory = _parent(path)
            top = None
            while directory not in (".", "") and f"{directory}/__init__.py" in self.files:
                top = directory
                directory = _parent(directory)
            if top is not None:
                roots.add("" if _parent(top) == "." else _parent(top))
        index: dict[str, str] = {}
        for root in sorted(roots, key=lambda r: (-r.count("/"), r)):
            prefix = root + "/" if root else ""
            for path in py:
                if not path.startswith(prefix):
                    continue
                rel = path[len(prefix):].rsplit(".", 1)[0]
                rel = rel.removesuffix("/__init__")
                if rel and "-" not in rel and " " not in rel:
                    index.setdefault(rel.replace("/", "."), path)
        self._py_index = index
        return index

    def _resolve_js(self, path: str, spec: str) -> list[str]:
        if spec.startswith("."):
            base = posixpath.normpath(posixpath.join(_parent(path), spec))
            if base.startswith(".."):
                return []
            base = "" if base == "." else base
            candidates = [base] + [base + ext for ext in _JS_EXTS]
            candidates += [f"{base}/index{ext}" for ext in _JS_EXTS]
            return [c for c in candidates if c in self.files][:1]
        parts = spec.split("/")
        name = "/".join(parts[:2]) if spec.startswith("@") else parts[0]
        manifest = self.js_packages.get(name)
        return [manifest] if manifest else []

    def _resolve_go(self, path: str, spec: str) -> list[str]:
        best = max((m for m in self.go_modules if spec == m or spec.startswith(m + "/")),
                   key=len, default=None)
        if best is None:
            return []
        directory = self.go_modules[best]
        rest = spec[len(best):].strip("/")
        target = "/".join(p for p in (directory, rest) if p) or "."
        return [f for f in self.by_dir.get(target, []) if f.endswith(".go")][:1]


# --- named resources -------------------------------------------------------------------------

_LISTENER_ARGS = re.compile(
    r"@(?:KafkaListener|RabbitListener|JmsListener|RocketMQMessageListener|SqsListener|PulsarListener)"
    r"\s*\(([^)]*)\)", re.DOTALL,
)
_LISTENER_KEYS = re.compile(r"\b(?:topics?|queues|destination|value|topicPattern)\s*=\s*(\{[^}]*\}|\"[^\"]*\")")
_SEND = re.compile(
    r"\.\s*(?:send|sendDefault|send_and_wait|convertAndSend|syncSend|asyncSend|sendOneWay|produce|publish)"
    r"\s*\(\s*(?:topic\s*=\s*)?[\"']([^\"'\n]{2,120})[\"']"
)
_PY_CONSUMER = re.compile(r"\b(?:KafkaConsumer|AIOKafkaConsumer)\s*\(\s*[\"']([^\"'\n]+)[\"']"
                          r"|\.\s*subscribe\s*\(\s*\[?\s*[\"']([^\"'\n]+)[\"']")
_TABLE_DECL = re.compile(
    r"@Table\s*\(\s*name\s*=\s*\"([^\"]+)\"|@TableName\s*\(\s*(?:value\s*=\s*)?\"([^\"]+)\""
    r"|\b__tablename__\s*=\s*[\"']([^\"']+)[\"']|\bdb_table\s*=\s*[\"']([^\"']+)[\"']"
)
_STRING = re.compile(r"\"\"\"(.*?)\"\"\"|'''(.*?)'''|\"((?:\\.|[^\"\\\n])*)\"|'((?:\\.|[^'\\\n])*)'|`([^`]*)`",
                     re.DOTALL)
_SQL_START = re.compile(r"^\s*(?:select|insert|update|delete|merge|with|create|alter)\b", re.IGNORECASE)
_SQL_TABLE = re.compile(
    r"\b(?:from|join|into|update|table)\s+(?:if\s+(?:not\s+)?exists\s+|only\s+)?"
    r"([`\"\[]?[A-Za-z_][\w$]*[`\"\]]?(?:\.[`\"\[]?[A-Za-z_][\w$]*[`\"\]]?)?)",
    re.IGNORECASE,
)
_SQL_WORDS = {
    "select", "set", "where", "values", "value", "dual", "lateral", "unnest", "only", "the",
    "table", "tables", "if", "exists", "not", "on", "as", "in", "and", "or", "into", "from",
    "join", "update", "delete", "insert", "with", "group", "order", "by", "limit",
    "returning", "using", "inner", "outer", "left", "right", "cross", "full", "natural",
    "information_schema", "each", "row", "rows", "json_table", "generate_series", "a", "an",
}


def resources_in(path: str, text: str) -> list[tuple[str, str, int]]:
    """(kind, name, line) of the message topics and database tables one file names:
    ``topic`` from listener annotations, consumers and send/publish calls with a
    literal name; ``table`` from entity mappings, mapper XML, SQL files and SQL
    string literals. Names are as written (topics) or lowercased without schema
    and quotes (tables)."""
    suffix = _suffix(path)
    out: set[tuple[str, str, int]] = set()
    if suffix == ".sql" or (suffix == ".xml" and "<mapper" in text):
        out |= _tables(text, 0, text)
        return sorted(out)
    if suffix not in JVM and suffix not in PY and suffix not in JS and suffix not in GO and suffix not in CS:
        return []
    for match in _LISTENER_ARGS.finditer(text):
        for key in _LISTENER_KEYS.finditer(match[1]):
            for name in re.findall(r"\"([^\"]+)\"", key[1]):
                out.add(("topic", name, _line(text, match.start())))
    for pattern in (_SEND, _PY_CONSUMER):
        for match in pattern.finditer(text):
            name = next(g for g in match.groups() if g)
            out.add(("topic", name, _line(text, match.start())))
    for match in _TABLE_DECL.finditer(text):
        name = next(g for g in match.groups() if g)
        out.add(("table", _table_name(name), _line(text, match.start())))
    for match in _STRING.finditer(text):
        body = next((g for g in match.groups() if g is not None), "")
        if _SQL_START.match(body):
            start = match.start() + (3 if match[0][:3] in ('"""', "'''") else 1)
            out |= _tables(body, start, text)
    return sorted(out)


def _tables(sql: str, offset: int, text: str) -> set[tuple[str, str, int]]:
    out = set()
    for match in _SQL_TABLE.finditer(sql):
        raw = match[1]
        name = _table_name(raw)
        if name and name not in _SQL_WORDS and not name.startswith(("#", "$")) and len(name) > 1:
            out.add(("table", name, _line(text, offset + match.start(1))))
    return out


def _table_name(raw: str) -> str:
    return raw.split(".")[-1].strip("`\"[]").lower()


# --- helpers ---------------------------------------------------------------------------------


def _suffix(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    if dot <= 0 or dot == len(name) - 1:
        return ""
    return name[dot:].lower()


def _parent(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else "."


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


# --- contract sites -----------------------------------------------------------------------------
#
# A contract site is one place where code provides or consumes an interface another
# repository may use: an HTTP route or client call, an RPC service or stub, a topic
# it publishes or listens to, a table it writes or reads. ``_scan`` matches sites
# across the sources of a hub into contracts.


@dataclass(frozen=True)
class Site:
    kind: str  # http | rpc | topic | table | library
    key: str  # "POST /orders/{}", "InventoryService", "order-created", "t_order", "com.acme:api"
    role: str  # provider | consumer
    line: int
    hint: str = ""  # an HTTP client's declared service (Feign name, URL host)


CONTRACT_KINDS = ("http", "rpc", "topic", "table", "library")
HTTP_METHODS = ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")
ANY = "ANY"

_PARAM = re.compile(r"\$\{[^}]*\}|\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*|%[sd]|\(\?P<\w+>[^)]*\)")


def normalize_http_path(raw: str, route: bool = False) -> str | None:
    """A route or URL as a comparable path: host and query dropped, parameters as
    ``{}``, lowercase, no trailing slash. None when nothing path-like is left (a
    client URL must start with a host, a slash or a leading placeholder)."""
    text = raw.strip().strip("^$")
    text = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/]*", "", text)  # scheme and host
    text = text.split("?", 1)[0].split("#", 1)[0]
    lead = re.match(r"^(?:\$\{[^}]*\}|\{[^}]*\}|%s)+", text)  # a base-URL placeholder
    if lead:
        text = text[lead.end():]
    if not text.startswith("/"):
        if not route or not text or not re.match(r"[\w{<:$(]", text):
            return None
        text = "/" + text
    text = _PARAM.sub("{}", text)
    text = re.sub(r"/{2,}", "/", text).rstrip("/") or "/"
    if not re.search(r"[A-Za-z]", text):
        return None  # only parameters: nothing to match on
    return text.lower()


def normalize_contract_id(text: str) -> str:
    """A contract id (or a glob over ids) in canonical form: whitespace collapsed,
    the kind lowercase, an HTTP method uppercase and its path normalized."""
    parts = str(text).split()
    if not parts:
        return ""
    parts[0] = parts[0].lower()
    if parts[0] == "http" and len(parts) == 3:
        method = parts[1].upper()
        path = parts[2]
        if not any(ch in path for ch in "*?["):
            path = normalize_http_path(path, route=True) or path
        else:
            path = _PARAM.sub("{}", path).lower()
        return f"http {method} {path}"
    return " ".join(parts)


def contract_id(kind: str, key: str) -> str:
    return f"{kind} {key}"


_JVM_TYPE_DECL = re.compile(r"\b(?:class|interface|enum|record)\s+\w+")
_SPRING_MAPPING = re.compile(r"@(Get|Post|Put|Delete|Patch|Request)Mapping\b(?:\s*\(([^)]*)\))?")
_JAXRS_PATH = re.compile(r"@Path\s*\(\s*(?:value\s*=\s*)?\"([^\"]*)\"\s*\)")
_JAXRS_METHOD = re.compile(r"@(GET|POST|PUT|DELETE|PATCH|HEAD)\b")
_FEIGN = re.compile(r"@FeignClient\b(?:\s*\(([^)]*)\))?")
_REST_CLIENT = re.compile(r"@RegisterRestClient\b(?:\s*\(([^)]*)\))?")
_ANNOTATION_STRING = re.compile(r"(?:\b(value|path|name|url|configKey|baseUri)\s*=\s*)?\{?\s*\"([^\"]*)\"")
_REST_TEMPLATE = re.compile(
    r"\.\s*(getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|delete"
    r"|patchForObject|exchange)\s*\(\s*\"([^\"]+)\"([^;]*)"
)
_WEB_CLIENT = re.compile(r"\.\s*(get|post|put|delete|patch)\s*\(\s*\)\s*\.\s*uri\s*\(\s*\"([^\"]+)\"")
_DUBBO_SERVICE = re.compile(r"@DubboService\b")
_IMPLEMENTS_LIST = re.compile(r"\bclass\s+\w+[^{]*?\bimplements\s+([\w.<>,\s]+?)\s*\{")
_DUBBO_REFERENCE = re.compile(
    r"@DubboReference\b(?:\s*\([^)]*\))?\s*(?:@\w+(?:\s*\([^)]*\))?\s*)*"
    r"(?:(?:private|protected|public|final|static)\s+)*([\w.]+)(?:<[^>]*>)?\s+\w+\s*[;=]"
)
_GRPC_IMPL = re.compile(r"\bextends\s+(?:[\w.]+\.)?(\w+)Grpc\s*\.\s*\w+ImplBase\b")
_GRPC_STUB = re.compile(r"\b(\w+)Grpc\s*\.\s*(?:new\w*Stub\s*\(|\w+Stub\b)")
_PY_ROUTE = re.compile(
    r"^[ \t]*@([\w.]+)\.(get|post|put|delete|patch|api_route|route|websocket)\s*\(\s*[rf]?[\"']([^\"'\n]*)[\"']"
    r"([^\n]*)", re.MULTILINE,
)
_PY_PREFIX = re.compile(r"\b(\w+)\s*=\s*(?:[\w.]*\.)?(?:APIRouter|Blueprint)\s*\(([^)]*)\)", re.DOTALL)
_PY_DJANGO = re.compile(r"(?<![\w.])(re_path|path|url)\s*\(\s*r?[\"']([^\"'\n]*)[\"']")
_PY_CLIENT = re.compile(r"(?<![@\w.])([\w.]+)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*f?[\"']([^\"'\n]+)[\"']")
_PY_SERVICER = re.compile(r"\badd_(\w+)Servicer_to_server\s*\(")
_PY_STUB = re.compile(r"pb2_grpc\s*\.\s*(\w+)Stub\s*\(")
_JS_SERVER = re.compile(
    r"\b(?:app|router|server)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['\"`](/[^'\"`]*)['\"`]"
)
_NEST_CONTROLLER = re.compile(r"@Controller\s*\(\s*(?:['\"`]([^'\"`]*)['\"`])?")
_NEST_METHOD = re.compile(r"@(Get|Post|Put|Delete|Patch|All)\s*\(\s*(?:['\"`]([^'\"`]*)['\"`])?\s*\)")
_JS_FETCH = re.compile(r"\bfetch\s*\(\s*['\"`]([^'\"`]+)['\"`]\s*(?:,\s*\{([^}]*)\})?")
_JS_CLIENT = re.compile(
    r"\b(?:axios|http|api|client|request|ky|\$http|this\s*\.\s*\$?http|this\s*\.\s*api)\s*\.\s*"
    r"(get|post|put|delete|patch)\s*(?:<[^>()]*>)?\s*\(\s*['\"`]([^'\"`]+)['\"`]"
)
_GO_HANDLE = re.compile(r"\bHandle(?:Func)?\s*\(\s*\"([^\"]+)\"")
_GO_ROUTER = re.compile(r"\.\s*(GET|POST|PUT|DELETE|PATCH|Any|Get|Post|Put|Delete|Patch)\s*\(\s*\"(/[^\"]*)\"")
_GO_CLIENT = re.compile(r"\bhttp\s*\.\s*(Get|Post|Head)\s*\(\s*\"([^\"]+)\"")
_GO_REQUEST = re.compile(
    r"\bhttp\s*\.\s*NewRequest(?:WithContext)?\s*\(\s*(?:\w+\s*,\s*)?(?:http\s*\.\s*Method(\w+)|\"(\w+)\")"
    r"\s*,\s*\"([^\"]+)\""
)
_GO_REGISTER = re.compile(r"\.\s*Register(\w+)Server\s*\(")
_GO_NEW_CLIENT = re.compile(r"\.\s*New(\w+)Client\s*\(")
_CS_ROUTE = re.compile(r"\[\s*Route\s*\(\s*\"([^\"]*)\"\s*\)\s*\]")
_CS_METHOD = re.compile(r"\[\s*Http(Get|Post|Put|Delete|Patch)\s*(?:\(\s*\"([^\"]*)\"\s*\))?\s*\]")
_CS_CLASS = re.compile(r"\bclass\s+(\w+?)(?:Controller)?\b")
_CS_CLIENT = re.compile(
    r"\.\s*(Get|Post|Put|Delete|Patch)(?:Async|FromJsonAsync|AsJsonAsync|StringAsync)\s*(?:<[^>()]*>)?"
    r"\s*\(\s*\$?\"([^\"]+)\""
)
_SEND_ARGS = re.compile(
    r"\.\s*(?:send|sendDefault|send_and_wait|convertAndSend|syncSend|asyncSend|sendOneWay|produce|publish)"
    r"\s*\(\s*(?:topic\s*=\s*)?[\"']([^\"'\n]{2,120})[\"']"
)


def contract_sites(path: str, text: str) -> list[Site]:
    """Every contract site one production file holds, sorted by line."""
    suffix = _suffix(path)
    if suffix == ".sql" or (suffix == ".xml" and "<mapper" in text):
        return sorted(_table_sites(text, 0, text), key=lambda s: (s.line, s.kind, s.key, s.role))
    if suffix not in JVM + PY + JS + GO + CS:
        return []
    code = _with_strings(path, text)
    found: set[Site] = set()
    if suffix in JVM:
        found |= _jvm_http(code) | _jvm_rpc(code)
    elif suffix in PY:
        found |= _py_http(path, code) | _py_rpc(code)
    elif suffix in JS:
        found |= _js_http(code)
    elif suffix in GO:
        found |= _go_http(code) | _go_rpc(code)
    elif suffix in CS:
        found |= _cs_http(code)
    found |= _topic_sites(code)
    found |= _table_sites(text, 0, text, entities=True)
    return sorted(found, key=lambda s: (s.line, s.kind, s.key, s.role))


def _with_strings(path: str, text: str) -> str:
    """Comments blanked, string literals kept (routes and URLs are strings)."""
    if _suffix(path) in PY:
        return re.sub(r"#[^\n]*", lambda m: " " * len(m[0]), _PY_DOCSTRING.sub(_blank, text))
    return _C_COMMENTS.sub(_keep_strings, text)


_PY_DOCSTRING = re.compile(r"^[ \t]*(?:\"\"\".*?\"\"\"|'''.*?''')", re.DOTALL | re.MULTILINE)


def _http(method: str, raw: str, line: int, role: str, route: bool, hint: str = "") -> Site | None:
    path = normalize_http_path(raw, route=route)
    if path is None:
        return None
    method = method.upper()
    method = method if method in HTTP_METHODS else ANY
    return Site("http", f"{method} {path}", role, line, hint)


def _join(prefix: str, sub: str) -> str:
    return "/".join(part.strip("/") for part in (prefix, sub) if part.strip("/")) or "/"


def _annotation_path(args: str | None) -> str:
    """The path of a mapping annotation: ``value =``/``path =`` or the first positional string."""
    if not args:
        return ""
    named = re.search(r"\b(?:value|path)\s*=\s*\{?\s*\"([^\"]*)\"", args)
    if named:
        return named[1]
    first = re.match(r"\s*\{?\s*\"([^\"]*)\"", args)
    return first[1] if first else ""


def _jvm_http(code: str) -> set[Site]:
    decl = _JVM_TYPE_DECL.search(code)
    head = decl.start() if decl else len(code)
    feign = _FEIGN.search(code) or _REST_CLIENT.search(code)
    role = "consumer" if feign else "provider"
    hint = ""
    prefix = ""
    if feign and feign[1]:
        args = feign[1]
        named = {k or "value": v for k, v in _ANNOTATION_STRING.findall(args)}
        hint = named.get("name") or named.get("value") or named.get("configKey") or ""
        url = named.get("url") or named.get("baseUri") or ""
        if not hint and url:
            hint = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", "", url).split("/", 1)[0].split(":", 1)[0]
        prefix = named.get("path", "")
    for match in _SPRING_MAPPING.finditer(code, 0, head):
        if match[1] == "Request":
            prefix = _join(prefix, _annotation_path(match[2]))
    for match in _JAXRS_PATH.finditer(code, 0, head):
        prefix = _join(prefix, match[1])
    found: set[Site] = set()
    for match in _SPRING_MAPPING.finditer(code, head):
        kind, args = match[1], match[2]
        if kind == "Request":
            verb = re.search(r"RequestMethod\s*\.\s*(\w+)", args or "")
            method = verb[1] if verb else ANY
        else:
            method = kind
        site = _http(method, _join(prefix, _annotation_path(args)), _line(code, match.start()), role, True, hint)
        if site:
            found.add(site)
    bare = _C_NOISE.sub(_blank, code)  # boundaries are searched outside strings
    for match in _JAXRS_METHOD.finditer(code, head):
        sub = _JAXRS_PATH.search(_member_window(code, bare, head, match))
        site = _http(match[1], _join(prefix, sub[1] if sub else ""), _line(code, match.start()), role, True, hint)
        if site:
            found.add(site)
    for match in _REST_TEMPLATE.finditer(code):
        call, url, rest = match[1], match[2], match[3]
        if call == "exchange":
            verb = re.search(r"HttpMethod\s*\.\s*(\w+)", rest)
            method = verb[1] if verb else ANY
        else:
            method = re.match(r"[a-z]+", call)[0]
        site = _http(method, url, _line(code, match.start()), "consumer", False)
        if site:
            found.add(site)
    for match in _WEB_CLIENT.finditer(code):
        site = _http(match[1], match[2], _line(code, match.start()), "consumer", False)
        if site:
            found.add(site)
    return found


_MEMBER_END = re.compile(r"\)\s*(?:throws[^{;]*)?[{;]")


def _member_window(code: str, bare: str, head: int, match: re.Match) -> str:
    """The annotations and signature of the member an annotation belongs to: from the
    previous statement or block boundary to the end of the member's signature
    (``bare`` is ``code`` with strings blanked, so a ``{`` in a route is no boundary)."""
    start = max(bare.rfind(ch, head, match.start()) for ch in ";{}") + 1
    end = _MEMBER_END.search(bare, match.end())
    return code[start: end.start() if end else len(code)]


def _jvm_rpc(code: str) -> set[Site]:
    found: set[Site] = set()
    if _DUBBO_SERVICE.search(code):
        for match in _IMPLEMENTS_LIST.finditer(code):
            for name in match[1].split(","):
                name = re.sub(r"<.*", "", name).strip().rsplit(".", 1)[-1]
                if name:
                    found.add(Site("rpc", name, "provider", _line(code, match.start())))
    for match in _DUBBO_REFERENCE.finditer(code):
        found.add(Site("rpc", match[1].rsplit(".", 1)[-1], "consumer", _line(code, match.start())))
    for match in _GRPC_IMPL.finditer(code):
        found.add(Site("rpc", match[1], "provider", _line(code, match.start())))
    for match in _GRPC_STUB.finditer(code):
        found.add(Site("rpc", match[1], "consumer", _line(code, match.start())))
    return found


def _py_http(path: str, code: str) -> set[Site]:
    prefixes = {}
    for match in _PY_PREFIX.finditer(code):
        found = re.search(r"\b(?:prefix|url_prefix)\s*=\s*[rf]?[\"']([^\"']*)[\"']", match[2])
        if found:
            prefixes[match[1]] = found[1]
    out: set[Site] = set()
    for match in _PY_ROUTE.finditer(code):
        owner, verb, route, rest = match[1], match[2], match[3], match[4]
        prefix = prefixes.get(owner.rsplit(".", 1)[-1], "")
        if verb in ("route", "api_route"):
            listed = re.search(r"\bmethods\s*=\s*[\[(]([^\])]*)[\])]", rest)
            methods = re.findall(r"[\"'](\w+)[\"']", listed[1]) if listed else ["GET"]
        elif verb == "websocket":
            methods = [ANY]
        else:
            methods = [verb]
        for method in methods:
            site = _http(method, _join(prefix, route), _line(code, match.start()), "provider", True)
            if site:
                out.add(site)
    if path.rsplit("/", 1)[-1] == "urls.py":
        for match in _PY_DJANGO.finditer(code):
            site = _http(ANY, match[2], _line(code, match.start()), "provider", True)
            if site:
                out.add(site)
    for match in _PY_CLIENT.finditer(code):
        receiver, method, url = match[1], match[2], match[3]
        if receiver.rsplit(".", 1)[-1] in ("app", "router", "blueprint", "bp", "api"):
            continue
        if not re.match(r"(?:https?://|/|\{|%s)", url):
            continue  # a dict or cache key, not a URL
        site = _http(method, url, _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    return out


def _py_rpc(code: str) -> set[Site]:
    found = {Site("rpc", m[1], "provider", _line(code, m.start())) for m in _PY_SERVICER.finditer(code)}
    found |= {Site("rpc", m[1], "consumer", _line(code, m.start())) for m in _PY_STUB.finditer(code)}
    return found


def _js_http(code: str) -> set[Site]:
    out: set[Site] = set()
    for match in _JS_SERVER.finditer(code):
        method = ANY if match[1] == "all" else match[1]
        site = _http(method, match[2], _line(code, match.start()), "provider", True)
        if site:
            out.add(site)
    controller = _NEST_CONTROLLER.search(code)
    if controller:
        prefix = controller[1] or ""
        for match in _NEST_METHOD.finditer(code, controller.end()):
            method = ANY if match[1] == "All" else match[1]
            site = _http(method, _join(prefix, match[2] or ""), _line(code, match.start()), "provider", True)
            if site:
                out.add(site)
    for match in _JS_FETCH.finditer(code):
        verb = re.search(r"\bmethod\s*:\s*['\"`](\w+)['\"`]", match[2] or "")
        site = _http(verb[1] if verb else "GET", match[1], _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    for match in _JS_CLIENT.finditer(code):
        site = _http(match[1], match[2], _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    return out


def _go_http(code: str) -> set[Site]:
    out: set[Site] = set()
    for match in _GO_HANDLE.finditer(code):
        pattern = match[1].strip()
        method, _, route = pattern.rpartition(" ")
        site = _http(method or ANY, route, _line(code, match.start()), "provider", True)
        if site:
            out.add(site)
    for match in _GO_ROUTER.finditer(code):
        method = ANY if match[1] == "Any" else match[1]
        site = _http(method, match[2], _line(code, match.start()), "provider", True)
        if site:
            out.add(site)
    for match in _GO_CLIENT.finditer(code):
        site = _http(match[1], match[2], _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    for match in _GO_REQUEST.finditer(code):
        site = _http(match[1] or match[2], match[3], _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    return out


def _go_rpc(code: str) -> set[Site]:
    found = {Site("rpc", m[1], "provider", _line(code, m.start())) for m in _GO_REGISTER.finditer(code)}
    found |= {Site("rpc", m[1], "consumer", _line(code, m.start())) for m in _GO_NEW_CLIENT.finditer(code)}
    return found


def _cs_http(code: str) -> set[Site]:
    out: set[Site] = set()
    decl = _CS_CLASS.search(code)
    head = decl.start() if decl else len(code)
    prefix = ""
    for match in _CS_ROUTE.finditer(code, 0, head):
        prefix = match[1]
    if decl:
        prefix = re.sub(r"\[controller\]", decl[1], prefix, flags=re.IGNORECASE)
    bare = _C_NOISE.sub(_blank, code)
    for match in _CS_METHOD.finditer(code, head):
        route = _CS_ROUTE.search(_member_window(code, bare, head, match))
        sub = match[2] or (route[1] if route else "")
        site = _http(match[1], _join(prefix, sub), _line(code, match.start()), "provider", True)
        if site:
            out.add(site)
    for match in _CS_CLIENT.finditer(code):
        site = _http(match[1], match[2], _line(code, match.start()), "consumer", False)
        if site:
            out.add(site)
    return out


def _topic_sites(code: str) -> set[Site]:
    found: set[Site] = set()
    for match in _LISTENER_ARGS.finditer(code):
        for key in _LISTENER_KEYS.finditer(match[1]):
            for name in re.findall(r"\"([^\"]+)\"", key[1]):
                found.add(Site("topic", name, "consumer", _line(code, match.start())))
    for match in _PY_CONSUMER.finditer(code):
        name = next(g for g in match.groups() if g)
        found.add(Site("topic", name, "consumer", _line(code, match.start())))
    for match in _SEND_ARGS.finditer(code):
        found.add(Site("topic", match[1], "provider", _line(code, match.start())))
    return found


def _table_sites(sql: str, offset: int, text: str, entities: bool = False) -> set[Site]:
    """Tables a text writes (provider: insert, update, delete, DDL, an entity mapping)
    or only reads (consumer: select, join). In code only SQL string literals count."""
    found: set[Site] = set()
    if entities:
        for match in _TABLE_DECL.finditer(text):
            name = next(g for g in match.groups() if g)
            found.add(Site("table", _table_name(name), "provider", _line(text, match.start())))
        for match in _STRING.finditer(text):
            body = next((g for g in match.groups() if g is not None), "")
            if _SQL_START.match(body):
                start = match.start() + (3 if match[0][:3] in ('"""', "'''") else 1)
                found |= _table_sites(body, start, text)
        return found
    for match in _SQL_TABLE.finditer(sql):
        name = _table_name(match[1])
        if not name or name in _SQL_WORDS or name.startswith(("#", "$")) or len(name) <= 1:
            continue
        keyword = match[0].split()[0].lower()
        before = sql[max(0, match.start() - 12): match.start()].lower()
        writes = keyword in ("into", "update", "table") or (keyword == "from" and re.search(r"\bdelete\s*$", before))
        found.add(Site("table", name, "provider" if writes else "consumer", _line(text, offset + match.start(1))))
    return found
