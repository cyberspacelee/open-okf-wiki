import json
import subprocess

import _config
import _scan
from helpers import commit, git_repo, wiki_ws


def _mods(ws):
    return [(m.path, m.source, m.manifest) for m in _scan.modules(ws)]


def _terms(report):
    return {t["term"]: t for t in report["terms"]}


PYPROJECT = """\
[project]
name = "billing"
version = "0.1.0"

[project.scripts]
billing = "billing.cli:main"

[tool.ruff]
line-length = 100

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.poe.tasks]
lint = "ruff check ."
"""

MAKEFILE = """\
.PHONY: test
test:
\t@uv run pytest -q

lint: deps
\truff check .
"""

WORKFLOW = """\
name: qa
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Unit tests
        run: uv run pytest -q
      - run: |
          ruff check .
          ruff format --check .
"""


def test_python_repo(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pyproject.toml": PYPROJECT,
        "Makefile": MAKEFILE,
        ".github/workflows/qa.yml": WORKFLOW,
        "ruff.toml": "line-length = 100\n",
        ".editorconfig": "root = true\n",
        "README.md": "# Billing\n",
        "src/billing/__init__.py": "",
        "src/billing/cli.py": "def main():\n    pass\n",
        "tests/test_cli.py": "def test_x():\n    pass\n",
        "tests/conftest.py": "",
        "tox.ini": "[tox]\nenvlist = py312\n\n[testenv]\ncommands = pytest\n\n[flake8]\nmax-line-length = 100\n",
    })
    ws = wiki_ws(repo)
    report = _scan.scan(ws)

    assert report["sources"] == [
        {"name": ".", "head": report["sources"][0]["head"], "clean": True, "dirty": [],
         "shallow": False}
    ]
    # src/ is a code root: its package is the module and belongs to the root build;
    # tests/ is a top-level test root, not a module.
    assert _mods(ws) == [("src/billing", ".", "pyproject.toml")]
    src = report["modules"][0]
    assert src["path"] == "src/billing" and src["files"] == 2 and src["languages"] == {"Python": 2}
    assert "src/billing/cli.py" in report["entry_points"]

    commands = {c["name"]: c for c in report["commands"]}
    assert commands["test"] == {"name": "test", "command": "uv run pytest -q", "kind": "test",
                                "locator": "Makefile#L2", "cwd": "."}
    assert {"name": "lint", "command": "ruff check .", "kind": "lint", "locator": "Makefile#L5",
            "cwd": "."} in report["commands"]
    assert {"name": "lint", "command": "ruff check .", "kind": "lint",
            "locator": "pyproject.toml#L15", "cwd": "."} in report["commands"]
    assert {"name": "testenv", "command": "pytest", "kind": "test", "locator": "tox.ini#L4", "cwd": "."} in report["commands"]
    # Configured tools not already declared in the same directory.
    assert {"name": "flake8", "command": "flake8", "kind": "lint", "locator": "tox.ini#L7", "cwd": "."} in report["commands"]
    # [tool.ruff] and [tool.pytest] add nothing: the same commands are declared here already.
    runs = [c["command"] for c in report["commands"]]
    assert runs.count("ruff check .") == 2 and runs.count("pytest") == 1
    assert all(not c["name"].startswith(".") for c in report["commands"])

    assert report["ci"] == [{
        "file": ".github/workflows/qa.yml",
        "steps": [
            {"name": "Unit tests", "run": "uv run pytest -q", "locator": ".github/workflows/qa.yml#L9"},
            {"name": "test", "run": "ruff check .", "locator": ".github/workflows/qa.yml#L10"},
        ],
    }]
    configs = {(c["kind"], c["path"]) for c in report["configs"]}
    assert {("lint", "ruff.toml"), ("lint", "pyproject.toml"), ("test", "pyproject.toml"),
            ("editor", ".editorconfig"), ("test", "tox.ini"), ("lint", "tox.ini"),
            ("build", "Makefile")} <= configs
    assert report["tests"] == {"dirs": ["tests"], "patterns": ["test_*.py"]}
    assert report["docs"] == ["README.md"]
    json.dumps(report)  # serializable


def test_npm_workspaces(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "package.json": json.dumps({
            "name": "mono", "private": True, "workspaces": ["packages/*", "apps/web"],
            "scripts": {"build": "turbo build", "test": "vitest run"},
        }, indent=2) + "\n",
        "packages/core/package.json": '{"name": "core", "main": "src/index.ts"}\n',
        "packages/core/src/index.ts": "export const a = 1;\n",
        "packages/core/src/index.test.ts": "test('a', () => {});\n",
        "packages/ui/package.json": '{"name": "ui"}\n',
        "packages/ui/src/button.tsx": "export {};\n",
        "packages/notapkg/readme.ts": "export {};\n",
        "apps/web/package.json": '{"name": "web"}\n',
        "apps/web/main.ts": "export {};\n",
        "apps/api/server.ts": "export {};\n",
        "scripts/release.js": "\n",
        "tsconfig.json": "{}\n",
        ".prettierrc": "{}\n",
        "eslint.config.js": "export default [];\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("apps/web", ".", "apps/web/package.json"),
        ("packages/core", ".", "packages/core/package.json"),
        ("packages/ui", ".", "packages/ui/package.json"),
        ("scripts", ".", None),
    ]
    report = _scan.scan(ws)
    assert [c["name"] for c in report["commands"]] == ["build", "test"]
    assert report["commands"][0]["locator"] == "package.json#L9"
    assert report["entry_points"][0] == "packages/core/src/index.ts"
    configs = {(c["kind"], c["path"]) for c in report["configs"]}
    assert {("typecheck", "tsconfig.json"), ("format", ".prettierrc"),
            ("lint", "eslint.config.js")} <= configs
    assert "*.test.ts" in report["tests"]["patterns"]


def test_npm_workspaces_object_and_pnpm(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "package.json": '{"workspaces": {"packages": ["libs/*"]}}\n',
        "libs/a/package.json": "{}\n",
        "libs/a/x.js": "\n",
        "pnpm-workspace.yaml": "packages:\n  - 'tools/*'\n  - '!tools/skip'\n",
        "tools/t/package.json": "{}\n",
        "tools/t/x.js": "\n",
        "tools/skip/package.json": "{}\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("libs/a", ".", "libs/a/package.json"),
        ("tools/t", ".", "tools/t/package.json"),
    ]


