"""Tier-2 citation support and canon recall evals: selftests plus focused units."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

import _config
import _page
from helpers import _git as git
from helpers import commit, git_repo, wiki_ws

EVALS = Path(__file__).resolve().parents[2] / "evals"


def _load(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, EVALS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cit = _load("eval_citations")
can = _load("eval_canon")


def put_page(ws: _config.Workspace, path: str, type: str, body: str, revision: dict, **meta) -> None:
    data = {"type": type, "title": f"Title of {path}", "description": "d", "status": "draft", "revision": revision}
    data |= meta
    target = ws.wiki / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_page.render_page(data, body), encoding="utf-8", newline="\n")


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


# --- selftests ---------------------------------------------------------------------


def test_citations_selftest(tmp_path):
    cit.selftest(tmp_path)


def test_canon_selftest(tmp_path):
    can.selftest(tmp_path)


# --- claim extraction ----------------------------------------------------------------

FILES = {
    "src/a.py": "".join(f"line{i}\n" for i in range(1, 11)),
    "src/secret.pem": "KEY\n",
    "src/blob.bin": "a\0b\n",
}

BODY = """## Section with a cited heading[^a]

First sentence has no citation. The guard spans two
lines and is cited here.[^a] Uses `x.y` and `z[^nope]` inline.[^b]

- Item one is cited.[^a]
  and continues.
- Item two is not.

身份校验在入口完成。[^a]为了避免重复扣款，状态只写一次。[^b]

| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Alpha | First thing. | alpha thing | `a`[^a] |
| Beta | Uncited row. | - | nowhere |

| Purpose | Command | Status |
|---|---|---|
| Tests | `make test`[^b] | verified |

| Area | Rule | Enforced by |
|---|---|---|
| naming | Names are short.[^a][^b] | convention |

| Invariant | Enforced at | Breaks when |
|---|---|---|
| X holds. | `f`[^a] | Y breaks. |

| Change | Start at | Also change | Verify |
|---|---|---|---|
| `A` | `B`[^b] | `C` | `make test` |

| Path | Reason |
|---|---|
| `vendor/` | Vendored.[^a] |

| Free | Table |
|---|---|
| plain | cited[^b] |
| plain | uncited |

Missing definition.[^ghost] Secret file.[^pem] Binary file.[^bin] Past end.[^far]

