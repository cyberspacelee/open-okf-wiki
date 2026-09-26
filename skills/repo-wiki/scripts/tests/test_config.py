import pytest

import _config
from _config import ConfigError, Locator, LocatorError
from helpers import commit, git_repo, wiki_ws


def _hub(tmp_path, names=("api", "worker"), ignore=True):
    hub = git_repo(tmp_path / "hub", {".gitignore": "".join(f"/{n}/\n" for n in names) if ignore else "x\n"})
    for name in names:
        git_repo(hub / name, {"main.py": "print()\n"})
    return hub


# --- load / init ---------------------------------------------------------------


def test_init_and_load_single(tmp_path):
    repo = git_repo(tmp_path / "r", {"src/a.py": "a\n"})
    ws = wiki_ws(repo, lang="zh")
    assert (repo / "docs/wiki/repo-wiki.yaml").read_text() == "lang: zh\n"
    assert ws == _config.load(repo)
    assert ws.root == repo.resolve()
    assert ws.wiki == repo.resolve() / "docs/wiki"
    assert ws.wiki_rel == "docs/wiki"
    assert ws.lang == "zh" and not ws.hub
    assert ws.sources == (_config.Source(".", repo.resolve(), ""),)


def test_load_untracked_config_and_explicit_wiki(tmp_path):
    repo = git_repo(tmp_path / "r", {"a.txt": "a\n"})
    (repo / "wiki").mkdir()
    (repo / "wiki/repo-wiki.yaml").write_text("lang: en\n")
    assert _config.load(repo).wiki_rel == "wiki"
    assert _config.load(repo, "wiki/").wiki_rel == "wiki"
    with pytest.raises(ConfigError, match="--wiki"):
        _config.load(repo, "docs")


def test_load_requires_toplevel(tmp_path):
    repo = git_repo(tmp_path / "r", {"sub/a.txt": "a\n"})
    with pytest.raises(ConfigError, match="root"):
        _config.load(repo / "sub")
    with pytest.raises(ConfigError, match="git init"):
        _config.load(tmp_path)


def test_load_none_or_several(tmp_path):
    repo = git_repo(tmp_path / "r", {"a.txt": "a\n"})
    with pytest.raises(ConfigError, match="okf init"):
        _config.load(repo)
    commit(repo, {"a/repo-wiki.yaml": "lang: en\n", "b/repo-wiki.yaml": "lang: en\n"})
    with pytest.raises(ConfigError, match="--wiki"):
        _config.load(repo)
    assert _config.load(repo, "b").wiki_rel == "b"


@pytest.mark.parametrize(
    "text, match",
    [
        ("lang: fr\n", "lang must be en or zh"),
        ("sources: [api]\n", "lang must be en or zh"),
        ("lang: en\nexclude: [x]\n", "unknown keys exclude"),
        ("lang: en\nlang: zh\n", "not valid YAML"),
        ("- lang\n", "mapping"),
        ("lang: [\n", "not valid YAML"),
        ("lang: en\nsources: []\n", "non-empty list"),
        ("lang: en\nsources: api\n", "non-empty list"),
        ("lang: en\nsources: [api, api]\n", "twice"),
        ("lang: en\nsources: [a/b]\n", "plain directory name"),
        ("lang: en\nsources: ['..']\n", "plain directory name"),
    ],
)
def test_load_bad_config(tmp_path, text, match):
    repo = git_repo(tmp_path / "r", {"docs/wiki/repo-wiki.yaml": text})
    with pytest.raises(ConfigError, match=match):
        _config.load(repo)


def test_init_refuses_existing_and_bad_input(tmp_path):
    repo = git_repo(tmp_path / "r", {"other/repo-wiki.yaml": "lang: en\n"})
    with pytest.raises(ConfigError, match="already configured"):
        _config.init(repo, create_canon=False)
    repo2 = git_repo(tmp_path / "r2", {"a.txt": "a\n"})
    with pytest.raises(ConfigError, match="--lang"):
        _config.init(repo2, lang="fr", create_canon=False)
    with pytest.raises(ConfigError, match="outside"):
        _config.init(repo2, wiki="../x", create_canon=False)
    with pytest.raises(ConfigError, match="root"):
        _config.init(repo2, wiki=".", create_canon=False)
    assert not (repo2 / "docs").exists()


def test_hub_init_writes_gitignore_and_loads(tmp_path):
    hub = git_repo(tmp_path / "hub", {".gitignore": "/api/\n*.log"})
    git_repo(hub / "api", {"main.py": "x\n"})
    git_repo(hub / "worker", {"main.py": "x\n"})
    ws = _config.init(hub, hub_sources=["api", "worker"], create_canon=False)
    assert (hub / ".gitignore").read_text() == "/api/\n*.log\n/worker/\n"
    assert (hub / "docs/wiki/repo-wiki.yaml").read_text() == (
        "lang: en\nsources:\n- api\n- worker\n"
    )
    assert ws.hub
    assert [s.name for s in ws.sources] == ["api", "worker"]
    assert ws.sources[0] == _config.Source("api", (hub / "api").resolve(), "api/")
    assert _config.load(hub) == ws