def test_maven_multi_module(tmp_path):
    pom = """<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modules><module>{}</module></modules>
</project>
"""
    repo = git_repo(tmp_path / "r", {
        "pom.xml": pom.format("core").replace("<module>core</module>",
                                              "<module>core</module><module>web</module>"),
        "core/pom.xml": pom.format("core-impl"),
        "core/core-impl/pom.xml": "<project/>\n",
        "core/core-impl/src/main/java/a/OrderService.java": "class OrderService {}\n",
        "web/pom.xml": "<project><build><plugins><plugin>spotless</plugin></plugins></build></project>\n",
        "web/src/main/java/a/WebApplication.java": "class WebApplication {}\n",
        "web/src/test/java/a/WebApplicationTest.java": "class WebApplicationTest {}\n",
    })
    ws = wiki_ws(repo)
    # core only aggregates core-impl (no code of its own), so it is not a module.
    assert _mods(ws) == [
        ("core/core-impl", ".", "core/core-impl/pom.xml"),
        ("web", ".", "web/pom.xml"),
    ]
    report = _scan.scan(ws)
    assert "web/src/main/java/a/WebApplication.java" in report["entry_points"]
    assert {"kind": "format", "path": "web/pom.xml"} in report["configs"]
    assert "*Test.java" in report["tests"]["patterns"]
    assert "web/src/test" in report["tests"]["dirs"]
    counts = {m["path"]: m["files"] for m in report["modules"]}
    assert counts == {"core/core-impl": 2, "web": 3}


def test_go_workspace_cargo_gradle_uv(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "go.work": "go 1.22\n\nuse (\n\t./svc\n\t./lib // comment\n)\n",
        "svc/go.mod": "module svc\n", "svc/main.go": "package main\n",
        "lib/go.mod": "module lib\n", "lib/lib.go": "package lib\n",
        "tools/gen/go.mod": "module gen\n", "tools/gen/gen.go": "package gen\n",
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/old"]\n',
        "crates/a/Cargo.toml": "[package]\n", "crates/a/src/lib.rs": "\n",
        "crates/old/Cargo.toml": "[package]\n", "crates/old/src/lib.rs": "\n",
        "settings.gradle.kts": 'rootProject.name = "x"\ninclude(":app", ":libs:net")\n',
        "app/build.gradle.kts": "\n", "app/A.kt": "\n",
        "libs/net/build.gradle.kts": "\n", "libs/net/N.kt": "\n",
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["py/*"]\n',
        "py/one/pyproject.toml": "[project]\nname='one'\n", "py/one/one.py": "\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("app", ".", "app/build.gradle.kts"),
        ("crates/a", ".", "crates/a/Cargo.toml"),
        ("lib", ".", "lib/go.mod"),
        ("libs/net", ".", "libs/net/build.gradle.kts"),
        ("py/one", ".", "py/one/pyproject.toml"),
        ("svc", ".", "svc/go.mod"),
        ("tools/gen", ".", "tools/gen/go.mod"),
    ]


def test_root_module_and_hidden_dirs(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "main.py": "print(1)\n", ".tools/x.py": "\n", "docs/guide.md": "# g\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [(".", ".", None)]
    report = _scan.scan(ws)
    assert report["modules"][0]["files"] == 3
    assert report["entry_points"] == ["main.py"]


def test_hub_two_sources(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "# hub\n"})
    git_repo(hub / "api", {
        "pyproject.toml": "[project]\nname='api'\n",
        "app/main.py": "print(1)\n",
        "Makefile": "test:\n\tpytest\n",
    })
    git_repo(hub / "web", {"README.md": "# web\n", "index.html": "<html/>\n"})
    ws = _config.init(hub, lang="en", hub_sources=["api", "web"], create_canon=False)
    commit(hub, {}, "wiki")
    assert _mods(ws) == [("api/app", "api", "api/pyproject.toml"), ("web", "web", None)]
    (hub / "web" / "README.md").write_text("# changed\n")
    report = _scan.scan(ws)
    assert [s["name"] for s in report["sources"]] == ["api", "web"]
    assert report["sources"][1]["clean"] is False
    assert report["sources"][1]["dirty"] == ["web/README.md"]
    assert report["commands"] == [
        {"name": "test", "command": "pytest", "kind": "test", "locator": "api/Makefile#L1", "cwd": "."}]
    assert "api/app/main.py" in report["entry_points"]
    assert report["docs"] == ["web/README.md"]


def test_wiki_and_forbidden_excluded(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "src/a.py": "\n",
        ".env": "SECRET=1\n",
        "src/server.pem": "x\n",
        "docs/intro.md": "**Ledger**: the book of record.\n",
    })
    ws = wiki_ws(repo)
    commit(repo, {
        "docs/wiki/modules/x.md": "**WikiOnly**: must not appear.\n",
        "docs/wiki/tool.py": "class WikiThing: pass\n",
    })
    (repo / "docs/wiki/modules/x.md").write_text("dirty\n")
    report = _scan.scan(ws)
    assert report["sources"][0]["clean"] is True
    assert _mods(ws) == [("src", ".", None)]
    assert report["docs"] == ["docs/intro.md"]
    assert set(_terms(report)) == {"Ledger"}
    assert report["modules"][0]["files"] == 1  # server.pem invisible
    blob = json.dumps(report)
    assert "wiki/" not in blob and ".env" not in blob and "server.pem" not in blob


def test_terms_each_kind(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "docs/glossary.md": (
            "# Terms\n\n**Settlement Run** — a nightly batch.\n"
            "**Note**: ignored.\n\nThe SLA and the KYC check.\n"
        ),
        "README.md": "Uses JSON and HTTP. SLA matters. See KYC.\n",
        "billing/states.py": (
            "from enum import Enum\n\n\nclass RunState(Enum):\n"
            "    PENDING = 1\n    SETTLED = 2\n\n    def label(self):\n        x = 1\n"
        ),
        "billing/invoice.py": "class InvoiceLine:\n    pass\n",
        "billing/use.py": "from .invoice import InvoiceLine\n",
        "api/views.py": "InvoiceLine()\n",
        "web/Status.ts": "export enum Status {\n  Draft = 'd',\n  Open,\n}\n",
        "svc/kind.go": (
            "package svc\n\ntype Kind int\n\nconst (\n\tKindA Kind = iota\n\tKindB\n)\n"
        ),
        "lone/Only.py": "class OnlyHere:\n    pass\n",
    })
    report = _scan.scan(wiki_ws(repo))
    terms = _terms(report)
    assert terms["Settlement Run"]["kind"] == "defined"
    assert terms["Settlement Run"]["locator"] == "docs/glossary.md#L3"
    assert "Note" not in terms
    # A state term is the enum-like type, with its members; members are not terms.
    for name, loc, members in (
        ("RunState", "billing/states.py#L4", ["PENDING", "SETTLED"]),
        ("Status", "web/Status.ts#L1", ["Draft", "Open"]),
        ("Kind", "svc/kind.go#L6", ["KindA", "KindB"]),
    ):
        assert terms[name]["kind"] == "state" and terms[name]["locator"] == loc
        assert terms[name]["members"] == members
    assert "PENDING" not in terms and "KindA" not in terms
    assert "label" not in terms and "x" not in terms
    assert terms["InvoiceLine"] == {"term": "InvoiceLine", "kind": "camel", "count": 3,
                                    "locator": "billing/invoice.py#L1"}
    assert "OnlyHere" not in terms
    # All-caps words are not candidates: abbreviations come from docs and code review.
    assert "SLA" not in terms and "KYC" not in terms
    kinds = [t["kind"] for t in report["terms"]]
    order = ["defined", "state", "camel"]
    assert kinds == sorted(kinds, key=order.index)


