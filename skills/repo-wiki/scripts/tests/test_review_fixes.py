"""Regression tests for the final-review findings (real temporary git repositories)."""

import hashlib
import json
import subprocess

import pytest

import _config
import _impact
import _page
import _stamp
import _status
from helpers import commit, git_repo
from kit import ARCH, complete, set_body

# --- 1. init is atomic; status never repeats an update that cannot act ----------------


def test_init_refuses_a_repository_without_commits_and_writes_nothing(tmp_path, capsys, monkeypatch):
    import okf

    root = tmp_path / "empty"
    root.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(root)], check=True)
    (root / "a.py").write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(_config.ConfigError, match="no commit yet"):
        _config.init(root)
    assert not (root / "docs").exists()
    monkeypatch.chdir(root)
    assert okf.main(["init", "--json"]) == 2
    assert "no commit yet" in json.loads(capsys.readouterr().out)["error"]
    assert not (root / "docs").exists()
    assert _status.status(root)["phase"] == "init"


def test_hub_init_refuses_a_source_without_commits(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "hub\n"})
    git_repo(hub / "api", {"a.py": "x\n"})
    (hub / "web").mkdir()
    subprocess.run(["git", "init", "-q", str(hub / "web")], check=True)
    with pytest.raises(_config.ConfigError, match="source web has no commit"):
        _config.init(hub, hub_sources=["api", "web"])
    assert not (hub / "docs").exists()
    assert (hub / ".gitignore").exists() is False


def test_init_rolls_back_when_creating_the_canon_stubs_fails(tmp_path, monkeypatch):
    root = git_repo(tmp_path / "r", {"a.py": "x\n"})
    hub = git_repo(tmp_path / "hub", {".gitignore": "*.log\n"})
    git_repo(hub / "api", {"a.py": "x\n"})

    def boom(ws):
        (ws.wiki / "glossary.md").write_text("partial", encoding="utf-8")
        raise _page.PageError("disk full")

    monkeypatch.setattr(_page, "create_canon", boom)
    with pytest.raises(_page.PageError):
        _config.init(root)
    assert not (root / "docs").exists()
    with pytest.raises(_page.PageError):
        _config.init(hub, hub_sources=["api"])
    assert not (hub / "docs").exists()
    assert (hub / ".gitignore").read_text(encoding="utf-8") == "*.log\n"


def _wiki_bytes(ws) -> str:
    digest = hashlib.sha256()
    for file in sorted(ws.wiki.rglob("*")):
        if file.is_file():
            digest.update(file.relative_to(ws.wiki).as_posix().encode() + b"\0" + file.read_bytes())
    return digest.hexdigest()


def _drive(root, ws, rounds=4):
    """Follow status while it says update; each update must change the wiki."""
    for _ in range(rounds):
        status = _status.status(root)
        if status["phase"] != "update":
            return status
        before = _wiki_bytes(ws)
        _impact.update(ws)
        assert _wiki_bytes(ws) != before, f"status said update but update did nothing: {status}"
    raise AssertionError("status kept saying update")


def _stable(tmp_path):
    root, ws = complete(tmp_path)
    _stamp.stamp(ws, "repo-wiki/test", unreviewed=True)
    commit(root, {}, "wiki")
    return root, ws


def _config_only(tmp_path):
    root = git_repo(tmp_path / "r", {"src/a.py": "x = 1\n"})
    ws = _config.init(root, create_canon=False)
    return root, ws


def _arch_unparsable_new_module(tmp_path):
    root, ws = _stable(tmp_path)
    (ws.wiki / "architecture.md").write_text("---\ntype: [\n---\n\nbroken\n", encoding="utf-8")
    commit(root, {"worker/job.py": "z = 1\n"}, "new module")
    return root, ws


def _arch_deleted_new_module(tmp_path):
    root, ws = _stable(tmp_path)
    (ws.wiki / "architecture.md").unlink()
    commit(root, {"worker/job.py": "z = 1\n"}, "new module")
    return root, ws


