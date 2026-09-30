# Repository Knowledge Layer: kernel contract

Implementation contract for `skills/repo-wiki/scripts/`. The product design is
[repository-knowledge-layer.md](repository-knowledge-layer.md) (referred to as
"design §N"). This file fixes module boundaries, data shapes and CLI output so
modules can be built and tested independently. Where the two disagree, this file
wins for code and the design wins for intent; report the conflict.

Runtime: Python 3.12+, `uv run`, dependencies PyYAML and psycopg (db extension
only). No pydantic. Standard library otherwise. All git access goes through
`_git.py`. Every function takes an explicit `Workspace`; nothing reads cwd except
`okf.py`.

## Module map

| Module | Owns | Depends on |
|---|---|---|
| `_files.py` | `atomic_text`, `atomic_json`, `normalize_newlines`, `text_lines` | — |
| `_frontmatter.py` | safe YAML frontmatter parse/render (kept) | yaml |
| `_markdown.py` | fence-aware body structure: sections, links, footnote refs/defs (code spans excluded), tables, todo blocks, hints, prose lines | — |
| `_diagram.py` | basic Mermaid structure check | `_markdown` |
| `_git.py` | every git subprocess call | — |
| `_config.py` | `Workspace`, `Source`, config load/init, hub-source detection, locator parse, path resolve, compiled globs | `_git`, yaml |
| `_page.py` | `Page` model, page discovery, roles, derived page paths, canon, canon table parsing, templates, `new_page`, `mark_draft`, frontmatter writing | `_config`, `_frontmatter`, `_markdown` (`_scan`, `_code` lazily for contract claims) |
| `_code.py` | code structure over blob text: trigger rules, import resolution (`Imports`), named resources (topics, tables), contract sites (`contract_sites`) and contract id normalization | — |
| `_scan.py` | deterministic repository facts, `modules()`, `triggers()`, `contracts()` | `_code`, `_config`, `_git` |
| `_validate.py` | every rule in design §7.3, `Issue`, `Facts` (HEAD facts shared with status, stamp and impact) | all above |
| `_review.py` | subject digest, `_review.json` schema and checks | `_page`, `_config` |
| `_stamp.py` | stamp, derived files (indexes, `log.md`, System map), `log_entries`, `verify`, `pointer` | `_page`, `_review`, `_validate`, `_scan` |
| `_impact.py` | `impact`, `impact_files`, `update` | `_page`, `_git`, `_scan` |
| `_status.py` | phase derivation | all above |
| `_db.py`, `_dbpages.py` | OpenGauss capture and Schema/Table page rendering | `_page` |
| `okf.py` | argparse CLI, JSON emit, exit codes | all |

## Shared types

```python
# _config.py
@dataclass(frozen=True)
class Source:
    name: str          # "." for a single repository; directory name in a hub
    path: Path         # absolute repository root of this source
    prefix: str        # "" for single; "api/" in a hub

@dataclass(frozen=True)
class Workspace:
    root: Path         # absolute git toplevel of cwd (the repo, or the hub repo)
    wiki: Path         # absolute wiki directory (contains repo-wiki.yaml)
    wiki_rel: str      # posix path of wiki relative to root, e.g. "docs/wiki"
    lang: str          # "en" | "zh"
    hub: bool
    sources: tuple[Source, ...]
    databases: tuple[Database, ...] = ()   # repo-wiki.yaml `databases`, in file order
    def database(self, name: str) -> Database   # ConfigError naming the configured ones

@dataclass(frozen=True)
class SchemaRule:
    name: str                        # schema name or glob (tenant_*)
    include: tuple[str, ...] = ("*",)  # table name globs; t_order* = starts with, *_log = ends with
    exclude: tuple[str, ...] = ()
    def matches_schema(self, schema: str) -> bool
    def includes(self, table: str) -> bool   # some include glob matches
    def takes(self, table: str) -> bool      # includes and no exclude glob matches

@dataclass(frozen=True)
class Database:
    name: str                  # [A-Za-z0-9][A-Za-z0-9._-]*; wiki directory databases/<name>/
    url_env: str               # variable name ([A-Za-z_][A-Za-z0-9_]*), never a URL
    repos: tuple[str, ...]     # hub: bound sources (required, non-empty); single repository: (".",)
    schemas: tuple[SchemaRule, ...]   # default (SchemaRule("public"),)

class ConfigError(Exception): ...          # message is user-facing, includes the fix
class NotInitialized(ConfigError): ...     # no wiki configured here: status reports phase init

def load(root: Path, wiki: str | None = None) -> Workspace
def init(root: Path, wiki: str = "docs/wiki", lang: str = "en",
         hub_sources: list[str] | None = None, create_canon: bool = True) -> Workspace
```

- `repo-wiki.yaml` keys: `lang`, `sources` (hub), `databases`. A database
  entry takes only `name`, `url_env`, `repos` and `schemas`; a `schemas` item is
  a name or `{name, include, exclude}` (each a non-empty list of globs or one
  string). Globs use `fnmatch.fnmatchcase`. Every problem is a `ConfigError`
  naming the entry and the fix: an unknown key (a `url` key is refused with
  "never a URL"), a `url_env` that is not a variable name, a duplicate database
  or schema, `repos` in a single repository, missing `repos` or a `repos` entry
  that is not a source in a hub, and a YAML alias error (an unquoted `*_bak`)
  gets a hint to quote globs. The relation is many-to-many: a repository
  usually uses one database, one database may serve several repositories.
- `load` requires `root` to be a git toplevel. Without `wiki`, it finds the
  unique `repo-wiki.yaml` among `git ls-files --cached --others
  --exclude-standard` of `root` (so ignored hub sources are skipped). Zero →
  `NotInitialized("... run okf init")`, except when `root` is a configured source
  of an enclosing hub (`enclosing_hub(root) -> Path | None`): then a plain
  `ConfigError` names the hub root, status reports `blocked`, and `init` refuses
  too, so no second wiki is created inside a source. Several →
  `ConfigError("... pass --wiki")`. With `wiki` given but holding no config:
  `ConfigError` naming the configured `repo-wiki.yaml` and the `--wiki` value to
  pass when one exists elsewhere (status `blocked`, as `init` would refuse),
  else `NotInitialized`. Status tells the two apart by type, never by message.
- Config keys: `lang` (required, `en`|`zh`), `sources` (optional list of
  directory names; presence means hub). Unknown keys are an error.
- Hub: every source must be a direct child directory of `root`, a git toplevel
  of its own, and ignored by `root` (`git check-ignore`). `init --hub` appends
  `/<name>/` lines to `root/.gitignore` when missing.
- `init` validates source names, writes the config with `yaml.safe_dump` (names
  such as `on`, `yes` or `1` are quoted) and checks that it reads back
  unchanged before writing anything; `load` reports an unquoted name that YAML
  read as a bool, number or null with the quoting fix.
- `init` creates `<wiki>/repo-wiki.yaml` and, when `create_canon`, the three
  canon stubs through `_page.create_canon(ws) -> list[Page]` (lazy import;
  localized default titles and descriptions from `_page.canon_text(lang, type)`).
  It fails if any config already exists. Every precondition is checked before
  the first write, including a `HEAD` commit in the repository (each source in
  a hub): canon stubs record it as their revision. `init` is atomic: when a
  later step fails it restores `.gitignore`, deletes the files it wrote and
  removes the directories it created (only when empty), then re-raises. The
  `.gitignore` edit (hub) and new files are left uncommitted.

```python
@dataclass(frozen=True)
class Locator:
    path: str                 # workspace-relative posix path
    start: int | None
    end: int | None           # == start for "#L5"
    def text(self) -> str     # canonical "path#Lstart-Lend" / "path#Lstart" / "path"

def parse_locator(text: str) -> Locator            # raises LocatorError(message); also accepts <path>#L..
def definition_locator(text: str) -> tuple[str, str]   # (locator text, note) of a footnote definition
def resolve(ws, path: str) -> tuple[Source, str]    # source + path relative to it; LocatorError if hub path has no source prefix
def glob_match(pattern: str, path: str) -> bool
def glob_regex(pattern: str) -> re.Pattern         # compiled once (cached), matched against "/" + path
def glob_prefix(pattern: str) -> str               # leading literal segments; every match is at or below it
def glob_filter(pattern: str, paths: list[str]) -> list[str]   # matches in a sorted list, narrowed by the prefix via bisect
def is_forbidden(path: str) -> bool                 # secrets: .env* (except .env.example/.sample/.template/.dist), *.pem, *.key, *.p12, *.pfx, *.jks, *.keystore, id_rsa*, id_ed25519*, *.kdbx
```

- Locator grammar: `path(#L<start>(-L<end>)?)?`. `path` is non-empty,
  relative, posix, no `\`, no `:` scheme prefix (`^[A-Za-z][A-Za-z0-9+.-]*:`),
  no empty, `.` or `..` segment, no trailing `/`. `1 <= start <= end`. A path
  containing whitespace is written in angle brackets, `<my app/x.py>#L3-L5`:
  `parse_locator` strips them, and `Locator.text()` adds them back for such a
  path only (Unicode paths without whitespace stay bare). Scan locators,
  `sources` resources and impact suggestions use `text()`.