def test_terms_dedupe_case_insensitive(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "docs/a.md": "**Draft**: an unfinished page.\n",
        "src/s.py": "import enum\n\nclass S(enum.Enum):\n    DRAFT = 1\n",
    })
    terms = _scan.scan(wiki_ws(repo))["terms"]
    assert [(t["term"], t["kind"]) for t in terms] == [("Draft", "defined")]


def test_co_change_thresholds(tmp_path):
    repo = git_repo(tmp_path / "r", {"seed.txt": "0\n"})
    for i in range(3):  # support 3, a changes 7x, b 3x → conf(b→a) = 1.0
        commit(repo, {"a.py": f"{i}\n", "b.py": f"{i}\n", "uv.lock": f"{i}\n"})
    commit(repo, {"a.py": "x\n", "gone.py": "x\n"})
    for i in range(2):  # support 2: below threshold
        commit(repo, {"c.py": f"{i}\n", "d.py": f"{i}\n"})
    big = {f"bulk/{n}.py": "x\n" for n in range(51)}
    commit(repo, {**big, "c.py": "big\n", "d.py": "big\n"})  # >50 files: skipped
    commit(repo, {"gone.py": None})
    for i in range(3):  # support 3, but e and f each change 6x → conf 0.5
        commit(repo, {"e.py": f"{i}\n", "f.py": f"{i}\n"})
        commit(repo, {"e.py": f"x{i}\n"})
        commit(repo, {"f.py": f"x{i}\n"})
    for i in range(4):  # support 4, conf(h→g) = 4/5 = 0.8
        commit(repo, {"g.py": f"{i}\n", "h.py": f"{i}\n"})
    commit(repo, {"h.py": "solo\n"})
    ws = wiki_ws(repo)
    for i in range(3):
        commit(repo, {"docs/wiki/p.md": f"{i}\n", "a.py": f"w{i}\n"})
    assert _scan.scan(ws)["co_change"] == [
        {"a": "g.py", "b": "h.py", "support": 4, "confidence": 1.0},
        {"a": "a.py", "b": "b.py", "support": 3, "confidence": 1.0},
    ]


def test_determinism_and_truncation(tmp_path):
    files = {f"pkg{i:02d}/main.py": "\n" for i in range(55)}
    files["Makefile"] = "".join(f"t{i:02d}:\n\techo {i}\n" for i in range(85))
    files.update({f"docs/d{i:02d}.md": f"# d{i}\n" for i in range(85)})
    files.update({
        f"docs/t{i:02d}.md": f"**Term{i:02d}**: meaning {i}.\n" for i in range(55)
    })
    repo = git_repo(tmp_path / "r", files)
    ws = wiki_ws(repo)
    first = _scan.scan(ws)
    assert first == _scan.scan(ws)
    assert json.dumps(first, sort_keys=False) == json.dumps(_scan.scan(ws), sort_keys=False)
    assert set(first["truncated"]) == {"entry_points", "terms", "commands", "docs"}
    assert first["truncated"]["commands"].startswith("80 of 85 commands shown")
    assert len(first["entry_points"]) == 50
    assert len(first["commands"]) == 80
    assert len(first["docs"]) == 80
    assert len(first["terms"]) == 50
    assert first["commands"][0]["locator"] == "Makefile#L1"


def test_no_truncation(tmp_path):
    repo = git_repo(tmp_path / "r", {"src/a.py": "\n"})
    report = _scan.scan(wiki_ws(repo))
    assert report["truncated"] == {}
    assert report["co_change"] == [] and report["ci"] == []


def test_binary_and_large_files_skipped(tmp_path):
    repo = git_repo(tmp_path / "r", {"src/a.py": "\n"})
    (repo / "src/big.py").write_text("class HugeThing:\n    pass\n" + "#" * (1 << 20))
    (repo / "src/bin.py").write_bytes(b"class BinThing:\n\0\0")
    commit(repo, {})
    report = _scan.scan(wiki_ws(repo))
    assert report["modules"][0]["files"] == 3
    blob = json.dumps(report)
    assert "HugeThing" not in blob and "BinThing" not in blob


def test_other_command_and_ci_sources(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "justfile": "default:\n  just --list\n\n# run tests\ntest *ARGS:\n  pytest {{ARGS}}\n",
        "Taskfile.yml": "version: '3'\ntasks:\n  build:\n    cmds:\n      - go build ./...\n",
        "noxfile.py": "import nox\n\n@nox.session\ndef tests(session):\n    pass\n",
        ".gitlab-ci.yml": (
            "stages: [test]\n.base:\n  script: [echo hidden]\n"
            "unit:\n  stage: test\n  script:\n    - make test\n    - make lint\n"
        ),
        "Jenkinsfile": "pipeline {\n  stages {\n    stage('Build') {\n      steps { sh 'make build' }\n    }\n  }\n}\n",
        "src/x.go": "package x\n",
    })
    report = _scan.scan(wiki_ws(repo))
    commands = {(c["name"], c["command"], c["locator"]) for c in report["commands"]}
    assert ("default", "just --list", "justfile#L1") in commands
    assert ("test", "pytest {{ARGS}}", "justfile#L5") in commands
    assert ("build", "go build ./...", "Taskfile.yml#L3") in commands
    assert ("tests", "nox -s tests", "noxfile.py#L4") in commands
    ci = {c["file"]: c["steps"] for c in report["ci"]}
    assert ci[".gitlab-ci.yml"] == [
        {"name": "unit", "run": "make test", "locator": ".gitlab-ci.yml#L7"},
        {"name": "unit", "run": "make lint", "locator": ".gitlab-ci.yml#L8"},
    ]
    assert ci["Jenkinsfile"] == [{"name": "Build", "run": "make build", "locator": "Jenkinsfile#L4"}]