def _arch_mistyped_deleted_not_covered(tmp_path):
    root, ws = _stable(tmp_path)
    page = _page.load_page(ws, "architecture.md")
    page.meta = dict(page.meta) | {"type": "Module", "scope": ["src/**"]}
    _page.write_page(page)
    commit(root, {"tests/test_run.py": None}, "drop tests")
    return root, ws


def _stale_page_arch_missing(tmp_path):
    root, ws = _stable(tmp_path)
    (ws.wiki / "architecture.md").unlink()
    commit(root, {"src/billing/run.py": "# moved\n" + (root / "src/billing/run.py").read_text()}, "code")
    return root, ws


def _garbage_draft_revision(tmp_path):
    root, ws = complete(tmp_path)
    page = _page.load_page(ws, "modules/billing.md")
    page.meta = dict(page.meta) | {"revision": {".": "not-a-sha"}}
    _page.write_page(page)
    commit(root, {"worker/job.py": "z = 1\n"}, "new module")
    return root, ws


@pytest.mark.parametrize("broken", [
    _config_only, _arch_unparsable_new_module, _arch_deleted_new_module,
    _arch_mistyped_deleted_not_covered, _stale_page_arch_missing, _garbage_draft_revision,
])
def test_status_never_repeats_an_update_that_cannot_act(tmp_path, broken):
    root, ws = broken(tmp_path)
    final = _drive(root, ws)
    assert final["phase"] != "update"
    # Repairing what status names ends the broken state too.
    if final["phase"] == "research" and final["issues"][0]["code"] == "canon-missing":
        assert final["next_actions"]
        _drive(root, ws)


def test_status_routes_a_missing_canon_page_to_research_with_the_exact_command(tmp_path, capsys, monkeypatch):
    import okf

    root, ws = _arch_deleted_new_module(tmp_path)
    status = _status.status(root)
    assert status["phase"] == "research"
    assert status["issues"][0]["code"] == "canon-missing"
    action = status["next_actions"][0]
    assert action.startswith("recreate the canon page: okf new architecture.md --type Architecture")
    # Running the named command works and unblocks update.
    monkeypatch.chdir(root)
    argv = ["new", "architecture.md", "--type", "Architecture", "--title", "Architecture",
            "--description", _page.canon_text("en", "Architecture")[1]]
    assert okf.main(argv) == 0
    capsys.readouterr()
    set_body(ws, "architecture.md", ARCH)
    assert _status.status(root)["phase"] != "update"  # a draft exists; coverage shows as structure


def test_update_reports_reasons_it_cannot_place(tmp_path):
    _, ws = _arch_deleted_new_module(tmp_path)
    result = _impact.update(ws)
    assert result["drafted"] == []
    assert result["unplaced"] == [{
        "page": "architecture.md",
        "reason": "unmapped-module worker: add it to a page scope or a Not covered row",
        "fix": "create or repair architecture.md (okf status names the command), then run okf update again",
    }]
    assert not (ws.wiki / "architecture.md").exists()


# --- 3. a hand-added verified entry is an unreviewed edit --------------------------------


def _codes(ws, path):
    import _validate

    return [i.code for i in _validate.validate(ws) if i.page == path]


def test_forged_reviewer_on_an_unreviewed_stamp_is_detected(tmp_path):
    _, ws = complete(tmp_path)
    _stamp.stamp(ws, "repo-wiki/test", unreviewed=True)
    page = _page.load_page(ws, "modules/billing.md")
    assert page.meta["stamp"]["reviewed_by"] is None and "verified" not in page.meta
    page.meta = dict(page.meta) | {"verified": [{"by": "repo-wiki-reviewer/fake", "at": "2099-01-01T00:00:00Z"}]}
    _page.write_page(page)
    assert "unreviewed-edit" in _codes(ws, "modules/billing.md")
    with pytest.raises(_stamp.StampError):
        _stamp.verify(ws, "human:alice", ["modules/billing.md"])
    # Claiming the reviewer in the stamp too breaks the stamp hash.
    page.meta["stamp"] = dict(page.meta["stamp"]) | {"reviewed_by": "repo-wiki-reviewer/fake"}
    _page.write_page(page)
    assert "unreviewed-edit" in _codes(ws, "modules/billing.md")