- Glob: `**` matches zero or more whole segments, `*` and `?` match within one
  segment, `[...]` classes allowed. A pattern without wildcard characters also
  matches every path below it (`src/billing` ≡ `src/billing/**`). Matching is
  case-sensitive on posix paths.

```python
# _git.py  (all raise GitError with stderr on failure; path args are posix)
def toplevel(path: Path) -> Path | None
def head(repo: Path) -> str
def is_clean(repo: Path, exclude: list[str] = ()) -> tuple[bool, list[str]]   # tracked changes only (git status --porcelain --untracked-files=no), minus paths under exclude prefixes
def is_shallow(repo: Path) -> bool                                           # shallow clone (history cut off)
def changed(repo: Path, path: str) -> list[str]                              # uncommitted changes at or below path, untracked included (status's done action)
def ls_files(repo: Path, rev: str | None = None) -> list[str]                 # tracked paths at rev (ls-tree -r --name-only) or index (ls-files)
def rev_exists(repo: Path, rev: str) -> bool
class BlobReader:                         # context manager over `git cat-file --batch`
    def __init__(self, repo: Path): ...
    def read(self, rev: str, path: str) -> bytes | None     # None when missing
    def read_many(self, rev: str, paths: list[str])         # yields (path, bytes | None) in order; requests pipelined by a writer thread
def diff_name_status(repo: Path, old: str, new: str, pathspecs: list[str]) -> list[tuple[str, str, str | None]]
    # (status letter A/M/D/R/T, path, new_path for R) with -M and :(glob) pathspecs; empty pathspec list → whole tree
def grep_files(repo: Path, rev: str, tokens: tuple[str, ...]) -> set[str]    # paths at rev containing any fixed string (git grep -l -I -F); narrows trigger reading
def log_name_only(repo: Path, max_commits: int) -> list[list[str]]            # per commit file lists, newest first
def log_paths(repo: Path, path: str, max_commits: int) -> list[tuple[str, list[str]]]   # (commit, changed paths under path), newest first, --no-renames; [] without a commit
def check_ignore(repo: Path, path: str) -> bool
```

`Workspace.root` for a single repository is the only source (`name="."`,
`prefix=""`). The wiki directory is excluded from cleanliness checks, scanning,
modules and coverage.

## Page model

Pages are every `*.md` under `ws.wiki` except the reserved `index.md` and
`log.md` (at any level; OKF §8, §9) and any file whose name starts with `_`.
Page id = posix path relative to `ws.wiki`.

Line endings: a page is read with CRLF and lone CR normalized to LF (a Windows
`core.autocrlf` checkout parses and hashes like the commit). Every line count
of a page body or a source file uses `_files.text_lines`: split on `\n` only,
one trailing `\r` dropped, never `str.splitlines` (which also breaks at form
feed, U+2028 and other separators git does not count), so locator ranges,
cited-block comparisons and scan locators agree with git. `atomic_text` keeps
an existing file's permission bits and gives a new file `0666 & ~umask`; a
symlink is written through to its target and stays a link (`pointer --write
CLAUDE.md` with `CLAUDE.md -> AGENTS.md` updates `AGENTS.md`); `write_pointer`
refuses (`StampError`) a target whose resolved path lies outside the workspace
root, so a link or `..` never writes or creates a file outside it.

```python
# _page.py
AUTHOR_TYPES = ("Architecture", "Glossary", "Conventions", "Overview", "Module", "Workflow", "Flow")
GENERATED_TYPES = ("Schema", "Table", "Map")
RESERVED_NAMES = ("index.md", "log.md")
MAP = "system-map.md"
ROLE_TYPES = {"glossary": "Glossary", "architecture": "Architecture", "system-architecture": "Architecture",
              "overview": "Overview", "conventions": "Conventions", "system-conventions": "Conventions",
              "module": "Module", "workflow": "Workflow", "flow": "Flow"}
FRONTMATTER_ORDER = ("type","title","description","tags","scope","contracts","status","revision",
                     "sources","generated","verified","stamp","catalogs")   # other keys follow, sorted

@dataclass
class Page:
    path: str                  # "modules/billing.md"
    file: Path
    meta: dict
    body: str
    structure: Structure       # _markdown.extract(body)
    @property type/status/scope/contracts/revision
    front: str                 # file text before the body (LF newlines)
    def content_sha256(self) -> str     # stamp hash, see below
    def file_sha256(self) -> str        # sha256 of the file bytes, CRLF/CR read as LF

def load_pages(ws) -> list[Page]            # sorted by path; frontmatter errors captured, not raised
def load_page(ws, path: str) -> Page
def write_page(page: Page) -> None          # FRONTMATTER_ORDER, atomic
def canon(ws) -> dict[str, tuple[str, str | None]]   # canon path -> (role, source or None), creation order
def role(ws, page) -> str | None            # canon role by path, else by type (see Roles and paths)
def path_source(ws, path) -> str | None     # "." single; the source of sources/<s>/... in a hub; None system level
def page_path(ws, type, name=None, source=None, scope=()) -> str    # the one valid path; PageError names the fix
def path_problem(ws, page) -> str | None    # why the page is not at its derived path (page-path)
def new_page(ws, type, name=None, description=None, scope=(), title=None, source=None, contracts=()) -> Page
    # at page_path; template assets/templates/<lang>/<role>.md; status draft; revision = current HEADs;
    # canon roles get canon_text defaults and refuse a scope; other pages need a description;
    # PageError when a scope glob matches no tracked file at HEAD (wiki excluded), or a contract
    # claim (Flow only) matches no contract (_scan.contracts)
def contract_match(pattern, contract_id) -> bool   # fnmatchcase over _code.normalize_contract_id(pattern)
def canon_text(lang, role, source=None) -> tuple[str, str]
def mark_draft(ws, page: Page, reasons: list[str]) -> None
    # status draft, revision = current HEADs, drop sources/verified/stamp/generated, insert a todo block with reasons after frontmatter
def current_revision(ws) -> dict[str, str]  # {source.name: head}
def tables(page) -> dict[str, list[Table]]  # recognized canon tables by kind
```

A page with unparsable frontmatter is returned with `meta == {}` and an
`error` string, so validation can report it without aborting.

Recognized table kinds, matched on the header row (case-insensitive, trimmed,
en or zh):

| kind | en header | zh header | citation required |
|---|---|---|---|
| `glossary` | Term, Meaning, Avoid, Where | 术语, 定义, 勿用别名, 代码位置 | yes |
| `commands` | Purpose, Command, Status | 用途, 命令, 状态 | yes |
| `rules` | Area, Rule, Enforced by | 类别, 规则, 检查方式 | yes |
| `invariants` | Invariant, Enforced at, Breaks when | 关键约束, 由谁保证, 违反会怎样 | yes |
| `change_guide` | Change, Start at, Also change, Verify | 修改场景, 从这里改, 同步修改, 如何验证 | yes |
| `not_covered` | Path, Reason | 路径, 原因 | no |
| `contracts` | Contract, Provider, Consumers, Change order, Verify | 契约, 提供方, 消费方, 变更顺序, 如何验证 | yes |
| `hops` | Step, Source, Entry, Contract, Next | 步骤, 仓库, 入口, 契约, 下一步 | yes |

`Table(kind, header: list[str], rows: list[Row], line: int)`;
`Row(cells: list[str], line: int, footnotes: list[str])`.
Command `Status` values: `verified`, `not-run`, `failed`. Rule `Area` values:
`layout`, `naming`, `api`, `errors`, `logging`, `config`, `testing`,
`build-ci`, `dependencies`, `vcs` (commit message, pull request and branch
conventions). Extension knowledge is not a rule area: steps to add a new X
are an "adding a new X" section (Conventions, or the owning Module page).
`Enforced by` values: `lint`, `typecheck`, `test`, `ci`, `review`,
`convention`. Values are the same tokens in zh pages. A change guide row's
`Start at` and `Verify` cells must not be empty or `-` (`table-values`);
`Also change` may be `-`. Change guide rows live on Module, Workflow and Flow
pages (`_page.CHANGE_GUIDE_ROLES`, at least one row each, `change-guide`) and,
for cross-module changes, on Architecture and Overview. `contracts` and `hops`
tables belong to a hub only: a contracts row names a source as Provider, a
comma-separated list of sources as Consumers, and non-empty Contract, Change
order and Verify cells; a hops row names a source and a non-empty Entry
(`table-values`). A Contract cell holds one or more contract ids or id globs
separated by `;` (code spans and footnotes stripped), or `-` in a hop that
crosses no source.

Todo block: `<!-- okf:todo` up to the next `-->`, may span lines; outside
fences. `Structure.todos: list[tuple[int, str]]` (line, text). Hint:
`<!-- okf:hint` up to the next `-->`, the template's guidance for a section;
`Structure.hints: list[tuple[int, str]]` (line, text). Every other HTML
comment is ignored.

### Roles and paths

A page's **role** decides its path, template (`assets/templates/<lang>/<role>.md`),
required sections and canon tables. A canon page's role comes from its path
(`_page.canon(ws)`); a body page's role is its type in lower case.