def test_aggregator_modules_dropped_but_parents_with_code_kept(tmp_path):
    def mods(*names):
        body = "".join(f"<module>{n}</module>" for n in names)
        return f'<project xmlns="http://maven.apache.org/POM/4.0.0"><modules>{body}</modules></project>\n'

    repo = git_repo(tmp_path / "r", {
        "pom.xml": mods("bundles", "server"),
        "bundles/pom.xml": mods("a", "b"),  # packaging parent only
        "bundles/a/pom.xml": "<project/>\n", "bundles/a/src/A.java": "class A {}\n",
        "bundles/b/pom.xml": "<project/>\n", "bundles/b/src/B.java": "class B {}\n",
        "server/pom.xml": mods("plugin"),  # has code of its own
        "server/src/Server.java": "class Server {}\n",
        "server/plugin/pom.xml": "<project/>\n", "server/plugin/src/P.java": "class P {}\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("bundles/a", ".", "bundles/a/pom.xml"),
        ("bundles/b", ".", "bundles/b/pom.xml"),
        ("server", ".", "server/pom.xml"),
        ("server/plugin", ".", "server/plugin/pom.xml"),
    ]
    counts = {m["path"]: m["files"] for m in _scan.scan(ws)["modules"]}
    # Each file counts once, for its deepest module.
    assert counts == {"bundles/a": 2, "bundles/b": 2, "server": 2, "server/plugin": 2}


def test_terms_share_the_limit_across_kinds(tmp_path):
    files = {
        f"core/E{i:02d}.java": f"enum State{i:02d} {{ ALPHA, BETA }}\n" for i in range(60)
    }
    files.update({
        "core/Ledger.java": "class LedgerEntry {}\n",
        "api/Use.java": "class Use { LedgerEntry e; }\n",
        "web/Use.java": "class Web { LedgerEntry e; }\n",
        "README.md": "The KYC step. **Dunning**: payment reminders.\n",
        "docs/kyc.md": "KYC again.\n",
    })
    repo = git_repo(tmp_path / "r", files)
    report = _scan.scan(wiki_ws(repo))
    kinds = {t["kind"] for t in report["terms"]}
    assert kinds == {"defined", "state", "camel"}
    assert len(report["terms"]) == 50 and "terms" in report["truncated"]
    assert "ALPHA" not in _terms(report)


def test_ci_reusable_workflows_and_readable_run_lines(tmp_path):
    long = "mvn " + " ".join(f"-Dflag{i}=true" for i in range(40))
    workflow = f"""\
jobs:
  ci:
    uses: org/shared/.github/workflows/ci.yml@main
  wait:
    runs-on: ubuntu-latest
    steps:
      - name: Wait
        run: |
          # wait for the database
          set +e
          until pg_isready; do sleep 1; done
      - name: Dispatch
        run: |
          gh workflow run deploy.yml \\
            --ref main
      - name: Build
        run: {long}
"""
    repo = git_repo(tmp_path / "r", {".github/workflows/ci.yml": workflow, "a.py": "\n"})
    steps = _scan.scan(wiki_ws(repo))["ci"][0]["steps"]
    assert steps[0] == {"name": "ci", "run": "uses org/shared/.github/workflows/ci.yml@main",
                        "locator": ".github/workflows/ci.yml#L3"}
    assert steps[1]["run"] == "until pg_isready; do sleep 1; done"
    assert steps[2]["run"] == "gh workflow run deploy.yml --ref main"
    assert len(steps[3]["run"]) == _scan.MAX_RUN and steps[3]["run"].endswith("…")


def test_ci_and_configs_are_bounded(tmp_path):
    step = "      - run: make t{0}\n"
    files = {
        f".github/workflows/w{i:02d}.yml": "jobs:\n  j:\n    steps:\n" + "".join(step.format(n) for n in range(5))
        for i in range(35)
    }
    files.update({f"pkg{i:02d}/tsconfig.p{i:02d}.json": "{}\n" for i in range(70)})
    files.update({f"mod{i}/spotbugs-exclude.xml": "<x/>\n" for i in range(5)})
    files["tsconfig.json"] = "{}\n"
    repo = git_repo(tmp_path / "r", files)
    report = _scan.scan(wiki_ws(repo))
    assert sum(len(f["steps"]) for f in report["ci"]) == _scan.LIMITS["ci_steps"]
    assert len(report["ci"]) <= _scan.LIMITS["ci_files"]
    assert len(report["configs"]) == _scan.LIMITS["configs"]
    assert {"kind": "typecheck", "path": "tsconfig.json"} in report["configs"]  # shallowest first
    spotbugs = [c for c in report["configs"] if c["path"].endswith("spotbugs-exclude.xml")]
    assert len(spotbugs) == _scan.MAX_SAME_CONFIG  # a per-module copy is listed a few times only
    assert "ci" in report["truncated"] and "configs" in report["truncated"]


def test_jvm_entry_points_test_dirs_and_build_configs(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pom.xml": "<project/>\n",
        "mvnw": "#!/bin/sh\n",
        "spotbugs-exclude.xml": "<FindBugsFilter/>\n",
        "src/main/java/app/Main.java": "class Main { public static void main(String[] a) {} }\n",
        "src/main/java/app/test/Fixtures.java": "class Fixtures {}\n",
        "src/main/java/app/Doc.java": "/** Run: public static void main(String[] a) */\nclass Doc {}\n",
        "src/main/webapp/WEB-INF/web.xml": "<web-app/>\n",
        "src/test/java/app/MainTest.java": "class MainTest { static void main(String[] a) {} }\n",
        "src/test/resources/seed_test.sql": "select 1;\n",
        "docs/testing/guide.md": "# testing\n",
    })
    report = _scan.scan(wiki_ws(repo))
    assert report["entry_points"] == [
        "src/main/java/app/Main.java", "src/main/webapp/WEB-INF/web.xml",
    ]
    assert report["tests"] == {"dirs": ["src/test"], "patterns": ["*Test.java"]}
    configs = {(c["kind"], c["path"]) for c in report["configs"]}
    assert {("lint", "spotbugs-exclude.xml"), ("build", "mvnw")} <= configs


def test_co_change_skips_manifest_version_bumps(tmp_path):
    repo = git_repo(tmp_path / "r", {"pom.xml": "0\n", "a/pom.xml": "0\n", "a/A.java": "0\n",
                                     "a/ATest.java": "0\n"})
    for i in range(3):
        commit(repo, {"pom.xml": f"{i}\n", "a/pom.xml": f"{i}\n"}, "bump version")
        commit(repo, {"a/A.java": f"{i}\n", "a/ATest.java": f"{i}\n"})
    pairs = [(c["a"], c["b"]) for c in _scan.scan(wiki_ws(repo))["co_change"]]
    assert pairs == [("a/A.java", "a/ATest.java")]


def test_shallow_clone_is_reported(tmp_path):
    origin = git_repo(tmp_path / "origin", {"a.py": "0\n"})
    commit(origin, {"a.py": "1\n"})
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", "--depth", "1", origin.as_uri(), str(clone)], check=True)
    for key, value in (("user.name", "Test"), ("user.email", "t@example.com")):
        subprocess.run(["git", "-C", str(clone), "config", key, value], check=True)
    ws = wiki_ws(clone)
    assert _scan.scan(ws)["sources"][0]["shallow"] is True


def _runs(report):
    return {(c["command"], c["kind"], c["locator"]) for c in report["commands"]}


def test_command_kinds_from_name_then_command():
    assert _scan._kind("test:unit", "vitest run") == "test"
    assert _scan._kind("check", "ruff format --check .") == "format"
    assert _scan._kind("check", "ruff check .") == "lint"
    assert _scan._kind("type-check", "tsc --noEmit") == "typecheck"
    assert _scan._kind("ci", "tsc -p .") == "typecheck"
    assert _scan._kind("testenv", "") == "test"
    assert _scan._kind("it", "") == "test"
    assert _scan._kind("release", "echo it works") == "other"
    assert _scan._kind("dist", "") == "build"