def test_reviewed_stamp_records_the_reviewer_and_accepts_only_later_human_entries(tmp_path):
    from kit import approve

    _, ws = complete(tmp_path)
    approve(ws)
    _stamp.stamp(ws, "repo-wiki/test")
    page = _page.load_page(ws, "modules/billing.md")
    assert page.meta["stamp"]["reviewed_by"] == "repo-wiki-reviewer/test"
    assert _codes(ws, "modules/billing.md") == []
    _stamp.verify(ws, "human:alice", ["modules/billing.md"])
    assert _codes(ws, "modules/billing.md") == []
    for forged in (
        [{"by": "repo-wiki-reviewer/other", "at": "2099-01-01T00:00:00Z"}],  # another bot
        [{"by": "human:bob", "at": "2000-01-01T00:00:00Z"}],  # predates the stamp
        [{"by": "human:bob"}],  # not what okf verify writes
    ):
        page = _page.load_page(ws, "modules/billing.md")
        good = page.meta["verified"]
        page.meta = dict(page.meta) | {"verified": good + forged}
        _page.write_page(page)
        assert "unreviewed-edit" in _codes(ws, "modules/billing.md"), forged
        page.meta["verified"] = good
        _page.write_page(page)
    # Dropping the reviewer entry is caught as well.
    page = _page.load_page(ws, "modules/billing.md")
    page.meta = dict(page.meta) | {"verified": page.meta["verified"][1:]}
    _page.write_page(page)
    assert "unreviewed-edit" in _codes(ws, "modules/billing.md")


# --- 4. read-only commands walk up from a subdirectory -----------------------------------


def test_impact_status_validate_from_a_subdirectory_of_a_single_repo(tmp_path, capsys, monkeypatch):
    import okf

    root, ws = complete(tmp_path)
    monkeypatch.chdir(root / "src/billing")
    assert okf.main(["impact", "--files", "run.py", "../billing", "--json"]) == 0
    files = json.loads(capsys.readouterr().out)["files"]
    assert files["src/billing/run.py"]["read"] == ["modules/billing.md"]
    assert files["src/billing"]["read"] == ["modules/billing.md"]
    assert okf.main(["status", "--json"]) == 0
    status = json.loads(capsys.readouterr().out)
    assert status["phase"] == "review" and status["root"] == str(root)
    assert okf.main(["validate", "modules/billing.md", "--json"]) == 0
    capsys.readouterr()
    monkeypatch.chdir(ws.wiki)
    assert okf.main(["impact", "--json"]) == 0
    capsys.readouterr()
    assert okf.main(["impact", "--files", "../../src/billing/retry.py", "--json"]) == 0
    assert "src/billing/retry.py" in json.loads(capsys.readouterr().out)["files"]
    # Commands that write still name the root to run from.
    assert okf.main(["update", "--json"]) == 2
    assert "not a git repository root" in json.loads(capsys.readouterr().out)["error"]