def test_inside_a_hub_source_points_to_the_hub(tmp_path):
    import _status

    hub = git_repo(tmp_path / "hub", {"README.md": "# hub\n"})
    git_repo(hub / "api", {"main.py": "x\n"})
    _config.init(hub, hub_sources=["api"], create_canon=False)
    with pytest.raises(_config.ConfigError, match="source api of the hub"):
        _config.load(hub / "api")
    with pytest.raises(_config.ConfigError, match="run okf from"):
        _config.init(hub / "api")
    status = _status.status(hub / "api")
    assert status["phase"] == "blocked"
    assert str(hub) in status["next_actions"][0]
    # An unrelated child repository of a non-hub is still a fresh repository.
    other = git_repo(tmp_path / "plain", {"a.py": "x\n"})
    git_repo(other / "child", {"b.py": "x\n"})
    assert _config.enclosing_hub(other / "child") is None


def test_hub_source_not_ignored(tmp_path):
    hub = _hub(tmp_path, ignore=False)
    commit(hub, {"docs/wiki/repo-wiki.yaml": "lang: en\nsources: [api]\n"})
    with pytest.raises(ConfigError, match="/api/"):
        _config.load(hub)


def test_hub_source_missing_or_not_repo(tmp_path):
    hub = git_repo(tmp_path / "hub", {".gitignore": "/api/\n/plain/\n"})
    with pytest.raises(ConfigError, match="clone"):
        _config.init(hub, hub_sources=["api"], create_canon=False)
    (hub / "plain").mkdir()
    (hub / "plain/x.txt").write_text("x\n")
    with pytest.raises(ConfigError, match="not a git repository root"):
        _config.init(hub, hub_sources=["plain"], create_canon=False)
    assert not (hub / "docs").exists()


def test_hub_wiki_inside_source(tmp_path):
    hub = _hub(tmp_path, names=("api",))
    with pytest.raises(ConfigError, match="inside source api"):
        _config.init(hub, wiki="api/docs", hub_sources=["api"], create_canon=False)


def test_hub_skips_configs_inside_ignored_sources(tmp_path):
    hub = _hub(tmp_path, names=("api",))
    commit(hub / "api", {"docs/wiki/repo-wiki.yaml": "lang: en\n"})
    ws = _config.init(hub, hub_sources=["api"], create_canon=False)
    assert _config.load(hub) == ws


# --- locators --------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("src/a.py", Locator("src/a.py", None, None)),
        ("src/a.py#L5", Locator("src/a.py", 5, 5)),
        ("src/a.py#L5-L9", Locator("src/a.py", 5, 9)),
        ("src/a.py#L5-L5", Locator("src/a.py", 5, 5)),
        ("api/dir with space/ü.md#L1", Locator("api/dir with space/ü.md", 1, 1)),
        ("Makefile", Locator("Makefile", None, None)),
        (".github/workflows/qa.yml#L20", Locator(".github/workflows/qa.yml", 20, 20)),
    ],
)
def test_parse_locator_valid(text, expected):
    assert _config.parse_locator(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "#L1",
        "okf-source://api/a.py",
        "file:a.py",
        "C:/x.py",
        "../a.py",
        "src/../a.py",
        "./a.py",
        "src//a.py",
        "src\\a.py",
        "/abs/a.py",
        "src/",
        "src/a.py#L0",
        "src/a.py#L5-L3",
        "src/a.py#L0-L3",
        "src/a.py#5",
        "src/a.py#L5-9",
        "src/a.py#L5-",
        "src/a.py#Lx",
        "src/a.py#L1#L2",
        "src/a.py#anchor",
    ],
)
def test_parse_locator_invalid(text):
    with pytest.raises(LocatorError):
        _config.parse_locator(text)


def test_locator_text_roundtrip():
    for text in ("a/b.py", "a/b.py#L3", "a/b.py#L3-L7"):
        assert _config.parse_locator(text).text() == text
    assert _config.parse_locator("a.py#L3-L3").text() == "a.py#L3"


# --- resolve ------------------------------------------------------------------------


def test_resolve_single(tmp_path):
    ws = wiki_ws(git_repo(tmp_path / "r", {"src/a.py": "a\n"}))
    assert _config.resolve(ws, "src/a.py") == (ws.sources[0], "src/a.py")
    assert _config.resolve(ws, "docs/wikis/x.md")[1] == "docs/wikis/x.md"
    for path in ("docs/wiki/architecture.md", "docs/wiki"):
        with pytest.raises(LocatorError, match="wiki"):
            _config.resolve(ws, path)


def test_resolve_hub(tmp_path):
    hub = _hub(tmp_path)
    ws = _config.init(hub, hub_sources=["api", "worker"], create_canon=False)
    api, worker = ws.sources
    assert _config.resolve(ws, "api/src/a.py") == (api, "src/a.py")
    assert _config.resolve(ws, "worker/main.py") == (worker, "main.py")
    for path in ("src/a.py", "api", "apix/a.py", "docs/wiki/x.md"):
        with pytest.raises(LocatorError):
            _config.resolve(ws, path)