MAVEN_ROOT = """\
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modules><module>core</module></modules>
  <profiles>
    <profile>
      <id>integration</id>
      <build><plugins/></build>
    </profile>
  </profiles>
  <build>
    <plugins>
      <plugin><artifactId>spotless-maven-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>
"""


def test_maven_commands(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pom.xml": MAVEN_ROOT,
        "mvnw": "#!/bin/sh\n",
        "core/pom.xml": "<project>\n  <build/>\n</project>\n",
        "core/src/main/java/a/A.java": "class A {}\n",
        "core/src/test/resources/fixture/pom.xml": "<project/>\n",
        "tools/standalone/pom.xml": "<project>\n</project>\n",
        "tools/standalone/X.java": "class X {}\n",
    })
    report = _scan.scan(wiki_ws(repo))
    assert _runs(report) == {
        # The project's own <build>, not the profile's; the wrapper is tracked.
        ("./mvnw -q test", "test", "pom.xml#L9"),
        ("./mvnw -q verify", "build", "pom.xml#L9"),
        ("./mvnw -q verify -Pintegration", "build", "pom.xml#L5"),
        ("./mvnw -q spotless:check", "format", "pom.xml#L11"),
        # An outer build of its own; the reactor child and the test fixture are not.
        ("mvn -q test", "test", "tools/standalone/pom.xml#L1"),
        ("mvn -q verify", "build", "tools/standalone/pom.xml#L1"),
    }
    names = {c["command"]: c["name"] for c in report["commands"]}
    assert names["./mvnw -q verify -Pintegration"] == "verify -Pintegration"


def test_maven_many_profiles_give_no_variants(tmp_path):
    profiles = "".join(f"<profile><id>p{i}</id></profile>" for i in range(4))
    repo = git_repo(tmp_path / "r", {
        "pom.xml": f"<project>\n<profiles>{profiles}</profiles>\n</project>\n",
        "src/main/java/A.java": "class A {}\n",
    })
    runs = {c["command"] for c in _scan.scan(wiki_ws(repo))["commands"]}
    assert runs == {"mvn -q test", "mvn -q verify"}


def test_gradle_commands(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "settings.gradle.kts": 'rootProject.name = "x"\ninclude(":app", ":libs:net")\n',
        "build.gradle.kts": (
            'plugins {\n    id("com.diffplug.spotless")\n}\n\n'
            'tasks.register<Copy>("dist") {\n}\n'
            '// tasks.register("commented")\n'
            'val bundleDocs by tasks.registering(Zip::class)\n'
        ),
        "gradlew": "#!/bin/sh\n",
        "app/build.gradle.kts": 'tasks.register("integrationTest") {\n}\n',
        "app/A.kt": "\n",
        "libs/net/net.gradle": "task genSources(type: Copy) {\n}\ntasks.named('test') {}\n",
        "libs/net/N.kt": "\n",
        "buildSrc/build.gradle.kts": 'tasks.register("internal")\n',
        "other/build.gradle": "task hello {\n}\n",
        "other/O.groovy": "\n",
    })
    report = _scan.scan(wiki_ws(repo))
    assert _runs(report) == {
        ("./gradlew test", "test", "settings.gradle.kts#L1"),
        ("./gradlew build", "build", "settings.gradle.kts#L1"),
        ("./gradlew spotlessCheck", "format", "build.gradle.kts#L2"),
        ("./gradlew dist", "build", "build.gradle.kts#L5"),
        ("./gradlew bundleDocs", "build", "build.gradle.kts#L8"),
        # A subproject task runs from its directory through the root wrapper.
        ("../gradlew integrationTest", "test", "app/build.gradle.kts#L1"),
        ("../../gradlew genSources", "other", "libs/net/net.gradle#L1"),
    }


def test_gradle_without_wrapper(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "build.gradle": "apply plugin: 'java'\ntask hello {\n}\n",
        "src/main/java/A.java": "class A {}\n",
    })
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("gradle test", "test", "build.gradle#L1"),
        ("gradle build", "build", "build.gradle#L1"),
        ("gradle hello", "other", "build.gradle#L2"),
    }


def test_cargo_and_go_commands(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace.lints.clippy]\nall = "warn"\n',
        "rustfmt.toml": "edition = '2021'\n",
        "crates/a/Cargo.toml": "[package]\nname = 'a'\n", "crates/a/src/lib.rs": "\n",
        "svc/go.mod": "// svc\nmodule example.com/svc\n", "svc/main.go": "package main\n",
        "svc/.golangci.yml": "linters: {}\n",
        "svc/internal/testdata/go.mod": "module fixture\n",
        "tools/go.mod": "module example.com/tools\n", "tools/t.go": "package tools\n",
    })
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("cargo build", "build", "Cargo.toml#L1"),
        ("cargo test", "test", "Cargo.toml#L1"),
        ("cargo clippy --all-targets", "lint", "Cargo.toml#L4"),
        ("cargo fmt --check", "format", "rustfmt.toml#L1"),
        # Every Go module runs its own ./... (a nested module is not in its parent's).
        ("go test ./...", "test", "svc/go.mod#L2"),
        ("go vet ./...", "lint", "svc/go.mod#L2"),
        ("golangci-lint run", "lint", "svc/.golangci.yml#L1"),
        ("go test ./...", "test", "tools/go.mod#L1"),
        ("go vet ./...", "lint", "tools/go.mod#L1"),
    }


def test_cargo_clippy_needs_configuration(tmp_path):
    repo = git_repo(tmp_path / "r", {"Cargo.toml": "[package]\nname = 'a'\n", "src/main.rs": "\n"})
    runs = {c["command"] for c in _scan.scan(wiki_ws(repo))["commands"]}
    assert runs == {"cargo build", "cargo test"}


def test_python_tool_commands(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pyproject.toml": (
            '[project]\nname = "x"\n\n'
            '[dependency-groups]\ndev = ["pytest>=8", "black"]\n\n'
            "[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\nquote-style = 'double'\n\n"
            '[tool.mypy]\nfiles = ["src"]\n\n'
            "[tool.tox.env.lint]\ncommands = [['ruff', 'check']]\n"
        ),
        "uv.lock": "version = 1\n",
        "src/x/__init__.py": "\n",
        "legacy/setup.cfg": "[metadata]\nname = legacy\n\n[tool:pytest]\naddopts = -q\n\n[flake8]\nmax-line-length = 100\n",
        "legacy/poetry.lock": "\n",
        "legacy/l.py": "\n",
        "typed/pyrightconfig.json": "{}\n",
        "typed/mypy.ini": "[mypy]\nstrict = True\n",
        "typed/t.py": "\n",
    })
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("uv run pytest", "test", "pyproject.toml#L5"),
        ("uv run black --check .", "format", "pyproject.toml#L5"),
        ("uv run ruff check .", "lint", "pyproject.toml#L7"),
        ("uv run ruff format --check .", "format", "pyproject.toml#L10"),
        ("uv run mypy", "typecheck", "pyproject.toml#L13"),  # files configured
        ("tox -e lint", "lint", "pyproject.toml#L16"),
        ("poetry run pytest", "test", "legacy/setup.cfg#L4"),
        ("poetry run flake8", "lint", "legacy/setup.cfg#L7"),
        ("uv run mypy .", "typecheck", "typed/mypy.ini#L1"),  # the root lock is the nearest
        ("uv run pyright", "typecheck", "typed/pyrightconfig.json#L1"),
    }