def test_impact_files_from_a_hub_subdirectory(tmp_path, capsys, monkeypatch):
    import okf

    hub = git_repo(tmp_path / "hub", {"README.md": "hub\n", "docs/notes.md": "n\n"})
    api = git_repo(hub / "api", {"src/a.py": "x = 1\n"})
    git_repo(hub / "web", {"src/b.py": "y = 1\n"})
    ws = _config.init(hub, hub_sources=["api", "web"])
    commit(hub, {}, "wiki")
    _page.new_page(ws, "modules/api.md", "Module", "Read before api.", ["api/src/**"])
    monkeypatch.chdir(hub / "docs")
    assert okf.main(["impact", "--files", "../api/src/a.py", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["files"]["api/src/a.py"]["read"] == ["modules/api.md"]
    monkeypatch.chdir(api / "src")
    assert okf.main(["validate", "--json"]) == 1  # the hub wiki's own errors, not a config error
    assert "issues" in json.loads(capsys.readouterr().out)


# --- 9. a wrong --wiki is blocked, not init ----------------------------------------------


def test_wrong_wiki_option_is_blocked_and_names_the_configured_wiki(tmp_path, capsys, monkeypatch):
    import okf

    root, _ = complete(tmp_path)
    status = _status.status(root, "kb")
    assert status["phase"] == "blocked"
    assert "docs/wiki/repo-wiki.yaml" in status["next_actions"][0]
    assert "--wiki docs/wiki" in status["next_actions"][0]
    monkeypatch.chdir(root)
    assert okf.main(["init", "--wiki", "kb"]) == 2  # and init refuses, as status implies
    capsys.readouterr()
    with pytest.raises(_config.NotInitialized):
        _config.load(git_repo(tmp_path / "fresh", {"a.py": "x\n"}), "kb")
    assert issubclass(_config.NotInitialized, _config.ConfigError)


# --- 5. paths with spaces are cited as <path>#Lx-Ly ---------------------------------------


def test_locator_angle_bracket_form():
    loc = _config.parse_locator("<my app/核心 a.py>#L2-L3")
    assert (loc.path, loc.start, loc.end) == ("my app/核心 a.py", 2, 3)
    assert loc.text() == "<my app/核心 a.py>#L2-L3"
    assert _config.parse_locator(loc.text()) == loc
    assert _config.parse_locator("<a b.py>").text() == "<a b.py>"
    assert _config.parse_locator("核心/模块.py#L1").text() == "核心/模块.py#L1"  # unicode, no brackets
    for bad in ("<a b.py", "<a b.py>#L0", "<>#L1", "<../a b.py>"):
        with pytest.raises(_config.LocatorError):
            _config.parse_locator(bad)
    assert _config.definition_locator("<my app/x.py>#L1-L2 the retry cap") == ("<my app/x.py>#L1-L2", "the retry cap")
    assert _config.definition_locator("src/a.py#L1 note") == ("src/a.py#L1", "note")
    assert _config.definition_locator("  ") == ("", "")


def test_paths_with_spaces_validate_stamp_impact_and_eval(tmp_path):
    import importlib.util
    import sys
    from pathlib import Path

    import _validate

    root, ws = complete(tmp_path, {"my app/核心 a.py": "def core():\n    return 1\n"})
    set_body(ws, "architecture.md", ARCH.replace("`tests/` | Test code.", "`tests/` | Test code.\n| my app | Demo app. "))
    body = (
        "## Responsibility and boundaries\n\n"
        "| Invariant | Enforced at | Breaks when |\n|---|---|---|\n"
        "| Core returns one. | `core`[^core] | Callers break. |\n\n"
        "## Change guide\n\n| Change | Also change or check |\n|---|---|\n"
        "| `core` | callers[^core] |\n\n"
        "[^core]: <my app/核心 a.py>#L1-L2 the core function\n"
    )
    _page.new_page(ws, "modules/core.md", "Module", "Read before core.", ["my app/**"])
    set_body(ws, "modules/core.md", body)
    issues = [i for i in _validate.validate(ws) if i.page == "modules/core.md" and i.severity == "error"]
    assert issues == []
    _stamp.stamp(ws, "repo-wiki/test", unreviewed=True)
    page = _page.load_page(ws, "modules/core.md")
    assert page.meta["sources"] == [{"id": "core", "resource": "<my app/核心 a.py>#L1-L2"}]
    files = _impact.impact_files(ws, ["my app/核心 a.py"])["files"]["my app/核心 a.py"]
    assert files["update"] == ["modules/core.md"] and files["change_impact"]
    commit(root, {"my app/核心 a.py": "# moved\ndef core():\n    return 1\n"}, "move")
    reasons = {p["page"]: p["reasons"] for p in _impact.impact(ws)["pages"]}
    assert reasons["modules/core.md"][0]["suggested"] == "<my app/核心 a.py>#L2-L3"
    # A bad locator in the plain form points at the bracket form.
    set_body(ws, "modules/core.md", body.replace("<my app/核心 a.py>#L1-L2", "my app/核心 a.py#L1-L2"))
    fixes = [i.fix for i in _validate.validate(ws) if i.page == "modules/core.md" and i.code == "locator"]
    assert fixes and "<my app/x.py>#L1-L5" in fixes[0]
    # eval_citations reads the same locator.
    evals = Path(__file__).resolve().parents[2] / "evals"
    spec = importlib.util.spec_from_file_location("eval_citations", evals / "eval_citations.py")
    cit = sys.modules.get("eval_citations") or importlib.util.module_from_spec(spec)
    if "eval_citations" not in sys.modules:
        sys.modules["eval_citations"] = cit
        spec.loader.exec_module(cit)
    set_body(ws, "modules/core.md", body)
    page = _page.load_page(ws, "modules/core.md")
    claims = cit.page_claims(page)
    cit.attach_evidence(ws, {page.path: page}, claims, 40)
    evidence = [e for c in claims for e in c.evidence]
    assert evidence and all("error" not in e for e in evidence), evidence
    assert evidence[0]["locator"] == "<my app/核心 a.py>#L1-L2"


def test_scan_locators_for_paths_with_spaces_use_the_bracket_form(tmp_path):
    import _scan

    script = "# /// script\n# dependencies = []\n# ///\nprint(1)\n"
    root = git_repo(tmp_path / "r", {"my tools/run e2e.py": script, "a.py": "x = 1\n"})
    ws = _config.init(root, create_canon=False)
    command = next(c for c in _scan.scan(ws)["commands"] if c["name"] == "run e2e")
    assert command == {"name": "run e2e", "command": "uv run 'my tools/run e2e.py'", "kind": "test",
                       "locator": "<my tools/run e2e.py>#L1", "cwd": "."}
    assert _config.parse_locator(command["locator"]).path == "my tools/run e2e.py"


# --- 6. pointer --write keeps a symlink ----------------------------------------------------


def test_pointer_write_goes_through_a_symlink(tmp_path, capsys, monkeypatch):
    import os

    import okf

    root, _ = complete(tmp_path)
    (root / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
    try:
        os.symlink("AGENTS.md", root / "CLAUDE.md")
    except OSError:
        pytest.skip("symlinks need extra privileges here (Windows)")
    monkeypatch.chdir(root)
    assert okf.main(["pointer", "--write", "CLAUDE.md", "--json"]) == 0
    capsys.readouterr()
    assert (root / "CLAUDE.md").is_symlink() and os.readlink(root / "CLAUDE.md") == "AGENTS.md"
    assert "<!-- repo-wiki:begin -->" in (root / "AGENTS.md").read_text(encoding="utf-8")
    assert [p.name for p in root.glob("*.tmp")] == []


# --- 7. constants, tests and page templates are no term sources ----------------------------


def test_templates_and_tests_are_no_term_sources(tmp_path):
    import _scan

    root = git_repo(tmp_path / "r", {
        "src/app/config.py": "class LedgerEntry:\n    pass\n",
        "docs/intro.md": "**Dunning**: payment reminders.\n",
        "tests/test_x.py": "**Fixture Term**: not a term.\n",
        "assets/templates/en/glossary.md": "**Billing run**: a pass.\n",
        "templates/README.md": "# Template\n",
    })
    ws = _config.init(root, create_canon=False)
    report = _scan.scan(ws)
    names = {t["term"] for t in report["terms"]}
    assert "Dunning" in names
    assert not names & {"Billing run", "Fixture Term"}
    assert report["docs"] == ["docs/intro.md"]


# --- 10. the pointer's rg command quotes a wiki path with spaces ---------------------------


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_pointer_rg_command_quotes_a_wiki_path_with_spaces(tmp_path, lang):
    import shlex

    root = git_repo(tmp_path / "r", {"a.py": "x\n"})
    ws = _config.init(root, "docs/知识 库", lang=lang)
    block = _stamp.pointer(ws)
    command = next(line for line in block.splitlines() if "rg -nU" in line)
    argv = shlex.split(command.strip().strip("`"))
    assert argv[0] == "rg" and argv[-1] == "docs/知识 库"
    plain = _stamp.pointer(_config.init(git_repo(tmp_path / "p", {"a.py": "x\n"}), lang=lang))
    assert "' docs/wiki`" in plain  # a plain path stays unquoted


# --- 11. zh: the Conventions page and its index section share one name ---------------------


def test_zh_conventions_title_matches_its_index_section():
    sections = dict(_stamp._SECTIONS["zh"])
    assert _page.canon_text("zh", "Conventions")[0] == sections["Conventions"] == "开发规范"
    assert _page.canon_text("zh", "Architecture")[0] == sections["Architecture"]


# --- 12. confirmed low-severity review findings -------------------------------------------


def test_write_command_below_a_hub_source_names_the_hub_root(tmp_path, capsys, monkeypatch):
    import okf

    hub = git_repo(tmp_path / "hub", {"README.md": "hub\n"})
    api = git_repo(hub / "api", {"src/a.py": "x = 1\n"})
    git_repo(hub / "web", {"src/b.py": "y = 1\n"})
    _config.init(hub, hub_sources=["api", "web"])
    commit(hub, {}, "wiki")
    monkeypatch.chdir(api / "src")
    for argv in (["scan"], ["stamp", "--by", "repo-wiki/t"], ["init"],
                 ["new", "modules/a.md", "--type", "Module", "--description", "Read before a."]):
        assert okf.main([*argv, "--json"]) == 2
        error = json.loads(capsys.readouterr().out)["error"]
        assert f"hub at {hub.resolve()}" in error and "run okf from the hub root" in error, argv
    # A plain subdirectory of a single repository still names its repository root.
    root, _ = complete(tmp_path / "single")
    monkeypatch.chdir(root / "src")
    assert okf.main(["scan"]) == 2
    assert f"the repository root is {root.resolve()}" in capsys.readouterr().err


def test_paths_suggested_in_commands_are_shell_quoted(tmp_path):
    import shlex

    root = git_repo(tmp_path / "r", {"a.py": "x\n"})
    ws = _config.init(root, "my docs/wiki")
    with pytest.raises(_config.ConfigError) as caught:
        _config.load(root, "kb")
    suggestion = str(caught.value).split("pass ", 1)[1]
    assert shlex.split(suggestion) == ["--wiki", "my docs/wiki"]
    commit(root, {}, "wiki")
    (ws.wiki / "architecture.md").unlink()
    fix = _status.status(root, "my docs/wiki")["next_actions"][0]
    argv = shlex.split(fix.split(": ", 1)[1])
    assert argv[:5] == ["okf", "new", "architecture.md", "--type", "Architecture"]
    assert argv[argv.index("--description") + 1] == _page.canon_text("en", "Architecture")[1]
    import _validate

    fixes = [i.fix for i in _validate.validate(ws) if i.code == "canon-missing"]
    assert fixes and all(shlex.split(f.removeprefix("Create it with ").rstrip("."))[:3]
                         == ["okf", "new", "architecture.md"] for f in fixes)


def test_status_done_diff_command_quotes_the_wiki_path(tmp_path):
    import shlex

    from kit import approve

    root, ws = complete(tmp_path)
    approve(ws)
    _stamp.stamp(ws, "repo-wiki/test")
    commit(root, {}, "wiki v1")
    subprocess.run(["git", "-C", str(root), "mv", "docs/wiki", "my docs"], check=True)
    commit(root, {}, "move wiki")
    _stamp.verify(_config.load(root), "human:alice", ["modules/billing.md"])  # uncommitted
    status = _status.status(root)
    assert status["phase"] == "done", status
    command = status["next_actions"][0].split(": ", 1)[1]
    assert shlex.split(command) == ["git", "diff", "--", "my docs"]


def test_test_files_do_not_count_toward_term_minimums(tmp_path):
    import _scan

    root = git_repo(tmp_path / "r", {
        "src/app/a.py": "class BillingRun:\n    pass\n",
        "tests/test_a.py": "from src.app.a import BillingRun\n",
        "tests/test_b.py": "# BillingRun\n",
        "lib/c_test.py": "# BillingRun\n",
        "src/app/b.py": "class LedgerEntry:\n    pass\n",
        "lib/use.py": "LedgerEntry()\n",
        "docs/ledger.md": "A LedgerEntry is posted.\n",
    })
    ws = _config.init(root, create_canon=False)
    terms = {t["term"]: t for t in _scan.scan(ws)["terms"]}
    assert "BillingRun" not in terms  # used only in src outside tests
    assert terms["LedgerEntry"]["count"] == 3


def test_verify_twice_by_the_same_actor_is_a_no_op(tmp_path):
    from kit import approve

    _, ws = complete(tmp_path)
    approve(ws)
    _stamp.stamp(ws, "repo-wiki/test")
    first = _stamp.verify(ws, "human:alice", ["modules/billing.md"])
    assert first["verified"] == ["modules/billing.md"] and "already_verified" not in first
    before = (ws.wiki / "modules/billing.md").read_bytes()
    second = _stamp.verify(ws, "human:alice", ["modules/billing.md"])
    assert second["verified"] == [] and second["already_verified"] == ["modules/billing.md"]
    assert (ws.wiki / "modules/billing.md").read_bytes() == before
    bob = _stamp.verify(ws, "human:bob", ["modules/billing.md"])
    assert bob["verified"] == ["modules/billing.md"]
    humans = [e["by"] for e in _page.load_page(ws, "modules/billing.md").meta["verified"]]
    assert humans.count("human:alice") == 1 and humans.count("human:bob") == 1
    # After a re-stamp the same actor records a fresh review.
    page = _page.load_page(ws, "modules/billing.md")
    page.meta = dict(page.meta) | {"status": "draft"}
    _page.write_page(page)
    _stamp.stamp(ws, "repo-wiki/test", unreviewed=True)
    again = _stamp.verify(ws, "human:alice", ["modules/billing.md"])
    assert again["verified"] == ["modules/billing.md"]


def test_pointer_write_refuses_a_symlink_out_of_the_workspace(tmp_path, capsys, monkeypatch):
    import os

    import okf

    root, _ = complete(tmp_path)
    outside = tmp_path / "outside.md"
    try:
        os.symlink(outside, root / "EVIL.md")
        os.symlink(tmp_path, root / "up")
    except OSError:
        pytest.skip("symlinks need extra privileges here (Windows)")
    monkeypatch.chdir(root)
    for target in ("EVIL.md", "up/x.md", "../escape.md"):
        assert okf.main(["pointer", "--write", target, "--json"]) == 2
        assert "outside the workspace" in json.loads(capsys.readouterr().out)["error"]
    assert not outside.exists() and not (tmp_path / "x.md").exists()
    assert not (tmp_path / "escape.md").exists()


def test_os_errors_are_user_facing_and_init_rolls_back(tmp_path, capsys, monkeypatch):
    import okf

    root, _ = complete(tmp_path)
    monkeypatch.chdir(root)
    assert okf.main(["pointer", "--write", "src", "--json"]) == 2
    error = json.loads(capsys.readouterr().out)["error"]
    assert "IsADirectoryError" in error and "src" in error and "not a directory" in error
    assert okf.main(["pointer", "--write", "src"]) == 2
    assert capsys.readouterr().err.startswith("okf: cannot access ")
    # init fails midway on a file where the wiki directory should be and leaves nothing.
    fresh = git_repo(tmp_path / "fresh", {"docs": "a file\n", "a.py": "x\n"})
    monkeypatch.chdir(fresh)
    assert okf.main(["init", "--wiki", "docs/wiki", "--json"]) == 2
    assert "docs" in json.loads(capsys.readouterr().out)["error"]
    assert (fresh / "docs").read_text(encoding="utf-8") == "a file\n"
    assert subprocess.run(["git", "-C", str(fresh), "status", "--porcelain"],
                          capture_output=True, text=True, check=True).stdout == ""