[^a]: src/a.py#L2-L3 note after the locator
[^b]: src/a.py#L5
[^pem]: src/secret.pem
[^bin]: src/blob.bin
[^far]: src/a.py#L9-L40
"""


@pytest.fixture
def single(tmp_path):
    root = git_repo(tmp_path / "repo", FILES)
    ws = wiki_ws(root)
    rev = commit(root, {}, "base")
    put_page(ws, "modules/a.md", "Module", BODY, {".": rev}, scope=["src/**"])
    return root, ws, rev


def claims_of(ws, path="modules/a.md"):
    return cit.page_claims(_page.load_page(ws, path))


def test_every_canon_row_and_cited_sentence_is_a_claim(single):
    _, ws, _ = single
    claims = claims_of(ws)
    kinds = {}
    for claim in claims:
        kinds.setdefault(claim.kind, []).append(claim)
    assert {k: len(v) for k, v in kinds.items()} == {
        "glossary": 2, "commands": 1, "rules": 1, "invariants": 1, "change_guide": 1, "prose": 10,
    }
    assert all(c.pool == "canon" for k, v in kinds.items() if k != "prose" for c in v)
    prose = {c.text: c for c in kinds["prose"]}
    assert set(prose) == {
        "The guard spans two lines and is cited here.",
        "Uses `x.y` and `z[^nope]` inline.",
        "Item one is cited. and continues.",
        "身份校验在入口完成。",
        "为了避免重复扣款，状态只写一次。",
        "Free: plain; Table: cited",
        "Missing definition.",
        "Secret file.",
        "Binary file.",
        "Past end.",
    }
    # The multi-line sentence is anchored at the line of its footnote (file line).
    page = _page.load_page(ws, "modules/a.md")
    guard = prose["The guard spans two lines and is cited here."]
    assert page.structure.lines[guard.line - page.body_offset - 1].endswith("cited here.[^a] Uses `x.y` and `z[^nope]` inline.[^b]")
    assert prose["Uses `x.y` and `z[^nope]` inline."].labels == ["b"]
    assert prose["为了避免重复扣款，状态只写一次。"].pool == "causal"
    assert prose["身份校验在入口完成。"].pool == "prose"
    # Rows: footnotes stripped, Avoid and Status cells left out, uncited rows kept.
    glossary = {c.text: c for c in kinds["glossary"]}
    assert "Term: Alpha; Meaning: First thing.; Where: `a`" in glossary
    assert glossary["Term: Beta; Meaning: Uncited row.; Where: nowhere"].labels == []
    # A change guide row is judged without its Verify cell.
    assert kinds["change_guide"][0].text == "Change: `A`; Start at: `B`; Also change: `C`"
    assert kinds["commands"][0].text == "Purpose: Tests; Command: `make test`"
    assert kinds["rules"][0].labels == ["a", "b"]
    assert not any("Vendored" in c.text or "uncited" in c.text for c in claims)
    assert len({c.id for c in claims}) == len(claims)


def test_sampling_keeps_canon_and_causal_and_is_seeded(single):
    _, ws, _ = single
    claims = claims_of(ws)
    kept = cit.select(claims, 2, seed=5)
    assert sum(c.pool == "prose" for c in kept) == 2
    assert {c.id for c in claims if c.pool != "prose"} <= {c.id for c in kept}
    assert [c.id for c in cit.select(claims, 2, seed=5)] == [c.id for c in kept]
    assert len(cit.select(claims, -1, seed=0)) == len(claims)
    assert sum(c.pool == "prose" for c in cit.select(claims, 0, seed=0)) == 0


def test_ids_survive_line_moves_and_packets_are_blind(single, tmp_path):
    root, ws, rev = single
    out1, out2 = tmp_path / "o1", tmp_path / "o2"
    assert cit.main(["sample", "--root", str(root), "--out", str(out1), "--per-page", "-1"]) == 0
    put_page(ws, "modules/a.md", "Module", "Intro paragraph without claims.\n\n" + BODY, {".": rev}, scope=["src/**"])
    assert cit.main(["sample", "--root", str(root), "--out", str(out2), "--per-page", "-1"]) == 0
    first, second = read_jsonl(out1 / cit.CLAIMS), read_jsonl(out2 / cit.CLAIMS)
    assert [c["id"] for c in first] == [c["id"] for c in second]
    assert [c["line"] for c in second] == [c["line"] + 2 for c in first]

    packets = read_jsonl(out1 / cit.PACKETS)
    raw = (out1 / cit.PACKETS).read_text(encoding="utf-8")
    assert all(set(p) == {"id", "claim", "cited"} for p in packets)
    for leak in ("Title of", "modules/a.md", "Section with", "note after the locator", '"kind"', '"pool"'):
        assert leak not in raw
    alpha = next(p for p in packets if p["claim"].startswith("Term: Alpha"))
    assert "First sentence" not in json.dumps(alpha)
    assert alpha["cited"] == [{"locator": "src/a.py#L2-L3", "lines": "2 | line2\n3 | line3"}]
    prompt = (out1 / cit.PROMPT).read_text(encoding="utf-8")
    assert "invented-why" in prompt and f"There are {len(packets)} packets" in prompt


def test_judge_directory_holds_only_blind_files(single, tmp_path):
    # Blindness is structural: the judge gets judge/ alone; the answer key and the
    # manifest (both name pages) live outside it.
    root, _, _ = single
    out = tmp_path / "out"
    assert cit.main(["sample", "--root", str(root), "--out", str(out), "--per-page", "-1"]) == 0
    judge = out / cit.JUDGE_DIR
    assert sorted(p.name for p in judge.iterdir()) == ["judge_prompt.md", "packets.jsonl"]
    assert (out / cit.CLAIMS).is_file() and (out / cit.MANIFEST).is_file()
    assert (out / cit.CLAIMS).parent == out and (out / cit.VERDICT_FILE).parent == judge
    for file in judge.iterdir():
        assert "modules/a.md" not in file.read_text(encoding="utf-8")
    assert "modules/a.md" in (out / cit.CLAIMS).read_text(encoding="utf-8")


def test_evidence_errors_and_truncation(single, tmp_path):
    root, _, _ = single
    out = tmp_path / "out"
    cit.main(["sample", "--root", str(root), "--out", str(out), "--per-page", "-1", "--max-lines", "1"])
    claims = {c["text"]: c for c in read_jsonl(out / cit.CLAIMS)}
    assert claims["Missing definition."]["evidence"] == [{"label": "ghost", "error": "footnote has no definition"}]
    assert "secret" in claims["Secret file."]["evidence"][0]["error"]
    assert "text" not in claims["Secret file."]["evidence"][0]
    assert claims["Binary file."]["evidence"][0]["error"] == "binary file"
    far = claims["Past end."]["evidence"][0]
    assert far["start"] == 9 and far["end"] == 9 and "past the file (10 lines)" in far["note"]
    assert "truncated: showing L9-L9 of L9-L10" in far["note"]
    manifest = json.loads((out / cit.MANIFEST).read_text(encoding="utf-8"))
    assert manifest["evidence_errors"] == 3
    assert manifest["uncited"] == [claims["Term: Beta; Meaning: Uncited row.; Where: nowhere"]["id"]]


def test_evidence_reads_page_revision_and_falls_back_to_head(single, tmp_path):
    root, ws, rev = single
    commit(root, {"src/a.py": "changed\n" * 10}, "change")
    out = tmp_path / "out"

    def guard_evidence() -> dict:
        cit.main(["sample", "--root", str(root), "--out", str(out), "--per-page", "-1"])
        claims = {c["text"]: c for c in read_jsonl(out / cit.CLAIMS)}
        return claims["The guard spans two lines and is cited here."]["evidence"][0]

    evidence = guard_evidence()
    assert evidence["rev"] == rev and evidence["text"] == "2 | line2\n3 | line3"
    assert "rev_note" not in evidence
    put_page(ws, "modules/a.md", "Module", BODY, {".": "0" * 40}, scope=["src/**"])
    evidence = guard_evidence()
    assert evidence["text"] == "2 | changed\n3 | changed" and "HEAD" in evidence["rev_note"]


def test_hub_locators_resolve_per_source(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "hub\n"})
    git_repo(hub / "api", {"src/x.py": "old one\nold two\n"})
    api_rev = commit(hub / "api", {}, "pin")
    git_repo(hub / "web", {"main.js": "web\n"})
    web_rev = commit(hub / "web", {}, "pin")
    ws = _config.init(hub, hub_sources=["api", "web"], create_canon=False)
    commit(hub, {}, "wiki")
    commit(hub / "api", {"src/x.py": "new one\nnew two\n"}, "later")
    body = (
        "Api reads x.[^x] Web boots.[^w] Bad prefix.[^bad]\n\n"
        "[^x]: api/src/x.py#L1-L2\n[^w]: web/main.js#L1\n[^bad]: src/x.py#L1\n"
    )
    put_page(ws, "workflows/boot.md", "Workflow", body, {"api": api_rev, "web": web_rev}, scope=["api/src/**"])
    out = tmp_path / "out"
    assert cit.main(["sample", "--root", str(hub), "--out", str(out), "--per-page", "-1"]) == 0
    claims = {c["text"]: c for c in read_jsonl(out / cit.CLAIMS)}
    x = claims["Api reads x."]["evidence"][0]
    assert x["source"] == "api" and x["rev"] == api_rev and x["text"] == "1 | old one\n2 | old two"
    assert claims["Web boots."]["evidence"][0]["source"] == "web"
    assert "does not start with a source directory" in claims["Bad prefix."]["evidence"][0]["error"]
    assert claims["Api reads x."]["revision"] == {"api": api_rev, "web": web_rev}


# --- scoring and agreement ---------------------------------------------------------------


def test_cohen_kappa_math():
    pairs = [("y", "y")] * 20 + [("y", "n")] * 5 + [("n", "y")] * 10 + [("n", "n")] * 15
    assert cit.cohen_kappa(pairs, ("y", "n")) == pytest.approx(0.4)
    assert cit.cohen_kappa([("y", "y")] * 4, ("y", "n")) == 1.0
    assert cit.cohen_kappa([("y", "n"), ("n", "y")], ("y", "n")) == pytest.approx(-1.0)
    assert cit.cohen_kappa([], ("y", "n")) is None
    three = [("a", "a"), ("a", "b"), ("b", "b"), ("c", "c"), ("c", "a"), ("b", "b")]
    # po = 4/6; judge a2 b2 c2, human a2 b3 c1 -> pe = (4 + 6 + 2) / 36
    assert cit.cohen_kappa(three, ("a", "b", "c")) == pytest.approx((4 / 6 - 12 / 36) / (1 - 12 / 36))


def test_score_verdict_problems_and_threshold(single, tmp_path):
    root, _, _ = single
    out = tmp_path / "out"
    cit.main(["sample", "--root", str(root), "--out", str(out), "--per-page", "-1"])
    claims = read_jsonl(out / cit.CLAIMS)
    lines = ["```jsonl"]
    lines += [json.dumps({"id": c["id"], "verdict": "Supported"}) for c in claims[:-1]]
    lines += [json.dumps({"id": claims[-1]["id"], "verdict": "invented_why", "note": "guess"}), "not json", "```"]
    (out / cit.VERDICT_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    report = cit.score(out, out / cit.VERDICT_FILE, 0.9)
    assert report["overall"]["judged"] == len(claims) and report["overall"]["invented-why"] == 1
    assert report["invalid"] == [{"line": len(claims) + 2, "error": "not JSON: Expecting value"}]
    assert not report["complete"] and not report["passed"]
    assert report["failures"][0]["note"] == "guess" and report["failures"][0]["page"] == "modules/a.md"
    assert set(report["by_page"]) == {"modules/a.md"}
    (out / cit.VERDICT_FILE).write_text("\n".join(lines[1:-2]) + "\n" + lines[-3] + "\n", encoding="utf-8")
    report = cit.score(out, out / cit.VERDICT_FILE, 0.9)
    assert report["duplicates"] == [claims[-1]["id"]] and not report["passed"]


def test_agreement_reads_markdown_sheet_and_jsonl(single, tmp_path):
    root, _, _ = single
    out = tmp_path / "out"
    cit.main(["sample", "--root", str(root), "--out", str(out), "--per-page", "-1"])
    claims = read_jsonl(out / cit.CLAIMS)
    cit.write_jsonl(out / cit.VERDICT_FILE, [{"id": c["id"], "verdict": "supported"} for c in claims])
    assert cit.main(["calibrate", "--out", str(out), "--n", "3", "--seed", "2"]) == 0
    text = (out / cit.SHEET).read_text(encoding="utf-8")
    assert text.count("Human verdict: ") == 3 and "<details>" in text
    ids = [line.split()[-1] for line in text.splitlines() if line.startswith("## ")]
    # Fill two items; a "Human verdict:" line inside a cited-lines fence must not count.
    filled, seen = [], 0
    for line in text.splitlines():
        if line.startswith("Human verdict:"):
            seen += 1
            line = {1: "Human verdict: supported", 2: "Human verdict: partial"}.get(seen, line)
        filled.append(line)
    filled.insert(filled.index(f"## 3. {ids[2]}") + 1, "```text\nHuman verdict: unsupported\n```")
    (out / cit.SHEET).write_text("\n".join(filled) + "\n", encoding="utf-8")
    report = cit.agreement(out / cit.VERDICT_FILE, out / cit.SHEET, {c["id"] for c in claims})
    assert report["compared"] == 2 and report["agreement"] == 0.5 and report["unfilled"] == [ids[2]]
    assert report["confusion"]["supported"]["partial"] == 1
    human = tmp_path / "human.jsonl"
    cit.write_jsonl(human, [{"id": ids[0], "verdict": "supported"}, {"id": ids[1], "human": "supported"}])
    report = cit.agreement(out / cit.VERDICT_FILE, human, {c["id"] for c in claims})
    assert report["agreement"] == 1.0 and report["kappa"] == 1.0


# --- canon recall ----------------------------------------------------------------------------


def test_canon_normalization():
    assert can.norm_text("`Billing_Run`[^x]") == "billing run"
    assert can.norm_text("Ｒｅｔｒｙ-limit.") == "retry limit"
    assert can.norm_command("$ `uv  run pytest -q`[^t]") == "uv run pytest -q"
    assert can.term_forms("Billing run (BR)") == {"billing run (br)", "billing run", "br"}
    assert can.split_aliases("a, b，c、d; -") == ["a", "b", "c", "d"]
    assert can.instances({"rule": "Raise X (4 instances).", "locators": ["a"]}) == 4
    assert can.instances({"rule": "Raise X.", "locators": ["a", "b"]}) == 2


@pytest.mark.parametrize(
    "gold, message",
    [
        ("terms: [{aliases: [x]}]", "needs a term"),
        ("rules: [{area: style, keywords: [x]}]", "needs an area"),
        ("rules: [{area: naming}]", "at least one keyword"),
        ("commands: [{purpose: x}]", "needs a command"),
        ("extra: 1", "unknown keys"),
        ("- a", "must be a mapping"),
    ],
)
def test_canon_gold_validation(tmp_path, gold, message):
    path = tmp_path / "gold.yaml"
    path.write_text(gold, encoding="utf-8")
    with pytest.raises(can.EvalError, match=message):
        can.load_gold(path)


def test_canon_reads_zh_tables_and_only_canon_pages(tmp_path):
    root = git_repo(tmp_path / "repo", {"Makefile": "test:\n\ttrue\n"})
    ws = wiki_ws(root, lang="zh")
    rev = commit(root, {}, "base")
    put_page(ws, "glossary.md", "Glossary", (
        "| 术语 | 定义 | 勿用别名 | 代码位置 |\n|---|---|---|---|\n| 账单批次 | 过账。 | 发票任务、批处理 | `run`[^m] |\n\n[^m]: Makefile#L1\n"
    ), {".": rev})
    put_page(ws, "conventions.md", "Conventions", (
        "| 用途 | 命令 | 状态 |\n|---|---|---|\n| 测试 | `make test`[^m] | verified |\n\n"
        "| 类别 | 规则 | 检查方式 |\n|---|---|---|\n| testing | 测试放在 tests/ 下（3 处）。[^m] | convention |\n\n[^m]: Makefile#L1-L2\n"
    ), {".": rev})
    put_page(ws, "modules/x.md", "Module", (
        "| 术语 | 定义 | 勿用别名 | 代码位置 |\n|---|---|---|---|\n| 模块术语 | x | - | `y`[^m] |\n\n[^m]: Makefile#L1\n"
    ), {".": rev}, scope=["Makefile"])
    gold = {
        "terms": [{"term": "批处理"}, {"term": "模块术语"}],
        "rules": [{"area": "testing", "keywords": ["tests/"]}],
        "commands": [{"command": "make test"}],
    }
    report = can.score(ws, can.load_gold(_yaml(tmp_path, gold)))
    assert report["recall"]["terms"]["found"] == 1 and report["terms"][0]["via"] == "avoid"
    assert report["recall"]["rules"]["recall"] == 1.0 and report["recall"]["commands"]["recall"] == 1.0
    assert report["signals"]["weak_convention_rules"] == []
    assert report["unstamped"] == ["conventions.md", "glossary.md"]


def _yaml(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "gold.yaml"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")  # JSON is YAML
    return path


def test_canon_run_commands_uses_source_of_citation_in_hub(tmp_path):
    hub = git_repo(tmp_path / "hub", {"README.md": "hub\n"})
    git_repo(hub / "api", {"Makefile": "x\n", "marker.txt": "api\n"})
    git_repo(hub / "web", {"marker.txt": "web\n"})
    ws = _config.init(hub, hub_sources=["api", "web"], create_canon=False)
    commit(hub, {}, "wiki")
    revision = {"api": _page.current_revision(ws)["api"], "web": _page.current_revision(ws)["web"]}
    put_page(ws, "conventions.md", "Conventions", (
        "| Purpose | Command | Status |\n|---|---|---|\n"
        "| Which | `grep -q web marker.txt`[^w] | verified |\n"
        "| Api | `grep -q web marker.txt`[^a] | verified |\n"
        "| Slow | `sleep 5`[^a] | verified |\n\n"
        "[^w]: web/marker.txt#L1\n[^a]: api/Makefile\n"
    ), revision)
    report = can.evaluate(str(hub), None, str(_yaml(tmp_path, {})), run=True, timeout=0.5)
    runs = [(r["source"], r["status"]) for r in report["runs"]]
    assert runs == [("web", "pass"), ("api", "fail"), ("api", "timeout")]
    assert report["recall"]["terms"]["recall"] is None
    for source in ("api", "web"):
        assert len(git(hub / source, "worktree", "list").splitlines()) == 1


def test_canon_run_commands_run_from_the_cited_file_directory(tmp_path):
    # Kernel contract: a command runs from the directory of the file its locator
    # names, so `npm test` cited at web/package.json runs in web/, not the root.
    repo = git_repo(tmp_path / "repo", {
        "web/package.json": '{"scripts": {"test": "x"}}\n', "web/marker.txt": "web\n",
        "Makefile": "x\n", "marker.txt": "root\n",
    })
    ws = wiki_ws(repo)
    revision = _page.current_revision(ws)
    put_page(ws, "conventions.md", "Conventions", (
        "| Purpose | Command | Status |\n|---|---|---|\n"
        "| Web | `grep -q web marker.txt`[^w] | verified |\n"
        "| Root | `grep -q root marker.txt`[^r] | verified |\n\n"
        "[^w]: web/package.json#L1\n[^r]: Makefile\n"
    ), revision)
    report = can.evaluate(str(repo), None, str(_yaml(tmp_path, {})), run=True, timeout=30)
    runs = [(r["command"], r["cwd"], r["status"]) for r in report["runs"]]
    assert runs == [("grep -q web marker.txt", "web", "pass"), ("grep -q root marker.txt", ".", "pass")]


def test_canon_run_commands_run_pep723_scripts_from_the_source_root(tmp_path):
    # okf scan says a PEP 723 script runs as `uv run <path>` from the source root;
    # --run-commands must agree, so a command naming the cited file by its
    # source-root path runs at the root, while a directory command runs beside it.
    import _scan

    script = "#!/usr/bin/env python3\n# /// script\n# dependencies = []\n# ///\nprint(1)\n"
    repo = git_repo(tmp_path / "repo", {
        "evals/run_e2e.py": script, "evals/marker.txt": "evals\n", "marker.txt": "root\n",
        "web/package.json": '{"scripts": {"test": "x"}}\n', "web/marker.txt": "web\n",
    })
    ws = wiki_ws(repo)
    scanned = {c["name"]: c for c in _scan.scan(ws)["commands"]}
    assert scanned["run_e2e"]["command"] == "uv run evals/run_e2e.py"
    assert scanned["run_e2e"]["cwd"] == "."
    assert scanned["test"]["cwd"] == "web"
    # The wiki command re-derives the same directory from its citation.
    revision = _page.current_revision(ws)
    put_page(ws, "conventions.md", "Conventions", (
        "| Purpose | Command | Status |\n|---|---|---|\n"
        "| E2e | `test -f evals/run_e2e.py && grep -q root marker.txt`[^e] | verified |\n"
        "| Web | `grep -q web marker.txt`[^w] | verified |\n\n"
        "[^e]: evals/run_e2e.py#L2\n[^w]: web/package.json#L1\n"
    ), revision)
    report = can.evaluate(str(repo), None, str(_yaml(tmp_path, {})), run=True, timeout=30)
    runs = [(r["cwd"], r["status"]) for r in report["runs"]]
    assert runs == [(".", "pass"), ("web", "pass")]
    for command in scanned.values():
        rel = command["locator"].split("#", 1)[0]
        assert _scan.command_cwd(rel, command["command"]) == command["cwd"]