| role | type | single repository | hub | required headings (en / zh) | canon tables |
|---|---|---|---|---|---|
| glossary | Glossary | `glossary.md` | `glossary.md` | none | glossary |
| architecture | Architecture | `architecture.md` | — | Structure / 整体结构; Not covered / 未单独成页 | not_covered |
| system-architecture | Architecture | — | `architecture.md` | Structure / 整体结构; Contracts / 跨仓契约; Not covered / 未单独成页 | contracts, not_covered |
| overview | Overview | — | `sources/<s>/overview.md` | Structure / 整体结构; Not covered / 未单独成页 | not_covered |
| conventions | Conventions | `conventions.md` | `sources/<s>/conventions.md` | Commands / 常用命令; Rules / 开发规则 | commands, rules |
| system-conventions | Conventions | — | `conventions.md` | Rules / 开发规则 | rules |
| module | Module | `modules/<name>.md` | `sources/<s>/modules/<name>.md` | Responsibility / 模块职责; How it works / 工作原理; Making changes / 修改指南 | — |
| workflow | Workflow | `workflows/<name>.md` | `sources/<s>/workflows/<name>.md` | Flow / 执行流程; Making changes / 修改指南 | — |
| flow | Flow | — | `flows/<name>.md` | Call chain / 跨仓调用链; Making changes / 修改指南 | — |

Generated pages: Schema and Table under `databases/` (db extension), Map at
`system-map.md` (hub, written by stamp).

`page_path` rules: a name is one path segment without whitespace, not
`index`, `log` or `_`-prefixed (`.md` optional). A hub Module or Workflow page's
scope stays in one source: every glob starts with the same source name
(`--source`, when given, must agree). A Flow page's scope spans two or more
sources, every glob starting with a source name; Flow and Overview pages do not
exist in a single repository. Canon roles take no scope. Required headings:
a heading of any level whose text equals the en or zh title
(case-insensitive, whitespace collapsed); every other heading is the writer's
choice.

Footnote definition grammar: `[^label]: <locator>( <note>)?`. The locator is
the first whitespace-separated token, or a leading `<path with spaces>#L..`
(`_config.definition_locator`, the one parser shared by validate, sources,
impact, eval_citations and eval_canon). The label is
`[A-Za-z0-9][A-Za-z0-9._-]*`. `sources` are derived as
`[{"id": label, "resource": locator}]` in first-reference order.

Author frontmatter:

| key | rule |
|---|---|
| `type` | one of AUTHOR_TYPES (GENERATED_TYPES only from the db extension and stamp) |
| `title`, `description` | non-empty strings |
| `tags` | optional list of strings |
| `scope` | list of globs; non-empty for Module, Workflow and Flow; empty for canon roles |
| `contracts` | hub only, on a Flow page or the system Architecture page: list of contract ids or id globs the page claims |
| `status` | `draft` or `stable` |
| `revision` | map source name → 40-hex commit; keys == all source names |

Kernel keys written by stamp: `sources`, `generated: {by, at}`,
`verified: [{by, at}]` (optional), `stamp: {content_sha256, reviewed_by}`
(`reviewed_by` is the approving reviewer, null for `--unreviewed`), and `catalogs`
(`{generated page path: catalog_sha256}` for every linked Schema/Table page, so
impact can report `catalog-changed`). `at` is UTC ISO 8601
with `Z`.

`content_sha256` = sha256 of sorted compact JSON of
`{"body": <body, LF newlines>, "meta": <every frontmatter key except status,
sources, verified and stamp>, "reviewed_by": <stamp.reviewed_by>}`. It
therefore covers the approving reviewer and the author keys (`type`,
`title`, `description`, `tags`, `scope`, `contracts`), `revision`, `generated` and
`catalogs`: hand-editing `revision` to HEAD or a `catalogs` hash would
otherwise silence impact. `status` is left out because setting `draft` is the
legitimate way to edit a stable page, `sources` is derived and join-checked
against the footnotes, and `verified` is appended by `okf verify`. `verified`
is checked instead: it must be a list of `{by, at}` entries that starts with
`stamp.reviewed_by` when that is set and continues only with `human:<id>`
actors dated at or after `generated.at`; anything else (a bot entry added by
hand to an `--unreviewed` stamp, a removed reviewer entry) is `unreviewed-edit`. Generated Schema/Table pages carry `catalog_sha256` and no
`revision`/`scope` requirement; the generated Map page carries neither.

## Issues

```python
@dataclass(frozen=True)
class Issue:
    code: str
    severity: str        # "error" | "warning" | "pending" (unfinished work: a todo block)
    page: str | None
    line: int | None
    message: str
    fix: str             # one actionable sentence
def validate(ws, pages=None, *, only: list[str] | None = None, facts: Facts | None = None) -> list[Issue]   # sorted by (page, line, code)
```

Rule codes, severities and semantics are exactly design §7.3, plus:

- Severity `pending` marks unfinished work rather than a defect: the `todo`
  issue of every todo block and the `hint` issue of every template hint left
  in a page. Pending issues block stamp like errors, count under `pending` in
  status and validate, and do not fail `validate` (exit 0).
- `section` (error): a page lacks a required section of its role (see Roles
  and paths); the message names the en and zh heading.
- `page-path` (error): an author page is not at the path `page_path` derives
  from its type, name (file stem), source and scope, or its scope cannot place
  it (a Module or Workflow scope spanning sources or starting with a wildcard
  in a hub, a Flow scope inside one source, a Flow or Overview page in a single
  repository); a Map page anywhere but `system-map.md` of a hub.
- `db-binding` (warning, hub only): a page whose scope globs all start with
  source names links a generated database page whose `db.repos` shares none of
  those sources.
- `change-guide` (error): a Module, Workflow or Flow page without a todo block
  has no change guide row.
- `flow-hops` (error): a Flow page without a todo block has no call chain row,
  or no mermaid block starting with `sequenceDiagram`.

- `config` (error): config or hub problems surfaced as issues by status.
- `canon-missing` (error): a canon page (`_page.canon(ws)`) is absent,
  unparsable or of the wrong type; the fix is `okf new --type T [--source S]`.
- `canon-table` (error): a canon page lacks a table of its role
  (`_page.CANON_TABLES`).
- `canon-empty` (warning): a required canon table other than Not covered and
  Contracts has no rows.
- `index`, `log`, `map` (error only when no draft page exists): a derived file
  (every `index.md`, `log.md`, `system-map.md`) differs from its rendering, is
  missing, or is stale (an `index.md` in a directory that no longer gets one).
- `index-size` (warning, only when no draft page exists): a rendered index is
  longer than `_stamp.INDEX_MAX_LINES` (150) lines.
- `not-covered` (error): a Not covered row whose path matches no tracked file,
  or with an empty reason; in a hub, a row on a source's overview whose path
  lies outside that source.
- `coverage`, `trigger-coverage` (error, on `architecture.md` in a single
  repository, on `sources/<s>/overview.md` of the module's or file's source in
  a hub): a module in no page scope and no Not covered row; a trigger file (see
  Scan) that no Workflow or Flow page scope matches and no Not covered row with
  a reason matches (`glob_match`, so a row may be a path, a directory or a
  glob). One issue per module or file, naming its trigger kinds.
- `link-coverage` (error, hub, on `architecture.md`): a contract (not external)
  that no page's `contracts` claims and no Not covered row (on any Architecture
  or Overview page) excludes by matching one of its site files. One issue per
  contract, naming its sites.
- `contract-claim` (error): a `contracts` entry that matches no contract at HEAD.
- `contract-row` (error, only without a todo block): a contract a page claims
  is named by no Contract cell of its table: the Contracts table of the system
  Architecture page, the call chain table of a Flow page.
- `contract-unknown` (warning): a Contract cell that names no contract at HEAD.
- `orphan` (warning): a Module, Workflow or Flow page that no other author page
  links to (the indexes do not count).
- `unreviewed-edit` (error): a stable page whose `content_sha256` differs from
  `stamp.content_sha256` (body, stamped frontmatter or `stamp.reviewed_by`
  edited after stamp), or whose `verified` list is not the one stamp and
  `okf verify` wrote (see Page model). `_validate.stamped(page)` is false for
  such a page, so `verify` and the pointer refuse it too.
- `secret` scans the frontmatter lines (copied into `index.md`) as well as the
  body; the issue line is the file line.

A link to `/system-map.md` in a hub is valid before the first stamp writes it.

Locators are checked against the page's `revision` (draft pages: must equal
HEAD, which the `revision` rule enforces; if it does not, locator checks run at
the recorded revision anyway). Blobs are read with one `BlobReader` per source.

`Facts(ws)` holds the HEAD facts of one command and is shared by validate,
status, stamp and impact: HEADs, the tracked listing of each source (one
`ls-tree` per source, also handed to `_scan.modules` and `_scan.triggers`),
modules, each file's owning module, the triggers (one `git grep -F` per source
over `_code.TRIGGER_TOKENS`, then only the matching files are read), glob matches (`glob_filter`, cached per glob), `rev_exists` and
`current` per (source, revision), and `changes(source, rev)`: one whole-tree
`git diff --name-status -M rev HEAD` per distinct revision, wiki paths dropped
in a single repository. Git calls therefore grow with sources and distinct
revisions, never with pages, citations or files × globs. In a hub,
`Facts.contracts` is `_scan.contracts` at HEAD, derived once per command.