# --- glob -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "pattern, path, expected",
    [
        ("src/billing", "src/billing/a.py", True),
        ("src/billing", "src/billing", True),
        ("src/billing/", "src/billing/x/y.py", True),
        ("src/billing", "src/billing2/a.py", False),
        ("src/billing", "src", False),
        ("src/**", "src/a.py", True),
        ("src/**", "src/a/b/c.py", True),
        ("src/**", "src", True),
        ("src/**", "lib/a.py", False),
        ("**/test_*.py", "test_a.py", True),
        ("**/test_*.py", "a/b/test_a.py", True),
        ("src/**/model.py", "src/model.py", True),
        ("src/**/model.py", "src/a/b/model.py", True),
        ("src/*.py", "src/a.py", True),
        ("src/*.py", "src/a/b.py", False),
        ("src/?.py", "src/a.py", True),
        ("src/?.py", "src/ab.py", False),
        ("src/[ab].py", "src/b.py", True),
        ("src/[ab].py", "src/c.py", False),
        ("src/*.py", "SRC/a.py", False),
        ("*", "a.py", True),
        ("*", "a/b.py", False),
        ("**", "a/b.py", True),
    ],
)
def test_glob_match(pattern, path, expected):
    assert _config.glob_match(pattern, path) is expected


# --- forbidden ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        ".env", ".env.local", "api/.ENV.prod", "certs/server.pem", "a.KEY",
        "x.p12", "x.pfx", "x.jks", "release.keystore", "home/.ssh/id_rsa",
        "id_rsa.pub", "id_ed25519", "vault.kdbx",
    ],
)
def test_is_forbidden(path):
    assert _config.is_forbidden(path)


@pytest.mark.parametrize(
    "path", ["src/env.py", "environment.md", "keys/readme.md", "monkey.py", "a.keys", "pem/a.txt"]
)
def test_is_not_forbidden(path):
    assert not _config.is_forbidden(path)


def _reference_glob(pattern: str, path: str) -> bool:
    """The segment-recursive definition of scope globs (contract semantics)."""
    import fnmatch

    pattern, path = pattern.rstrip("/"), path.rstrip("/")
    if not any(char in pattern for char in "*?["):
        return path == pattern or path.startswith(pattern + "/")

    def match(pat, parts):
        if not pat:
            return not parts
        if pat[0] == "**":
            return any(match(pat[1:], parts[i:]) for i in range(len(parts) + 1))
        return bool(parts) and fnmatch.fnmatchcase(parts[0], pat[0]) and match(pat[1:], parts[1:])

    return match(tuple(pattern.split("/")), tuple(path.split("/")))


def test_compiled_glob_equals_segment_semantics():
    patterns = [
        "src", "src/", "src/**", "**", "*", "**/*.py", "src/**/model.py", "src/*/x.py",
        "a/**/b/**/c", "a**b", "src/[ab]*.py", "src/[!a].py", "src/[]]x", "src/[x",
        "src/?.py", "**/test_*.py", "a/**", "**/a", "a.b/*.c", "src/[a-c]/**",
        "x/**/**/y", "(x)/*", "a+b/**",
    ]
    paths = [
        "src", "src/a.py", "src/b.py", "src/ab.py", "src/a/b/model.py", "src/model.py",
        "src/q/x.py", "src/q/r/x.py", "a/b/c", "a/x/b/y/c", "a/c", "ab", "axxb", "a/b",
        "src/]x", "src/[x", "src/c.py", "test_a.py", "d/test_b.py", "a.b/q.c", "src/b/z",
        "x/y", "x/1/2/y", "(x)/k", "a+b/q", "srcx/a.py", "a",
    ]
    for pattern in patterns:
        for path in paths:
            assert _config.glob_match(pattern, path) is _reference_glob(pattern, path), (pattern, path)


def test_glob_filter_uses_prefix_without_losing_matches():
    files = sorted([
        "src", "src-x/a.py", "src.old/a.py", "src/a.py", "src/b/c.py", "src0/a.py",
        "srcx/a.py", "lib/src/a.py", "tests/test_a.py",
    ])
    for pattern in ("src", "src/**", "src/*.py", "src/**/*.py", "**/*.py", "src*/**", "lib/**/a.py"):
        assert _config.glob_filter(pattern, files) == [f for f in files if _config.glob_match(pattern, f)]
    assert _config.glob_prefix("a/b/*/c") == "a/b"
    assert _config.glob_prefix("**/x") == ""


def test_hub_init_quotes_source_names_yaml_would_retype(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "x\n"})
    for name in ("on", "yes", "1", "null"):
        git_repo(hub / name, {"a.py": "x\n"})
    ws = _config.init(hub, hub_sources=["on", "yes", "1", "null"], create_canon=False)
    assert [s.name for s in ws.sources] == ["on", "yes", "1", "null"]
    assert _config.load(hub) == ws


def test_load_explains_unquoted_yaml_scalars(tmp_path):
    repo = git_repo(tmp_path / "r", {"docs/wiki/repo-wiki.yaml": "lang: en\nsources:\n  - on\n"})
    with pytest.raises(ConfigError, match=r"YAML read an entry as True \(bool\).*quote it"):
        _config.load(repo)