def test_dotnet_and_cmake_commands(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "App.sln": "\nMicrosoft Visual Studio Solution File\nProject(\"{X}\") = \"App\"\n",
        "src/App/App.csproj": "<Project/>\n", "src/App/Program.cs": "class P {}\n",
        "native/CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(n)\nenable_testing()\n",
        "native/sub/CMakeLists.txt": "add_library(s s.c)\n",
        "native/n.c": "\n",
    })
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("dotnet build App.sln", "build", "App.sln#L3"),
        ("dotnet test App.sln", "test", "App.sln#L3"),
        ("cmake -S . -B build", "build", "native/CMakeLists.txt#L2"),
        ("cmake --build build", "build", "native/CMakeLists.txt#L2"),
        ("ctest --test-dir build", "test", "native/CMakeLists.txt#L3"),
    }


def test_dotnet_projects_without_solution(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "Lib/Lib.fsproj": "<Project/>\n", "Lib/L.fs": "\n",
        "Lib/Inner/Inner.csproj": "<Project/>\n",
    })
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("dotnet build", "build", "Lib/Lib.fsproj#L1"),
        ("dotnet test", "test", "Lib/Lib.fsproj#L1"),
    }


def test_package_scripts_use_the_projects_runner(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "package.json": '{\n  "scripts": {\n    "test": "vitest run",\n    "typecheck": "tsc --noEmit"\n  }\n}\n',
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "packages/a/package.json": '{\n  "scripts": {\n    "build": "tsup"\n  }\n}\n',
        "apps/y/package.json": '{\n  "packageManager": "yarn@4.1.0",\n  "scripts": {"lint": "eslint ."}\n}\n',
        "apps/b/package.json": '{\n  "scripts": {"fmt": "prettier -w ."}\n}\n',
        "apps/b/bun.lockb": "\n",
    })
    npm = git_repo(tmp_path / "n", {"package.json": '{"scripts": {"start": "node ."}}\n'})
    assert _runs(_scan.scan(wiki_ws(repo))) == {
        ("pnpm run test", "test", "package.json#L3"),
        ("pnpm run typecheck", "typecheck", "package.json#L4"),
        ("pnpm run build", "build", "packages/a/package.json#L3"),  # the workspace lock
        ("yarn run lint", "lint", "apps/y/package.json#L3"),  # packageManager wins
        ("bun run fmt", "format", "apps/b/package.json#L2"),
    }
    assert _runs(_scan.scan(wiki_ws(npm))) == {("npm run start", "other", "package.json#L1")}


def test_build_commands_are_deterministic_and_bounded(tmp_path):
    files = {f"svc{i:02d}/go.mod": f"module m{i}\n" for i in range(45)}
    files.update({f"svc{i:02d}/m.go": "package m\n" for i in range(45)})
    files["Makefile"] = "test:\n\tgo test ./...\n"
    repo = git_repo(tmp_path / "r", files)
    ws = wiki_ws(repo)
    report = _scan.scan(ws)
    assert report == _scan.scan(ws)
    assert len(report["commands"]) == _scan.LIMITS["commands"]
    assert "commands" in report["truncated"]
    assert report["commands"][0]["locator"] == "Makefile#L1"  # shallowest first
    assert len({(c["command"], c["locator"]) for c in report["commands"]}) == len(report["commands"])


def test_command_locators_count_lines_like_git(tmp_path):
    # A form feed or U+2028 is not a line break for git; locators must not shift.
    repo = git_repo(tmp_path / "r", {"Makefile": "# a\x0cb c\ntest:\n\tpytest -q\n", "src/x.py": "x\n"})
    commands = {(c["name"], c["locator"]) for c in _scan.scan(wiki_ws(repo))["commands"]}
    assert ("test", "Makefile#L2") in commands


def test_code_roots_split_into_child_modules(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pyproject.toml": "[project]\nname = 'shop'\n",
        "src/billing/run.py": "x = 1\n",
        "src/billing/deep/more.py": "x = 1\n",
        "src/payments/client.py": "x = 1\n",
        "src/tests/test_x.py": "x = 1\n",  # a test root inside a code root is no module
        "src/conftest.py": "x = 1\n",  # code directly in the code root keeps src as a module
        "src/data/schema.json": "{}\n",  # no code: not a module
        "lib/util.py": "x = 1\n",  # only direct code: lib stays one module
        "cmd/server/main.go": "package main\n",
        "internal/store/db.go": "package store\n",
        "scripts/release.py": "x = 1\n",  # not a code root: no parent manifest attribution
        "tests/test_a.py": "x = 1\n",
        "e2e/flow.spec.ts": "x;\n",
        "Spec/a.rb": "x\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("cmd/server", ".", "pyproject.toml"),
        ("internal/store", ".", "pyproject.toml"),
        ("lib", ".", "pyproject.toml"),
        ("scripts", ".", None),
        ("src", ".", "pyproject.toml"),
        ("src/billing", ".", "pyproject.toml"),
        ("src/payments", ".", "pyproject.toml"),
    ]
    counts = {m["path"]: m["files"] for m in _scan.scan(ws)["modules"]}
    # src owns its direct file and the files of non-module children (tests, data).
    assert counts["src"] == 3 and counts["src/billing"] == 2


def test_code_root_with_own_manifest_or_source_sets_stays_whole(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "pom.xml": "<project><build/></project>\n",
        "src/main/java/a/App.java": "class App {}\n",
        "src/test/java/a/AppTest.java": "class AppTest {}\n",
        "lib/package.json": '{"name": "lib"}\n',
        "lib/a/x.js": "x;\n",
        "lib/b/y.js": "y;\n",
    })
    ws = wiki_ws(repo)
    # A Maven single build keeps src/ whole (src/main is a source set, not a module);
    # a code root with its own manifest is its own module.
    assert _mods(ws) == [("lib", ".", "lib/package.json"), ("src", ".", "pom.xml")]


def test_parent_manifest_is_not_attributed_when_it_aggregates(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "package.json": '{"workspaces": ["packages/*"]}\n',
        "packages/core/package.json": "{}\n",
        "packages/core/x.js": "x;\n",
        "src/tool/run.js": "x;\n",
    })
    ws = wiki_ws(repo)
    assert _mods(ws) == [
        ("packages/core", ".", "packages/core/package.json"),
        ("src/tool", ".", None),  # the root declares modules, so it owns no loose code
    ]