Coverage is by ownership: a file belongs to its deepest module, and a module is
covered when a page scope matches at least one file it owns. A scope inside a
nested module covers that module, not its parent. Trigger coverage is by file:
`_validate.unclaimed_triggers(facts, pages)` lists `(path, kinds)` for every
trigger file outside all Workflow and Flow scopes and Not covered rows;
validate, status and impact share it, as they share
`_validate.claimed_contracts(ws, facts, page)` and
`_validate.unclaimed_contracts(ws, facts, pages)`. Not covered rows are read
from every Architecture and Overview page; `_validate.coverage_page(ws, path)`
names the page that answers for a module or trigger file.

## Scan

```python
def scan(ws) -> dict        # the JSON document below; deterministic for a given HEAD
def modules(ws, heads=None, listings=None) -> list[Module]   # Module(path: str, source: str, manifest: str | None)
def triggers(ws, heads=None, listings=None) -> list[Trigger] # Trigger(path: str, line: int, kind: str), sorted by path, line, kind
def contracts(ws, heads=None, listings=None) -> list[Contract]   # hub only ([] in a single repository), sorted: internal by id, then external
def owner(path: str, modules) -> str | None     # deepest module directory containing path ("." when that is a module)
def is_test_path(rel: str) -> bool              # the test-path rule, on a source-relative path
```

```json
{
  "sources": [{"name": ".", "head": "<sha>", "clean": true, "dirty": [], "shallow": false}],
  "modules": [{"path": "src/billing", "source": ".", "manifest": "pyproject.toml", "files": 12, "languages": {"Python": 12}, "triggers": 2}],
  "triggers": [{"path": "src/billing/api.py", "module": "src/billing", "kinds": ["http"], "count": 3, "locator": "src/billing/api.py#L12"}],
  "deps": [{"from": "src/billing", "to": "src/payments", "count": 4, "locator": "src/billing/run.py#L1", "mutual": false}],
  "central": [{"path": "src/core/money.py", "module": "src/core", "modules": 3, "imports": 9}],
  "resources": [{"kind": "topic", "name": "invoice-posted", "modules": ["src/billing", "src/ledger"],
                 "locators": ["src/billing/post.py#L30", "src/ledger/consumer.py#L8"]}],
  "entry_points": ["src/app/main.py", "tools/sync.py"],
  "commands": [{"name": "test", "command": "uv run pytest -q", "kind": "test", "locator": "Makefile#L4", "cwd": "."},
               {"name": "verify", "command": "./mvnw -q verify", "kind": "build", "locator": "pom.xml#L41", "cwd": "."},
               {"name": "build", "command": "pnpm run build", "kind": "build", "locator": "web/package.json#L6", "cwd": "web"},
               {"name": "run_e2e", "command": "uv run evals/run_e2e.py", "kind": "test", "locator": "evals/run_e2e.py#L2", "cwd": "."}],
  "ci": [{"file": ".github/workflows/qa.yml", "steps": [{"name": "Unit tests", "run": "pytest -q", "locator": ".github/workflows/qa.yml#L20"},
                                                        {"name": "ci", "run": "uses org/shared/.github/workflows/ci.yml@main", "locator": ".github/workflows/qa.yml#L30"}]}],
  "configs": [{"kind": "lint", "path": "ruff.toml"}],
  "tests": {"dirs": ["tests"], "patterns": ["test_*.py"]},
  "docs": ["README.md", "docs/adr/0001-x.md"],
  "terms": [{"term": "BillingRun", "kind": "camel", "count": 7, "locator": "src/billing/run.py#L12"},
            {"term": "InvoiceState", "kind": "state", "count": 9, "locator": "src/billing/state.py#L3", "members": ["DRAFT", "POSTED"]}],
  "co_change": [{"a": "src/a.py", "b": "tests/test_a.py", "support": 5, "confidence": 0.83}],
  "contracts": [{"id": "http POST /reservations/{}", "kind": "http",
                 "providers": [{"source": "worker", "locator": "worker/src/Res.java#L4"}],
                 "consumers": [{"source": "api", "locator": "api/src/InventoryClient.java#L4"}]},
                {"id": "http POST /v1/charges", "kind": "http", "providers": [],
                 "consumers": [{"source": "web", "locator": "web/src/api.ts#L2"}], "external": true}],
  "truncated": {"commands": "80 of 97 commands shown, shallowest first; read the build files of the module you need"}
}
```

Test-path rule (`is_test_path`, the one definition every scan fact uses): a path
is test code, test data or a test double when

- a directory above it is a test root: `tests`, `test`, `spec`, `specs`,
  `__tests__`, `e2e`, `testing` (any case), a name ending in a separator plus
  `test(s)` optionally after `unit`/`integration`/`functional`/`e2e`
  (`api-tests`, `Foo.Tests`, `Foo.UnitTests`), or a camelCase name ending in
  `Test(s)` (`src/integrationTest`, `MyAppTests`);
- or a directory above it is test support: `testdata`, `test-data`, `test_data`,
  `fixture(s)`, `__fixtures__`, `__mocks__`, `__snapshots__`;
- or its file name is `conftest.py` or follows a runner convention: `test_*`;
  `*_test`, `*.test`, `*-test`, `*_spec`, `*.spec`, `*-spec` before the suffix;
  `*Test`, `*Tests`, `*IT` after a lowercase letter or digit; `*Spec` so in
  Groovy, Scala and Kotlin only (Java `KeySpec` types are production code).

Directories are read only down to a `src/main` source set: code below it is
production code even in a package named `test`. A word that merely contains
"test" (`latest.py`, `contest/`, `attestation.py`, `Testimonial.java`,
`testing_utils.py`) is not a test path, and neither is a `Test` prefix alone
(`TestResource.java` can be a production endpoint).

Module rule (design §6 phase 1): manifest-declared modules (npm/pnpm/yarn
workspaces, Cargo workspace members, `go.work` or nested `go.mod`, Maven
`<modules>` recursively, Gradle `settings.gradle(.kts)` includes, uv workspace
members) union the top-level directories that contain at least one tracked code
file and no manifest module, with two refinements:

- A top-level test root or test-support directory (the test-path rule) is not
  a module: it needs neither a page scope nor a
  Not covered row, and its files have no owning module.
- A top-level code root (`src`, `lib`, `app`, `pkg`, `internal`, `packages`,
  `source`, `cmd`) without its own manifest and without declared modules below
  it is split: each child directory holding code (hidden, test-root and
  test-support names excluded) is a module (`src/billing`, `src/payments`), and the code root
  itself stays a module only when it has code files directly in it. A code
  root with a `main` child (the Maven/Gradle source sets `src/main`,
  `src/test`) stays one module.

Package modules: inside every module found so far, a base is followed down
while it holds exactly one child directory and no code of its own: each JVM
source set `src/main/{java,kotlin,scala,groovy}` (or `main/<lang>` when the
module is itself a `src` directory), and the module directory when it is a
Python package or holds Python packages (`__init__.py`; the descent stops at a
directory without one). When that base then holds two or more child
directories (not hidden, `_`-prefixed or test-named, and for Python each a
package) with at least `PACKAGE_MIN_FILES` (3) production code files each, every
such child becomes a module (`src/main/java/com/acme/shop/order`,
`src/shop/billing`) with the manifest of the module it split; test code and the
remaining files stay with that module. One level is split, never deeper.

