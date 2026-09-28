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