def test_hub_code_roots_keep_the_source_prefix(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "# hub\n"})
    git_repo(hub / "api", {
        "pyproject.toml": "[project]\nname='api'\n",
        "src/auth/a.py": "x = 1\n", "src/orders/o.py": "x = 1\n", "tests/test_a.py": "x = 1\n",
    })
    ws = _config.init(hub, lang="en", hub_sources=["api"], create_canon=False)
    commit(hub, {}, "wiki")
    assert _mods(ws) == [
        ("api/src/auth", "api", "api/pyproject.toml"),
        ("api/src/orders", "api", "api/pyproject.toml"),
    ]


def test_defined_terms_prefer_definition_lists_in_glossary_files(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "CONTEXT.md": "# Context\n\n**Ledger**:\nThe book of record.\n\n**Todo Block**:\nA comment.\n",
        "docs/notes.md": (
            "The **Ledger**: mentioned inline first by path order.\n\n"
            "**Widget**: a thing defined on its own line.\n\n"
            "Some **Gadget** is bold inline.\n\n"
            "- **Performance:** fast\n"
            "1. **Speed**: quick\n"
            "* **metrics**: annotation-based metrics\n"
        ),
        "docs/GLOSSARY.md": "**Sprocket** — a gear.\n",
        "DESIGN.md": "# Design\n",
        "TERMS.rst": "Terms\n",
    })
    report = _scan.scan(wiki_ws(repo))
    terms = _terms(report)
    assert terms["Ledger"]["locator"] == "CONTEXT.md#L3"  # glossary-named file wins
    for skipped in ("Performance", "Speed", "metrics"):
        assert skipped not in terms  # a bold list item heading is no definition
    order = [t["term"] for t in report["terms"] if t["kind"] == "defined"]
    # glossary files first, then definition-list entries, then inline bold
    assert order.index("Ledger") < order.index("Widget") and order.index("Sprocket") < order.index("Widget")
    assert order.index("Todo Block") < order.index("Widget") < order.index("Gadget")
    assert {"CONTEXT.md", "DESIGN.md", "TERMS.rst", "docs/GLOSSARY.md"} <= set(report["docs"])


def test_cjk_terms_count_substring_occurrences(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "docs/术语.md": "**结算批次**：每晚运行的批处理。\n",
        "docs/说明.md": "结算批次在夜间运行；结算批次失败会重试。\n",
    })
    terms = _terms(_scan.scan(wiki_ws(repo)))
    assert terms["结算批次"]["count"] == 3 and terms["结算批次"]["locator"] == "docs/术语.md#L1"


def test_generated_marker_must_be_a_header_comment(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "CONTEXT.md": "**Page**:\nSchema pages are generated by the database extension.\n",
        "gen/api.py": "# Code generated by protoc. DO NOT EDIT.\n\nclass GenOnly:\n    pass\n",
        "docs/g.md": "<!-- generated by tool; do not edit -->\n**Machine**: made.\n",
    })
    terms = _terms(_scan.scan(wiki_ws(repo)))
    assert "Page" in terms and "Machine" not in terms


def test_python_main_entry_points_and_pep723_scripts(tmp_path):
    script = "#!/usr/bin/env -S uv run --script\n# /// script\n# dependencies = []\n# ///\nprint(1)\n"
    repo = git_repo(tmp_path / "r", {
        "tools/sync.py": "def main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n",
        "tools/lib.py": "def f():\n    if __name__ == '__main__':\n        pass\n",  # not top level
        "tests/test_x.py": "if __name__ == '__main__':\n    pass\n",
        "evals/run_checks.py": script,
        "scripts/tool.py": script,
        "scripts/test_smoke.py": script,
        "docs/x.py": "s = '# /// script'\n",
    })
    report = _scan.scan(wiki_ws(repo))
    assert "tools/sync.py" in report["entry_points"]
    assert "tools/lib.py" not in report["entry_points"]
    assert "tests/test_x.py" not in report["entry_points"]
    scripts = {c["command"]: (c["kind"], c["locator"]) for c in report["commands"] if c["command"].startswith("uv run")}
    assert scripts == {
        "uv run evals/run_checks.py": ("test", "evals/run_checks.py#L2"),
        "uv run scripts/tool.py": ("other", "scripts/tool.py#L2"),
        "uv run scripts/test_smoke.py": ("test", "scripts/test_smoke.py#L2"),
    }


TEST_PATHS = [
    # (path, is a test path) across ecosystems
    ("tests/test_a.py", True),
    ("pkg/test_a.py", True),  # pytest module outside a test directory
    ("pkg/a_test.py", True),
    ("pkg/conftest.py", True),
    ("testing/helpers.py", True),  # a testing/ directory holds tests
    ("src/test/java/a/Foo.java", True),  # Maven/Gradle test source set
    ("src/integrationTest/kotlin/a/Flow.kt", True),
    ("src/main/java/a/FooTest.java", True),  # named as a test even in src/main
    ("a/FooTests.java", True),
    ("a/FooIT.java", True),
    ("src/test/java/a/TestFoo.java", True),  # JUnit 3 prefix, in a test root
    ("a/FooSpec.scala", True),
    ("a/FooSpec.groovy", True),
    ("a/FooSpec.kt", True),
    ("spec/models/user_spec.rb", True),
    ("lib/user_spec.rb", True),
    ("web/src/foo.test.ts", True),
    ("web/src/Foo.test.tsx", True),
    ("web/src/foo.spec.ts", True),
    ("web/src/__tests__/foo.ts", True),
    ("web/src/__mocks__/api.ts", True),
    ("web/src/__snapshots__/foo.ts.snap", True),
    ("e2e/login.ts", True),
    ("pkg/server/handler_test.go", True),
    ("pkg/server/testdata/in.json", True),
    ("tests/fixtures/data.json", True),
    ("app/fixtures/users.yaml", True),
    ("tests/Unit/FooTest.php", True),
    ("Sources/AppTests/FooTests.swift", True),
    ("MyApp.Tests/FooTests.cs", True),
    ("api-tests/smoke.js", True),
    # production code that merely contains "test" or "spec" in a word
    ("src/latest.py", False),
    ("contest/rules.py", False),
    ("lib/attestation.py", False),
    ("src/main/java/a/Testimonial.java", False),
    ("src/main/java/a/TestResource.java", False),  # a production endpoint
    ("pkg/testing_utils.py", False),
    ("src/main/java/a/test/Fixtures.java", False),  # a package named test under src/main
    ("src/main/java/a/Latest.java", False),
    ("src/main/java/a/BIT.java", False),
    ("src/main/java/a/PBEKeySpec.java", False),  # Spec types are production code in Java
    ("src/inspect.py", False),
    ("docs/testing.md", False),
    ("src/spectrum.ts", False),
    ("src/protest.go", False),
]


def test_is_test_path_across_ecosystems():
    wrong = [(path, want) for path, want in TEST_PATHS if _scan.is_test_path(path) != want]
    assert wrong == []