A declared module that contains another module and
owns no code file itself (a Maven packaging parent) is dropped; its children
stay (checked again after the package split). `manifest` names the nearest manifest that owns the module: its own
manifest file (`MANIFESTS` in its directory), else the manifest that declared
it, else, for a code root or a directory in one, the nearest parent manifest
when that parent declares no modules (a single build such as a Maven
project's `src/` or a Python src layout); otherwise null. Hidden directories and the wiki directory are excluded. In a
hub, paths carry the source prefix; a source with no module becomes one module
(`api`). `files` and `languages` count each file once, for its deepest module.

Commands: `cwd` is the directory a command runs from, relative to the root of
the source its locator names (`.` for that root), computed by
`_scan.command_cwd(rel, command)`: the directory of the file the locator names,
or the source root when the command names that file by its source-root path (a
token equal to it, as in `uv run evals/run_e2e.py`). `eval_canon.py
--run-commands` re-derives the same `cwd` from the file a wiki command row
cites. `kind` is `build`, `test`, `lint`, `format`, `typecheck` or `other` (from the
name's words, then the command's). Declared commands come from Makefile,
justfile, Taskfile, tox and nox, poe/pdm tasks and `package.json` scripts; a
script's command is `<runner> run <name>` with the runner from `packageManager`
or the nearest lock (pnpm, yarn, bun, else npm). Build-tool commands follow each
tool's conventions, located at the defining line:

| tool | build files | commands |
|---|---|---|
| Maven | every `pom.xml` no other pom lists in `<modules>` | `mvn -q test`, `mvn -q verify` (`./mvnw` when tracked beside it) at the project's own `<build>` or `<project>` line; `verify -P<id>` per profile when there are at most 3; `spotless:check`, `checkstyle:check`, `spotbugs:check`, `pmd:check` for a declared plugin |
| Gradle | outermost `settings.gradle(.kts)` or `build.gradle(.kts)` | `./gradlew test`, `./gradlew build` (`gradle` without a wrapper); `spotlessCheck`, `checkstyleMain` for an applied plugin; every task registered (`tasks.register`, `task x`, `by tasks.registering`) in the root project or an included one (`build.gradle(.kts)` or `<dir>.gradle(.kts)`), run through the relative wrapper (`../gradlew x`) |
| Cargo | outermost `Cargo.toml` | `cargo build`, `cargo test`; `cargo clippy --all-targets` with `clippy.toml` or a clippy lints table; `cargo fmt --check` with `rustfmt.toml` |
| Go | every `go.mod` | `go test ./...`, `go vet ./...`; `golangci-lint run` with a `.golangci.*` beside it |
| Python | `pyproject.toml`, `ruff.toml`, `pytest.ini`, `mypy.ini`, `pyrightconfig.json`, `.flake8`, `setup.cfg`, `tox.ini` | `pytest`, `ruff check .`, `ruff format --check .`, `mypy` (`mypy .` without `files`), `pyright`, `black --check .`, `isort --check-only .`, `flake8` for a tool table, ini section or dev dependency; `tox -e <env>` per `[tool.tox.env.<env>]`; prefixed `uv run`, `poetry run` or `pdm run` by the nearest lock |
| .NET | every `*.sln`/`*.slnx`, else outermost `*.csproj`/`*.fsproj`/`*.vbproj` | `dotnet build`, `dotnet test` |
| CMake | outermost `CMakeLists.txt` | `cmake -S . -B build`, `cmake --build build`; `ctest --test-dir build` with `enable_testing()` or `include(CTest)` |

Build files that are test paths, or lie under `src/`, example, sample,
vendored, generated or `buildSrc` directories, are skipped. A build-tool command already declared in the
same directory is left out; CI steps are reported as they are, never as commands.
A Python file with PEP 723 inline metadata (a `# /// script` line) is the
command `uv run <path>` (source-relative path, shell-quoted when needed, `cwd`
`.`; the locator is the `# /// script` line), named after the file stem, with `kind`
from the stem and `test` for a test or `eval`/`evals` path.

Other facts: `entry_points` are declared scripts (`pyproject`, `package.json`),
conventional file names, JVM files with a `main` method in code (comments and
strings stripped) and Python files with a top-level
`if __name__ == "__main__":`, neither in a test path, and specs (`Dockerfile`, OpenAPI/AsyncAPI, `web.xml`).
`docs` lists README, CONTRIBUTING, CHANGELOG, ARCHITECTURE, CONTEXT, GLOSSARY,
TERMS and DESIGN files (any directory, a doc suffix or none), AGENTS.md,
CLAUDE.md, pull request templates, and Markdown under `docs/` or an `adr`
directory. A file under a `templates` or `assets` directory (any depth, any
case) is a page skeleton or bundled copy, never a doc, and a Markdown/reST file
there is not read for terms. A file is generated (skipped for terms and entry points) when a
line in its first 2 KiB starts like a comment (`#`, `//`, `/*`, `*`, `<!--`,
`--`, `;`, `@`, a docstring quote) and says "generated by", "generated file"
or "do not edit"; prose mentioning generation does not count. CI
`run` is the first command of the script (comments and `set -e` style lines
skipped, `\` continuations joined, at most 200 characters); a job that calls a
reusable workflow is one step `uses <ref>`. `tests.dirs` are the outermost
test roots of code files (test-support directories are not listed);
`tests.patterns` are the file-name conventions of the test-path rule seen on
code files, plus `Test*` for a `TestFoo` file inside a test root; `.sql` and
shell files give no test pattern.
Terms are read in one pipelined pass over code and doc blobs;
test files (the test-path rule) add no candidate of any kind and do not count
toward any kind's minimum (file counts, top-level directories):
`defined`, `state`
(an enum-like type with its first 8 `members`; members are not terms) and
`camel` (defined type names in 3+ files and 2+ top-level directories); each
kind gets a third of the limit before the rest is filled in kind order.
All-caps abbreviations are not candidates.

- `defined`: a bold term followed by `:`, `：`, a dash or ` is ` (or `**Term:**`)
  in a Markdown/reST doc. Bold that opens a bulleted or numbered list item
  (`- **Performance:** ...`) is skipped. A definition-list entry is bold at
  the start of a line with the definition after it on the same or the next
  line. When a term is defined in several places, the locator prefers a
  glossary-named file (stem GLOSSARY, TERMS, TERMINOLOGY or CONTEXT, or a name
  containing "glossary"), then a definition-list entry, then the first seen.
  Defined terms rank by the same order, then by count. `count` is the number
  of docs containing every word of the term; a term with CJK characters counts
  its substring occurrences across the docs instead.

Triggers (`_code.triggers_in`, rules in `_code.TRIGGER_RULES`) are found in
production code only (not test paths, generated paths or generated files), on
text whose comments are blanked (and string literals too in Java, Kotlin,
Scala, Groovy and C#; docstrings in Python):

| kind | JVM | Python | JS/TS | Go, C# |
|---|---|---|---|---|
| `http` | `@RestController`, `@Controller`, `@*Mapping`, JAX-RS `@Path(` | `@x.get/post/put/delete/patch/route/api_route/websocket(`, DRF/Flask view classes, `path(`/`re_path(`/`url(` in `urls.py` | NestJS `@Controller(`/`@Get(`..., `app/router/server/api.get('/…'` | `http.HandleFunc(`, `.GET("/…"`; `[ApiController]`, `[HttpGet]`, `: ControllerBase` |
| `rpc` | `@DubboService`, `@GrpcService`, `extends …ImplBase` | `add_*Servicer_to_server(` | | |
| `listener` | `@KafkaListener`, `@RabbitListener`, `@RabbitHandler`, `@JmsListener`, `@SqsListener`, `@StreamListener`, `@RocketMQMessageListener`, `@PulsarListener`, `implements RocketMQListener` | `@x.agent/subscriber/consumer/subscribe(` | `@EventPattern(`, `@MessagePattern(`, `@Processor(` | |
| `job` | `@Scheduled`, `@Schedules`, `@XxlJob`, `extends QuartzJobBean`, `implements Job/StatefulJob/SimpleJob/DataflowJob` | `@task`, `@shared_task`, `@periodic_task`, `@scheduled_job`, `@dag`, `@flow` (optionally qualified), `DAG(` | `@Cron(`, `@Interval(`, `@Timeout(` | `.AddFunc(`; `: BackgroundService`, `: IHostedService` |
| `event` | `@EventListener`, `@TransactionalEventListener` | `@receiver(` | `@OnEvent(` | |
| `cli` | | `class Command(BaseCommand)`, `@x.command(`/`@x.group(` | | |
| `startup` | `implements CommandLineRunner/ApplicationRunner` | | | |

A JVM file with `@FeignClient` or `@RegisterRestClient` declares outbound calls:
its `http` hits are dropped. `triggers` in the scan lists one entry per file
(`kinds` in the order above, `count` of trigger lines, `locator` of the first),
sorted by module then path; `modules[].triggers` counts trigger files per
module.

`deps` and `central` come from `_code.Imports` over every production code file
of every source (hub sources resolve into each other): Java/Kotlin/Scala/Groovy
`import` (a class by `package` plus file stem; static imports by their class;
`pkg.*` to one file of the package), Python `import`/`from` (absolute names
resolved from each source root, its `src`, and the parent of every top-level
package; relative imports by path), JS/TS relative specifiers (with extension
and `index` probing) and workspace package names (`package.json` `name`, to
that manifest), Go import paths under a `go.mod` `module`. An edge is counted
once per import statement between different owning modules; `locator` is the
first statement (by path, line); `mutual` marks module pairs importing each
other. Sorted by count descending, then from, to. `central` lists imported
files with importers in two or more other modules, by importer modules, then
import statements.

`resources` (`_code.resources_in`) names `topic`s from listener annotation
attributes (`topics`, `topic`, `queues`, `destination`, `value`,
`topicPattern`), `KafkaConsumer(`/`.subscribe(` and send-style calls with a
literal first argument (`send`, `sendDefault`, `send_and_wait`,
`convertAndSend`, `syncSend`, `asyncSend`, `sendOneWay`, `produce`, `publish`),
and `table`s from `@Table(name=…)`, `@TableName(…)`, `__tablename__`,
`db_table`, `.sql` files, MyBatis mapper XML (`<mapper`) and string literals
that start with a SQL verb (`from`/`join`/`into`/`update`/`table` targets,
schema and quotes stripped, lowercased, SQL words dropped). Only names found in
two or more modules are listed, with the first site per module, most modules
first.

Contracts (hub only; `_code.contract_sites` over production code, SQL and
mapper XML, `_scan._library_sites` over manifests; test, generated, example,
sample, vendored and `testdata` paths skipped). A site is `(kind, key, role,
line, hint)`; roles are `provider` and `consumer`. Comments are blanked and
strings kept, so a route in a Javadoc is no site.

| kind | provider sites | consumer sites | key |
|---|---|---|---|
| `http` | Spring `@*Mapping` (class `@RequestMapping` prefix; `method = RequestMethod.X`), JAX-RS `@Path` with `@GET`…, FastAPI/Flask decorators (`APIRouter(prefix=)`, `Blueprint(url_prefix=)`, `methods=[...]`), Django `path`/`re_path`/`url` in `urls.py` (ANY), Express `app`/`router`/`server`.verb, NestJS `@Controller` + `@Get`…, Go `HandleFunc("METHOD /p")`/`.GET("/p")`/chi `.Get("/p")`, ASP.NET `[Route]` + `[HttpGet]` (`[controller]` replaced); a mapping interface without a client annotation provides | Feign `@FeignClient(name|path|url)` and `@RegisterRestClient` mapping interfaces (hint: name or URL host), RestTemplate `getForObject`… (`exchange` reads `HttpMethod.X`), WebClient `.verb().uri(...)`, Python `requests`/`httpx`/`client`.verb with a URL-like literal, `fetch` (method option), `axios`/`http`/`api`/`client`.verb, Go `http.Get`/`NewRequest`, C# `GetAsync`… | `METHOD /path`: host, query and a leading base placeholder dropped, parameters (`{x}`, `:x`, `<x>`, `${x}`, `%s`) as `{}`, lowercase, no trailing slash; ANY when unknown |
| `rpc` | `@DubboService` class `implements X`, `extends XGrpc.XImplBase`, `add_XServicer_to_server`, Go `RegisterXServer` | `@DubboReference X field`, `XGrpc.new*Stub`/`XGrpc.*Stub`, `*_pb2_grpc.XStub(`, Go `NewXClient` | interface or service name |
| `topic` | send/publish calls with a literal topic | listener annotation attributes, `KafkaConsumer(`/`.subscribe(` | topic name |
| `table` | entity mappings; SQL `into`/`update`/`table`/`delete from` targets | other SQL `from`/`join` targets | lowercase table name |
| `library` | Maven project `groupId:artifactId` (parent group inherited), `package.json` `name`, `go.mod` `module`, `pyproject.toml` `[project] name` (normalized `a-b`) | Maven `dependencies` (`${project.groupId}` resolved), npm dependency keys, `go.mod` `require`, `[project] dependencies` | artifact |

Matching: an HTTP client call reaches every route of another source whose
method agrees (ANY matches any) and whose path is equal, or ends with the other
path when the shorter has at least two segments (a gateway or context prefix);
when several sources match, those named by the client's hint are kept. The
contract id uses the route's key. A client that reaches no route is an
`external` contract with no provider. `rpc` and `library`: a consumer and a
provider of the same key in different sources. `topic` and `table`: a key used
in two or more sources, its providers and consumers as found. An import from
one source into another (`_code.Imports`) adds `library <imported module>` for
a source pair no manifest library already links. A contract keeps the first
site per file, at most 5 per role (`MAX_CONTRACT_SITES`), and spans two
sources unless external.

Limits: entry points 50, commands 80, docs 80, terms 50, configs 60 (at most 3
paths per kind and file name, shallowest first), CI 30 files and 80 steps,
co-change 30, triggers 100, deps 60, central 20, resources 40, contracts 100. `truncated` has
one entry per list that hit its limit: a hint naming how many were shown and
where the rest are (for triggers, `okf validate --json`, whose
`trigger-coverage` issues list every unclaimed file); it is `{}` when nothing
was cut. Co-change: last 500 commits
per source, commits touching more than 50 files skipped, lock files and wiki
files skipped, pairs of two build manifests skipped (version bumps), only files
existing at HEAD, `support >= 3` and max directional confidence `>= 0.6`.

## Review

```python
def drafts(pages) -> list[Page]
def subject(ws, pages) -> dict   # {"subject_digest", "revision", "pages": [{"path","sha256"}], "review_file"}
def load(ws) -> tuple[dict | None, list[str]]      # report, problems
def state(ws, pages) -> tuple[str, dict | None]    # "missing" | "invalid" | "stale" | "changes_requested" | "approved"
def open_changes(ws) -> int | None                 # issue count of a changes_requested report on disk (current or stale), else None
```

`subject_digest` = sha256 of sorted compact JSON of
`{"pages": [[path, file_sha256] for draft pages sorted]}` (file bytes with
CRLF and lone CR read as LF). Draft bytes include
each page's `revision`, which the `revision` rule keeps equal to the source
content at HEAD, so a wiki-only commit keeps the digest and a source change
does not slip past it. `_review.json` lives at `<wiki>/_review.json` and holds
one round only; every round is written by a fresh reviewer (cross-context
review), which reads the previous round's file as input:

```json
{"subject_digest": "…", "reviewer": "repo-wiki-reviewer/<model>", "verdict": "changes_requested",
 "issues": [{"page": "modules/billing.md", "kind": "unsupported", "claim": "…", "fix": "…",
             "locator": "src/x.py#L1-L4"}]}
```

`kind` ∈ unsupported, invented-why, parrot, filler, missing, terminology,
routing, other. `approved` requires an empty `issues` list; `changes_requested`
requires at least one issue. Unknown keys are invalid. `reviewer` is an actor
(`<producer>/<version>` or `human:<id>`).

## Stamp, derived files, verify, pointer

- `stamp(ws, by: str, unreviewed: bool) -> dict`: preconditions (design §6
  stage 6); on failure returns `{"stamped": [], "blocked": [Issue...]}` and
  writes nothing. `--unreviewed` skips a missing, stale or invalid review, but
  never a report that requested changes: while `_review.json` holds verdict
  `changes_requested` (for the current or a stale subject) it is blocked with a
  `review` issue naming the issue count, whose fix says to repair the issues and
  run a fresh review round, or to delete the report after resolving the issues
  with the user. The derived-file issues (`index`, `log`, `map`) never block:
  stamp rewrites those files. On success writes pages, the derived files,
  deletes `_review.json`, returns

  ```json
  {"stamped": ["modules/billing.md"], "verified_by": "repo-wiki-reviewer/<model>",
   "derived": ["docs/wiki/index.md", "docs/wiki/log.md"],
   "warnings": [<Issue dicts of every remaining warning>], "blocked": []}
  ```

  Each stamped page gets `stamp: {content_sha256, reviewed_by}` (see Page
  model) and, when reviewed, `verified: [{by: <reviewer>, at}]`.
  `verified_by` is the approving reviewer (null for `--unreviewed` or with no
  draft), `derived` lists the derived files written or removed (workspace
  paths), `warnings` are the warning issues (`alias`, `uncited-why`, `parrot`,
  `canon-empty`, `orphan`, ...) validated after writing, so `line` is the
  stamped file line. Warnings never block a stamp. With no draft page it only
  rewrites differing derived files.
- `render_derived(ws, pages, facts) -> dict[str, str]`: wiki path -> text of
  every derived file; `write_derived` writes the differing ones and removes a
  stale `index.md`, `log.md` or `system-map.md` (`derived_on_disk`).
- Indexes (`render_indexes`, OKF §8): entries `* [title](link) - description
  (<reviewed|unreviewed> YYYY-MM-DD)` for stable author pages (reviewed: a
  stamped page with a `verified` entry; the date is `generated.at`), no marker
  for generated pages; sections sorted by title then path. A single
  repository has one root `index.md`: frontmatter `okf_version: "0.2"`, sections
  Architecture, Glossary, Conventions, Workflows, Modules, Database (Schema
  pages; Table pages are linked from them) (zh 架构, 术语表, 开发规范, 流程,
  模块, 数据库), then `# Source map` (zh `# 源码映射`) with `* \`module/\` -
  [title](path), …`, `Not covered: reason` or `no page yet`. A hub's root index
  lists the system pages (Architecture, the System map entry rendered from the
  map's own title and description, Glossary, Conventions, Flows, Database) and
  `# Sources` (zh `# 源仓库`) with `* [<source>](sources/<source>/) - <overview
  description>`; each `sources/<source>/index.md` (no frontmatter) lists
  Overview, Conventions, Workflows and Modules of that source, links relative
  to its directory, and its Source map, where a page outside the directory (a
  Flow) is linked bundle-absolute (`/flows/x.md`).
- `render_log` (`log.md`, OKF §9): `# Update log` (zh `# 更新日志`), then days
  (`## YYYY-MM-DD`) newest first, entries `* **Creation|Update**: [title](/path)
  - <revisions>; reviewed by <reviewer>|unreviewed`. Derived, never
  appended: `_git.log_paths(ws.root, wiki, 400)` walked oldest first, one entry
  whenever a page's `stamp.content_sha256` at a commit differs from the last
  one seen for that path (the first seen is read at `<commit>^`), then the
  working-tree pages (stamps not yet committed). Creation when the path had no
  earlier stamp; revisions are `<source> <old12>..<new12>` per changed source
  (the new revision alone for a creation; no source label in a single
  repository). Sorted by `generated.at` descending, then path; at most 100
  entries, then a line pointing to `git log -- <wiki>`. Deleting the file and
  stamping rebuilds it byte for byte; a merge conflict is resolved the same way.
- `log_entries(ws, since=None, files=None) -> {"entries": [...]}` (`okf log`):
  entries `{path, at, reviewer, title, kind, revisions}`, only those on or after
  `since` (YYYY-MM-DD, else `StampError`) and those of pages `impact_files`
  lists under `read` or `update` for `files`.
- `render_map` (`system-map.md`, hub): a generated page, frontmatter `type: Map`,
  title, description, `status: stable`; body: a note that it is generated, a
  mermaid flowchart with one node per source and one edge per consumer ->
  provider pair labelled with contract counts per kind, a `## Contracts` table
  (`| Contract | Provider | Consumers | Described in |`, sites as `source
  \`locator\``, the claiming pages as bundle-absolute links) and an `##
  External calls` table; "No contracts between sources at HEAD." when there
  are none.
- `verify(ws, actor, paths)`: actor must start with `human:`; pages must be
  `stamped` (matching hash and a valid `verified` list); appends `{by, at}`
  (outside the hash, checked by the `verified` rule). Idempotent per actor: a
  stamp resets `verified`, so a page that already holds an entry by `actor` is
  left unchanged and reported in `already_verified`; after a re-stamp the same
  actor records again. Returns `{verified, by, at[, already_verified]}`.
- `pointer(ws, source=None) -> str` and `write_pointer(ws, target: Path,
  source=None)`: block between `<!-- repo-wiki:begin -->` and `<!--
  repo-wiki:end -->`, at most 15 lines including both markers. It says: open
  the index (`<wiki>/index.md`, or `<wiki>/sources/<source>/index.md` with a
  source) and pick pages by description or Source map, then check claims in
  the cited lines; the must-read pages before naming or changing code
  (`<wiki>/glossary.md` and `<wiki>/conventions.md`, plus
  `<wiki>/sources/<source>/conventions.md` with a source); before editing,
  `okf impact --files <paths> --json` lists pages to read, pages to update and
  change guide rows (where to start, what else to change, how to verify);
  after changing files in a page's `scope`, update the page or set `status:
  draft` with a todo block; invariant rows (whole invariant tables, header and
  rows) are printed by `rg -nU '^\|\s*Invariant\s*\|.*\n(\|.*\n)*' <wiki>` (zh:
  `关键约束`), with `<wiki>` shell-quoted (`shlex.quote`) when it holds
  spaces. In a hub one more line follows: without a source, to paste `okf
  pointer --source <name>` into each source's AGENTS.md (paths relative to the
  hub root; the kernel never writes into sources); with one, where the
  contracts are (`<wiki>/system-map.md`, `okf links --json`) and to follow
  their Change order. The remaining lines list the `verified` commands of the
  stable conventions page of that level (`conventions.md`, or the source's)
  whose content still matches its stamp. A source that is not configured, or a
  source in a single repository, is a `StampError`. Writing replaces an
  existing block or appends one.

## Impact and update

```python
def impact(ws) -> dict
def impact_files(ws, paths: list[str]) -> dict
def plan(ws, report, pages) -> tuple[dict[str, list[str]], list[dict]]   # what update would write, and what it cannot place
def update(ws) -> dict      # {"drafted", "rebased", "unplaced", "impact"}
```

`impact` report:

```json
{"head": {".": "<sha>"},
 "pages": [{"page": "modules/billing.md", "status": "stable", "revision": {".": "<sha>"},
            "reasons": [{"kind": "cited-moved", "path": "src/b.py", "locator": "src/b.py#L3-L5", "suggested": "src/b.py#L7-L9", "since": "<sha12>"}]}],
 "unmapped_modules": ["src/new"], "unclaimed_triggers": [{"path": "src/new/api.py", "kinds": ["http"]}],
 "missing_scope": [{"page": "…", "glob": "…"}], "deleted_not_covered": [{"page": "architecture.md", "path": "old"}],
 "unclaimed_contracts": [{"id": "topic order-cancelled", "sources": ["api", "worker"]}]}
```

Reason kinds: `cited-context` (cited lines identical at the same place, file
changed), `cited-moved` (unique exact match elsewhere, `suggested` given; follows
renames), `cited-changed`, `cited-deleted`, `scope-added`, `scope-modified`,
`scope-deleted`, `revision-missing` (the recorded commit is gone, e.g. after a
rebase), `catalog-changed` and `catalog-deleted` (a linked Schema/Table page was
re-captured with a different hash or removed), and `contract-changed` (`{kind,
contract, path, since}`: a site file of a contract the page claims changed in
its source, whether or not the page's scope reaches that file). Every reason
found by diffing a source (the `cited-*`, `scope-*` and `contract-changed`
kinds) carries `since`, the first 12 hex
digits of the revision it was diffed from. Only pages with at least one
reason are listed. Diffs run per source from `revision[source]` to that source's
HEAD over the whole tree (`Facts.changes`, one diff per distinct revision), then
filtered in Python by the scope globs, matched with `glob_match` against the
workspace path (source prefix added), exactly as validate and coverage match
them, so hub globs such as `*/src/**` or `**/x.py` work, and by the cited paths; an
unrestricted diff is needed because git applies pathspecs before rename
detection, so a cited file renamed out of the scope would otherwise read as
deleted. A revision that is current (see Status) is skipped. `update`
refuses dirty sources, calls `_page.mark_draft` for every listed page with one
reason line per reason, `describe(reason)`: `<kind> <path>` for scope reasons,
`<kind> [^label] <locator>[ -> suggested <locator>]` for cited reasons,
`contract-changed <id> <path>` for contract reasons, all
ending with ` (since <sha12>)`, the base the change was diffed from (so
`git diff <sha12> -- <path>` shows it); `revision-missing <source> <sha12>:
recheck every claim` and the catalog reasons have no suffix. A reason equal to
a whole `- ` line already in the todo block is not repeated (the suffix is
part of the line; substrings do not count). It adds
`unmapped-module` and `unclaimed-trigger <path> (<kinds>)` lines to the page
that answers for the module or file (`_validate.coverage_page`: the
architecture page, or the source's overview in a hub), `unclaimed-contract <id>
(<sources>)` lines to `architecture.md`, `not-covered-deleted` lines to the
page holding the row and `scope-empty` lines to the page owning the glob, and
rebases the revision of any
other draft whose revision is no longer current. `plan(ws, report, pages)`
computes the new lines per page (the pages update would redraft) and the
`unplaced` reasons whose page is missing or has unparsable frontmatter
(`{"page", "reason", "fix"}`); update writes nothing for those and returns them.
It returns `{"drafted", "rebased", "unplaced", "impact"}`.
`impact_files` maps each given path (file or directory) to what to read and
update before changing it:

```json
{"files": {"src/billing/retry.py": {
  "read": ["modules/billing.md"],
  "update": ["modules/billing.md"],
  "change_guide": [{"page": "modules/billing.md", "line": 21, "change": "Change the attempt cap",
                    "start": "MAX_ATTEMPTS", "also": "tests/test_retry.py",
                    "verify": "python -m pytest -q tests/test_retry.py"}],
  "canon": ["glossary.md", "conventions.md"],
  "note": null}}}
```

In a hub each entry also has `contracts`:

```json
"contracts": [{"id": "http POST /reservations/{}", "role": "consumer",
               "counterparts": ["worker worker/src/Res.java#L4"], "pages": ["flows/checkout.md"],
               "change_order": [{"page": "architecture.md", "line": 14, "contract": "…", "provider": "worker",
                                 "consumers": "api", "change_order": "…", "verify": "…"}],
               "external": false}]
```

- `read`: pages whose scope matches the path. A directory also matches a scope
  glob with a tracked file below it (`src/*.py` for `src`, via
  `Facts.matches`) or a scope literal prefix below it.
- `update`: pages with a citation of the path (or, for a directory, below it).
- `change_guide`: rows of every change guide table (Architecture, Overview,
  Module, Workflow and Flow pages) that concern the path: a cited locator of the row is the path,
  below the directory, or a directory above it; or the Change or Start at cell
  names it: a path or glob token matching it (`src/billing/**`), its file name
  (`retry.py`), or, for a file, a code-span identifier of 3+ characters that
  occurs as a word in the file at HEAD (`` `MAX_ATTEMPTS` ``, `` `BillingRun.post` ``).
  A path named only in the Also change or Verify cell does not count. `line` is
  the file line of the row; `change`, `start`, `also` and `verify` are the
  cells without backticks and footnote references.
- `canon`: the glossary and conventions pages that exist (wiki-relative), to
  read before naming or changing code; in a hub, for a path in a source, also
  that source's conventions and overview.
- `contracts` (hub): every contract with a site at or below the path: `role`
  (`provider`, `consumer`, or `consumer/provider`), `counterparts` (the other
  sources' sites as `source locator`), `pages` (pages whose `contracts` claim
  it), `change_order` (Contracts rows naming it) and `external`.
- `note`: null, or `; `-joined notes: `resolved <given> to <path> (only source
  <name> has it)` for an unprefixed hub path found in exactly one source (the
  result key is then the resolved path), `ambiguous: sources <a>, <b> all have
  <path>; prefix it with the source name` (then the only note: the path names
  no file yet), `not covered: <reason>` when a Not covered row matches the path
  and no scope does, or `no page covers this path` when read, update and
  change_guide are all empty.

Page lists are wiki-relative and sorted by page path. The CLI turns every
given path into a workspace-relative one, reading a relative path from the
current directory: in a subdirectory `run.py` in `src/billing/` is
`src/billing/run.py`, and inside a hub source it gets the source prefix
(`src/a.py` in `api/` → `api/src/a.py`). See CLI for where the read-only
commands find the workspace root.

## Status

`status(ws_or_error) -> dict`:

```json
{"phase": "write", "next_actions": ["…"], "root": "/abs/repo", "wiki": "docs/wiki",
 "head": {".": "<sha>"},
 "counts": {"pages": 7, "draft": 3, "stable": 4, "todo": 2, "errors": 1, "warnings": 4},
 "issues": [<up to 20 blocking Issue dicts>]}
```

`counts` holds `errors`, `pending` (todo blocks) and `warnings` of the whole
validation. `issues` is never a bare count: in every phase after `blocked` it
lists the validation issues those counts count, the phase's own issues first
(for example the coverage errors in `structure`), then the rest by severity
(error, pending, warning), page and line, at most 20; `issues_truncated` is
the number left out. `init` and `blocked` have no counts and no issues. `root`
is the absolute workspace root (where commands that write must run), also in
`init` and `blocked`.

Phase order: `init` (`NotInitialized`) → `blocked` (any other config error or
dirty tracked source files; next action names the files) → `research` for a
broken canon page (`canon-missing`: the file is absent, has unparsable
frontmatter or the wrong type; one action per page: `recreate the canon page:
okf new --type T[ --source S]`, fix the frontmatter by hand, or set the type)
→ `update` (a draft page's revision has different source content than HEAD,
or no page is a draft and `_impact.plan` would redraft a page for stale pages,
unmapped modules, unclaimed triggers or contracts, deleted Not covered paths
or empty scope globs) → `discover` → `structure` (coverage,
trigger-coverage, link-coverage, contract-claim, scope, not-covered or
page-path errors) → `research` (a Glossary or Conventions canon page with a
todo block, a hint or an error) → `write` (any other page with a todo, hint or
error, except the Architecture and Overview pages; a `section` error counts
like any other page error) → `assemble` (an Architecture or Overview page
with a todo, hint or error: they are written from the pages below them) →
`review` (drafts; review missing, stale, invalid or changes requested; next
actions also offer `okf stamp --unreviewed`, except while `_review.json` holds
a `changes_requested` verdict, current or stale) → `stamp` (drafts; review
approved) → `done`. Derived-file issues (`index`, `log`, `map`) never hold an
earlier phase.

`discover` holds while discovery is incomplete: at least one canon page exists
and either a canon page or a Module/Workflow/Flow page has only empty todo
blocks (whitespace only, the template's block; a page without a todo block is
not empty), or `trigger-coverage` issues exist and there is no Workflow or
Flow page, or `link-coverage` issues exist and there is no Flow page. Its next
action is `okf scan --json, then stage 1 (Discover)` while there is no Module,
Workflow or Flow page and every canon brief is empty; otherwise it names the
pages still missing a brief (up to 10), the number of unclaimed trigger files
when no Workflow or Flow page traces a trigger, and the number of unclaimed
contracts when no Flow page exists; those issues come first.

`done` next actions: `okf stamp --by repo-wiki/<model> (rewrites the indexes,
log.md and the System map)` when a derived file is stale; else `review and
commit the wiki (<n> changed files): git diff -- <wiki>` when `git status
--porcelain -- <wiki>` (untracked files included) lists changes; else
`nothing to do: the wiki is committed and current`.

Status routes to `update` only when update can act: a stale draft is always
rebased or redrafted, and otherwise the same `plan` update runs must be
non-empty. Reasons update cannot place need the canon page that the earlier
`research` step restores, so `status` never repeats `update` without a change.

**Wiki-only commits.** In a single repository the wiki is committed in the same
repository, so HEAD moves whenever the wiki is committed. A revision counts as
current when `git diff <revision> HEAD -- :(exclude)<wiki>` is empty
(`Facts.current`). `revision`, status, impact and update all use this test;
stamp then records HEAD as the revision. In a hub the sources never contain the
wiki, so only equality counts.

## CLI

`uv run <skill>/scripts/okf.py [--wiki DIR] <command>`; commands run from the
workspace root. The read-only `status`, `validate`, `impact` (with or
without `--files`), `links` and `log` also run from any directory below it: they load the
workspace at the current directory's git toplevel, or at the hub root when
that toplevel is a configured hub source (`enclosing_hub`). Commands that
write (`init`, `new`, `scan`, `update`, `stamp`, `verify`, `pointer`, `db`)
still refuse to run elsewhere and name the root to run from: the hub root when
the current directory lies below a configured hub source, else the repository
root. A path suggested inside a command in an error, fix or next action
(`--wiki DIR`, `okf new --source S`, `git diff -- <wiki>`) is shell-quoted
(`shlex.quote`). `--wiki DIR` is relative to the
workspace root. `--json` prints one JSON document on stdout; otherwise a short
human summary. Exit codes: 0 success, 1 validation/precondition failure
(`validate` with errors, blocked `stamp`), 2 usage, config or file-system
error. An `OSError` (a directory where a file is expected, a permission
problem) is reported as `cannot access <path>: <reason> (<type>); <fix>`, never
a traceback; `init` has already rolled back what it wrote. Errors
without `--json` go to stderr (`okf: ...`), with `--json` as `{"error": ...}`.

| command | notes |
|---|---|
| `init [--wiki DIR] [--lang en\|zh] [--hub --source NAME ...]` | |
| `status --json` | |
| `scan --json` | stdout only |
| `new --type T [--name N] [--source S] [--description D] [--title T] [--scope GLOB ...] [--contract ID ...]` | the path is `page_path` (see Roles and paths); prints `{page, type, scope[, contracts]}`; `--name` for Module, Workflow and Flow; `--source` for an Overview or source Conventions page; canon pages default title and description; in a hub, each glob must start with a source name or a wildcard; every glob must match a tracked file at HEAD and every `--contract` (Flow only) a contract (exit 2 otherwise) |
| `links [--source S] [--contract ID] [--file PATH] --json` | hub contracts (`Contract.to_dict`), filtered by a participating source, an id or glob, a file or directory with a site; also from a subdirectory or a hub source. In a single repository `{"contracts": [], "note": ...}` |
| `log [--since YYYY-MM-DD] [--files PATH ...] [--json]` | `_stamp.log_entries`; also from a subdirectory or a hub source |
| `validate [--json] [PATH ...]` | PATH filters reported pages (wiki-relative, or with the wiki prefix); cross-page rules still use all pages; a PATH that is no page exits 2 |
| `review prepare --json` | `_review.subject` plus `state` (`missing`, `invalid`, `stale`, `changes_requested`, `approved`) and, for `changes_requested` or `stale` with a readable report, `previous_issues` (issue count of that report, which the fresh reviewer reads); with no draft: `{"pages": [], "message": ...}` |
| `stamp --by ACTOR [--unreviewed] [--json]` | success: `stamped`, `verified_by`, `derived`, `warnings`, `blocked: []` (see Stamp); blocked: the validate shape (`errors`, `pending`, `warnings`, `issues`) plus `stamped: []`, exit 1. Without `--json` each remaining warning prints as `warning[code] page:line: message` |
| `impact [--files PATH ...] --json` | also from a subdirectory or a hub source; relative paths start at the current directory (see Impact) |
| `update --json` | `{"drafted", "rebased", "unplaced", "impact"}` |
| `verify --actor human:ID PAGE ... [--json]` | a page already verified by the actor since its stamp is a no-op listed in `already_verified` |
| `pointer [--source S] [--write FILE]` | FILE must resolve inside the workspace root (exit 2 otherwise); `--source` in a hub prints the block for that source's AGENTS.md |
| `db tables [--db NAME]... --json` | extension; `{"databases": [{name, repos, database, schemas: [{schema, tables, excluded, skipped}], unmatched_schema_rules, code_not_taken: [{table, schema, reason, locator}], code_not_found: [{table, locator}]}]}`; code tables come from `_scan.code_tables(ws, db.repos)` (lowercase, compared case-insensitively) |
| `db describe TABLE [--db NAME] [--schema S]` | extension; `--db` needed with several databases, `--schema` unless the database has one exact schema rule |
| `db capture [--db NAME]... --json` | extension; one read-only snapshot per database: `_db.capture(url, rules)` → `_dbpages.render_database` → `_dbpages.write_database`, which writes changed pages and removes generated pages of that database (generator `repo-wiki/okf-db`, `db.name`) the capture no longer produces. Layout `databases/<db>/<schema>.md` and `databases/<db>/<schema>/<table>.md` (slugs); `db` frontmatter `{name, schema, table?, repos?}` (repos only in a hub, also appended to the description as "Used by"). A rule set taking no table is a `DbError`. Per database `{name, pages, written, removed, unmatched_schema_rules}` or `{name, error}`; any error exits 1 after the other databases are captured. With no `databases` configured every `db` action is a `ConfigError` |

## Tests

`scripts/tests/helpers.py` provides:

```python
def git_repo(path: Path, files: dict[str, str], message="init") -> Path   # git init -b main, user config, add, commit
def commit(repo: Path, files: dict[str, str | None], message="change") -> str   # None deletes; returns HEAD
def wiki_ws(repo: Path, lang="en") -> Workspace                        # _config.init + commit
def write(page_file: Path, meta: dict, body: str) -> None
```

Each module has `tests/test_<module>.py`. Tests use real temporary git
repositories, never mocks of git. CI (`.github/workflows/qa.yml`) runs the
AGENTS.md Verify commands (`uv run --with pytest --with PyYAML --with
"psycopg[binary]" -m pytest tests -q` from `skills/repo-wiki/scripts`, and
`uv run skills/repo-wiki/evals/run_cli_e2e.py`), then `eval_update.py --strict`,
the `selftest` of `eval_routing.py`, `eval_citations.py`, `eval_canon.py` and
`eval_recall.py`, and
`uvx ruff check skills/repo-wiki`, on Linux, macOS and Windows,
so code must use `pathlib`, posix-normalized relative paths, `newline="\n"`
writes and no shell features.