def test_test_paths_are_no_entry_points_and_no_term_sources(tmp_path):
    repo = git_repo(tmp_path / "r", {
        "billing/invoice.py": "class InvoiceLine:\n    pass\n",
        "lib/test_c.py": (
            "from billing.invoice import InvoiceLine\n\n\n"
            "if __name__ == '__main__':\n    InvoiceLine()\n"
        ),
        "src/test/java/FooTest.java": "class FooTest { public static void main(String[] a) {} }\n",
        "src/test/java/TestBar.java": "class TestBar {}\n",
    })
    report = _scan.scan(wiki_ws(repo))
    assert "lib/test_c.py" not in report["entry_points"]
    assert "src/test/java/FooTest.java" not in report["entry_points"]
    # InvoiceLine is used in one other top-level directory only through a test file.
    assert "InvoiceLine" not in _terms(report)
    assert report["tests"] == {"dirs": ["src/test"], "patterns": ["*Test.java", "Test*.java", "test_*.py"]}


# --- package modules, triggers, dependencies, shared resources ---------------------------------

_J = "src/main/java/com/acme/shop"


def _java_shop() -> dict[str, str]:
    files = {"pom.xml": "<project><artifactId>shop</artifactId></project>\n",
             f"{_J}/ShopApplication.java": "package com.acme.shop;\nclass ShopApplication {}\n",
             "src/test/java/com/acme/shop/order/OrderTest.java": "package com.acme.shop.order;\n@RestController\nclass T {}\n"}
    for package, names in (("order", ("OrderController", "OrderService", "OrderRepo")),
                           ("payment", ("PaymentService", "PaymentJob", "InventoryClient")),
                           ("common", ("Money", "Ids")), ("util", ())):
        for name in names:
            files[f"{_J}/{package}/{name}.java"] = f"package com.acme.shop.{package};\nclass {name} {{}}\n"
    files[f"{_J}/order/OrderController.java"] = (
        "package com.acme.shop.order;\nimport com.acme.shop.payment.PaymentService;\n"
        "import com.acme.shop.common.Money;\n"
        '@RestController\nclass OrderController {\n  void f() { kafka.send("order-created", x); }\n}\n'
    )
    files[f"{_J}/payment/PaymentService.java"] = (
        "package com.acme.shop.payment;\nimport com.acme.shop.order.OrderRepo;\nimport com.acme.shop.common.Money;\n"
        '@KafkaListener(topics = "order-created")\nclass PaymentService {}\n'
    )
    files[f"{_J}/payment/PaymentJob.java"] = "package com.acme.shop.payment;\nclass PaymentJob { @Scheduled void run() {} }\n"
    files[f"{_J}/payment/InventoryClient.java"] = (
        'package com.acme.shop.payment;\n@FeignClient("inv")\ninterface InventoryClient { @GetMapping("/x") String x(); }\n'
    )
    files[f"{_J}/order/OrderRepo.java"] = 'package com.acme.shop.order;\n@Table(name = "t_order")\nclass OrderRepo {}\n'
    files["src/main/resources/mapper/PaymentMapper.xml"] = (
        '<mapper namespace="p">\n<select id="a">select * from t_order</select>\n</mapper>\n'
    )
    return files


def test_single_build_packages_become_modules(tmp_path):
    repo = git_repo(tmp_path / "r", _java_shop())
    modules = {m.path: m.manifest for m in _scan.modules(wiki_ws(repo))}
    # order and payment have 3 production files each; common has 2 and stays with src.
    assert modules == {"src": "pom.xml", f"{_J}/order": "pom.xml", f"{_J}/payment": "pom.xml"}


def test_python_packages_split_only_with_two_qualifying_siblings(tmp_path):
    files = {"src/shop/__init__.py": "", "src/shop/cli.py": "x\n"}
    for package in ("orders", "billing"):
        files.update({f"src/shop/{package}/{n}.py": "x\n" for n in ("__init__", "a", "b")})
    files.update({"src/shop/plain/a.py": "x\n", "src/shop/plain/b.py": "x\n", "src/shop/plain/c.py": "x\n"})
    repo = git_repo(tmp_path / "r", files)
    paths = [m.path for m in _scan.modules(wiki_ws(repo))]
    # plain/ has no __init__.py: not a package, it stays with src/shop.
    assert paths == ["src/shop", "src/shop/billing", "src/shop/orders"]
    lone = git_repo(tmp_path / "l", {"src/shop/__init__.py": "", **{f"src/shop/only/{n}.py": "x\n"
                                                                  for n in ("__init__", "a", "b")}})
    assert [m.path for m in _scan.modules(wiki_ws(lone))] == ["src/shop"]


def test_scan_reports_triggers_deps_and_shared_resources(tmp_path):
    ws = wiki_ws(git_repo(tmp_path / "r", _java_shop()))
    report = _scan.scan(ws)
    order, payment = f"{_J}/order", f"{_J}/payment"
    assert report["triggers"] == [
        {"path": f"{order}/OrderController.java", "module": order, "kinds": ["http"], "count": 1,
         "locator": f"{order}/OrderController.java#L4"},
        {"path": f"{payment}/PaymentJob.java", "module": payment, "kinds": ["job"], "count": 1,
         "locator": f"{payment}/PaymentJob.java#L2"},
        {"path": f"{payment}/PaymentService.java", "module": payment, "kinds": ["listener"], "count": 1,
         "locator": f"{payment}/PaymentService.java#L4"},
    ]
    assert {m["path"]: m["triggers"] for m in report["modules"]} == {"src": 0, order: 1, payment: 2}
    assert [(d["from"], d["to"], d["count"], d["mutual"]) for d in report["deps"]] == [
        (order, "src", 1, False), (order, payment, 1, True),
        (payment, "src", 1, False), (payment, order, 1, True),
    ]
    assert report["deps"][1]["locator"] == f"{order}/OrderController.java#L2"
    assert report["central"] == [
        {"path": f"{_J}/common/Money.java", "module": "src", "modules": 2, "imports": 2},
    ]
    assert report["resources"] == [
        {"kind": "table", "name": "t_order", "modules": ["src", order],
         "locators": ["src/main/resources/mapper/PaymentMapper.xml#L2", f"{order}/OrderRepo.java#L2"]},
        {"kind": "topic", "name": "order-created", "modules": [order, payment],
         "locators": [f"{order}/OrderController.java#L6", f"{payment}/PaymentService.java#L4"]},
    ]
    assert _scan.triggers(ws)[0] == _scan.Trigger(f"{order}/OrderController.java", 4, "http")


def test_trigger_truncation_names_the_full_list(tmp_path):
    files = {f"svc/h{i:03d}.py": "@app.get('/x')\ndef h():\n    pass\n" for i in range(105)}
    report = _scan.scan(wiki_ws(git_repo(tmp_path / "r", files)))
    assert len(report["triggers"]) == _scan.LIMITS["triggers"]
    assert report["truncated"]["triggers"].startswith("100 of 105 trigger files shown; okf validate --json")
