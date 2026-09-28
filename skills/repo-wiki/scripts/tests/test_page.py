import os
import stat

import pytest

import _config
import _markdown
import _page
from helpers import commit, git_repo, wiki_ws, write


def _repo(tmp_path, lang="en"):
    repo = git_repo(tmp_path / "repo", {"src/app.py": "x = 1\n"})
    return repo, wiki_ws(repo, lang)


def _head(repo):
    import _git

    return _git.head(repo)


def test_discovery_excludes_index_and_underscore_files(tmp_path):
    _, ws = _repo(tmp_path)
    meta = {"type": "Module", "title": "A", "description": "d"}
    write(ws.wiki / "b.md", meta, "B\n")
    write(ws.wiki / "modules/a.md", meta, "A\n")
    write(ws.wiki / "index.md", {"okf_version": "0.1"}, "idx\n")
    write(ws.wiki / "modules/index.md", meta, "idx\n")
    write(ws.wiki / "_draft.md", meta, "x\n")
    write(ws.wiki / "modules/_notes.md", meta, "x\n")
    (ws.wiki / "notes.txt").write_text("x", encoding="utf-8")
    pages = _page.load_pages(ws)
    assert [p.path for p in pages] == ["b.md", "modules/a.md"]
    assert pages[1].file == ws.wiki / "modules/a.md"
    assert pages[1].type == "Module"
    assert pages[1].body == "A\n"


def test_parse_errors_are_captured(tmp_path):
    _, ws = _repo(tmp_path)
    raw = "---\ntype: [unclosed\n---\n\nBody\n"
    (ws.wiki / "bad.md").write_text(raw, encoding="utf-8")
    (ws.wiki / "none.md").write_text("no frontmatter\n", encoding="utf-8")
    bad, none = _page.load_pages(ws)
    assert bad.path == "bad.md" and bad.meta == {} and bad.body == raw
    assert bad.error and "Invalid YAML" in bad.error
    assert none.error and none.meta == {} and none.body == "no frontmatter\n"
    assert bad.scope == [] and bad.revision == {} and bad.type is None
    with pytest.raises(_page.PageError):
        _page.write_page(bad)


def test_defaults_for_missing_or_malformed_keys(tmp_path):
    _, ws = _repo(tmp_path)
    write(ws.wiki / "a.md", {"type": "Table", "scope": "src/**", "revision": "x"}, "b\n")
    page = _page.load_page(ws, "a.md")
    assert page.scope == [] and page.revision == {} and page.status is None
    assert page.is_generated


def test_write_round_trip_keeps_content_sha_and_orders_keys(tmp_path):
    _, ws = _repo(tmp_path)
    body = "\n\nFirst line.[^a]\n\n[^a]: src/app.py#L1\n\n\n"
    meta = {
        "zeta": 1,
        "stamp": {"content_sha256": "0" * 64},
        "revision": {".": "1" * 40},
        "type": "Module",
        "alpha": 2,
        "title": "T",
        "description": "A very long description " * 10,
        "scope": ["src/**"],
        "status": "stable",
    }
    page = _page.Page("a.md", ws.wiki / "a.md", meta, body, None)
    _page.write_page(page)
    loaded = _page.load_page(ws, "a.md")
    assert loaded.body == body
    assert loaded.content_sha256() == page.content_sha256()
    assert loaded.meta == meta
    assert list(loaded.meta) == [
        "type", "title", "description", "scope", "status", "revision", "stamp",
        "alpha", "zeta",
    ]
    first = loaded.file_sha256()
    _page.write_page(loaded)
    again = _page.load_page(ws, "a.md")
    assert again.content_sha256() == loaded.content_sha256()
    assert again.file_sha256() == first
    lines = (ws.wiki / "a.md").read_text(encoding="utf-8").splitlines()
    # body line 3 (1-based) is file line body_offset + 3, i.e. list index - 1
    ((label, ref_line),) = again.structure.footnote_refs
    assert (label, ref_line) == ("a", 3)
    assert lines[again.body_offset + ref_line - 1] == "First line.[^a]"


def test_write_keeps_multiline_values_inside_frontmatter(tmp_path):
    _, ws = _repo(tmp_path)
    meta = {"type": "Module", "title": "T", "description": "x\n---\ny", "note": "a\n\n---\n"}
    page = _page.Page("a.md", ws.wiki / "a.md", meta, "Body\n", None)
    _page.write_page(page)
    loaded = _page.load_page(ws, "a.md")
    assert loaded.error is None
    assert loaded.meta == meta and loaded.body == "Body\n"


def test_write_refreshes_structure(tmp_path):
    _, ws = _repo(tmp_path)
    page = _page.Page("a.md", ws.wiki / "a.md", {"type": "Module"}, "", None)
    page.body = "Text.[^a]\n"
    _page.write_page(page)
    assert page.structure.footnote_refs == [("a", 1)]


def test_round_trip_from_hand_written_file(tmp_path):
    _, ws = _repo(tmp_path)
    (ws.wiki / "a.md").write_text(
        "---\ntitle: T\ntype: Module\n---\nText right after.\n", encoding="utf-8"
    )
    page = _page.load_page(ws, "a.md")
    sha = page.content_sha256()
    _page.write_page(page)
    assert _page.load_page(ws, "a.md").content_sha256() == sha
    # helpers.write (frontmatter.render) produces the same separation
    write(ws.wiki / "b.md", {"type": "Module"}, "Body\n")
    assert _page.load_page(ws, "b.md").body == "Body\n"


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_new_page(tmp_path, lang):
    repo, ws = _repo(tmp_path, lang)
    page = _page.new_page(ws, "modules/billing-run.md", "Module", "Read before X.",
                          scope=("src/**",))
    expected_title = "Billing Run" if lang == "en" else "billing-run"
    assert page.meta == {
        "type": "Module",
        "title": expected_title,
        "description": "Read before X.",
        "scope": ["src/**"],
        "status": "draft",
        "revision": {".": _head(repo)},
    }
    template = (_page.TEMPLATES / lang / "module.md").read_text(encoding="utf-8")
    assert page.body == template
    assert page.body.startswith(_page.TEMPLATE_TODO)
    assert page.is_untouched_stub
    assert page.todos == [(1, "")]
    page.body = page.body.replace(_page.TEMPLATE_TODO, "Real content.[^a]")
    _page.write_page(page)
    assert not _page.load_page(ws, "modules/billing-run.md").is_untouched_stub
    titled = _page.new_page(ws, "w.md", "Workflow", "d", title="Custom")
    assert titled.meta["title"] == "Custom" and titled.meta["scope"] == []


def test_new_page_rejects_bad_input(tmp_path):
    _, ws = _repo(tmp_path)
    for path in ("../x.md", "a/../b.md", "/abs.md", "index.md", "m/index.md",
                 "_x.md", "m/_x.md", "x.txt", "a\\b.md", ""):
        with pytest.raises(_page.PageError):
            _page.new_page(ws, path, "Module", "d")
    with pytest.raises(_page.PageError):
        _page.new_page(ws, "x.md", "Schema", "d")
    _page.new_page(ws, "x.md", "Module", "d")
    with pytest.raises(_page.PageError, match="already exists"):
        _page.new_page(ws, "x.md", "Module", "d")


def test_new_page_rejects_scope_globs_without_tracked_files(tmp_path):
    repo, ws = _repo(tmp_path)
    (repo / "src/untracked.py").write_text("y = 1\n", encoding="utf-8")
    for glob in ("src/billing/**", "src/untracked.py", "docs/wiki/**", "lib"):
        with pytest.raises(_page.PageError, match="matches no tracked file"):
            _page.new_page(ws, "m.md", "Module", "d", [glob])
    assert not (ws.wiki / "m.md").exists()
    assert _page.new_page(ws, "m.md", "Module", "d", ["src", "**/*.py"]).scope == ["src", "**/*.py"]


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_create_canon(tmp_path, lang):
    repo, ws = _repo(tmp_path, lang)
    pages = _page.create_canon(ws)
    assert [p.path for p in pages] == ["architecture.md", "glossary.md", "conventions.md"]
    head = _head(repo)
    for page in pages:
        assert page.type in _page.CANON and _page.CANON[page.type] == page.path
        assert page.meta["scope"] == [] and page.status == "draft"
        assert page.revision == {".": head}
        assert page.meta["title"] and page.meta["description"]
        assert page.is_untouched_stub
    titles = [p.meta["title"] for p in pages]
    assert titles == (
        ["Architecture", "Glossary", "Conventions"] if lang == "en" else ["架构", "术语表", "开发规范"]
    )
    kinds = {p.type: set(_page.tables(p)) for p in pages}
    assert kinds == {
        "Architecture": {"not_covered"},
        "Glossary": {"glossary"},
        "Conventions": {"commands", "rules"},
    }


def test_init_creates_canon_stubs(tmp_path):
    repo = git_repo(tmp_path / "repo", {"a.txt": "a\n"})
    ws = _config.init(repo, lang="zh", create_canon=True)
    pages = _page.load_pages(ws)
    assert [p.path for p in pages] == ["architecture.md", "conventions.md", "glossary.md"]
    assert all(p.is_untouched_stub for p in pages)
    assert all(p.revision == {".": _head(repo)} and p.error is None for p in pages)
    assert {p.meta["title"] for p in pages} == {"架构", "开发规范", "术语表"}


def test_current_revision_hub(tmp_path):
    hub = git_repo(tmp_path / "hub", {".gitignore": "/api/\n/worker/\n"})
    api = git_repo(hub / "api", {"a.py": "a\n"})
    worker = git_repo(hub / "worker", {"w.py": "w\n"})
    ws = _config.init(hub, hub_sources=["api", "worker"], create_canon=False)
    assert _page.current_revision(ws) == {"api": _head(api), "worker": _head(worker)}


def _stamped(ws, body):
    meta = {
        "type": "Module", "title": "T", "description": "d", "scope": ["src/**"],
        "status": "stable", "revision": {".": "a" * 40},
        "sources": [{"id": "a", "resource": "src/app.py#L1"}],
        "generated": {"by": "x", "at": "2026-01-01T00:00:00Z"},
        "verified": [{"by": "y", "at": "2026-01-01T00:00:00Z"}],
        "stamp": {"content_sha256": "0" * 64},
        "tags": ["t"],
    }
    write(ws.wiki / "m.md", meta, body)
    return _page.load_page(ws, "m.md")


def test_mark_draft_inserts_fresh_block(tmp_path):
    repo, ws = _repo(tmp_path)
    head = commit(repo, {"src/app.py": "x = 2\n"})
    page = _stamped(ws, "Text.[^a]\n\n[^a]: src/app.py#L1\n")
    _page.mark_draft(ws, page, ["src/app.py changed", "src/b.py deleted"])
    loaded = _page.load_page(ws, "m.md")
    assert loaded.status == "draft"
    assert loaded.revision == {".": head}
    for key in ("sources", "generated", "verified", "stamp"):
        assert key not in loaded.meta
    assert loaded.meta["tags"] == ["t"]
    assert loaded.body == (
        "<!-- okf:todo\n- src/app.py changed\n- src/b.py deleted\n-->\n\n"
        "Text.[^a]\n\n[^a]: src/app.py#L1\n"
    )
    assert loaded.todos == [(1, "- src/app.py changed\n- src/b.py deleted")]
    assert loaded.body == page.body


def test_mark_draft_merges_into_existing_block(tmp_path):
    _, ws = _repo(tmp_path)
    page = _stamped(ws, "<!-- okf:todo\nBrief: check retry\n-->\n\nText.\n")
    _page.mark_draft(ws, page, ["new reason"])
    loaded = _page.load_page(ws, "m.md")
    assert loaded.body == "<!-- okf:todo\nBrief: check retry\n- new reason\n-->\n\nText.\n"
    assert len(loaded.todos) == 1
    # the empty template block
    _page.new_page(ws, "n.md", "Module", "d")
    stub = _page.load_page(ws, "n.md")
    _page.mark_draft(ws, stub, ["r"])
    assert _page.load_page(ws, "n.md").body.startswith("<!-- okf:todo\n- r\n-->\n")
    # a single-line block
    page = _stamped(ws, "<!-- okf:todo brief -->\nText.\n")
    _page.mark_draft(ws, page, ["r1"])
    assert _page.load_page(ws, "m.md").body == "<!-- okf:todo brief\n- r1\n-->\nText.\n"
    # no space after '<!--' is still the leading todo block
    page = _stamped(ws, "<!--okf:todo\nA\n-->\nText.\n")
    _page.mark_draft(ws, page, ["r2"])
    assert _page.load_page(ws, "m.md").body == "<!--okf:todo\nA\n- r2\n-->\nText.\n"


def test_mark_draft_ignores_non_leading_or_other_comments(tmp_path):
    _, ws = _repo(tmp_path)
    page = _stamped(ws, "<!-- note -->\nText.\n\n<!-- okf:todo\nlater\n-->\n")
    _page.mark_draft(ws, page, ["r"])
    loaded = _page.load_page(ws, "m.md")
    assert loaded.body == (
        "<!-- okf:todo\n- r\n-->\n\n<!-- note -->\nText.\n\n<!-- okf:todo\nlater\n-->\n"
    )
    assert [text for _, text in loaded.todos] == ["- r", "later"]


def test_mark_draft_keeps_block_closed(tmp_path):
    _, ws = _repo(tmp_path)
    page = _stamped(ws, "Text.\n")
    _page.mark_draft(ws, page, ["weird --> reason\nsecond line"])
    loaded = _page.load_page(ws, "m.md")
    assert loaded.todos == [(1, "- weird -> reason second line")]
    assert loaded.body.endswith("Text.\n")


TABLES_EN = """\
| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | Pass. | job | `BillingRun`[^br] |
| Ledger | Book. | | `Ledger`[^led] `x`[^br] |

| Purpose | Command | Status |
|---|---|---|
| Tests | `pytest`[^pt] | verified |

|  AREA | rule | Enforced BY |
|:--|--|--:|
| errors | Raise `DomainError`.[^err] `[^fake]` | convention |

| Invariant | Enforced at | Breaks when |
|---|---|---|

| Path | Reason |
|---|---|
| `third_party/` | Vendored. |

| Change | Start at | Also change | Verify |
|---|---|---|---|
| a | b | c | d |

[^br]: src/app.py#L1
[^led]: src/app.py
[^pt]: Makefile#L3
[^err]: src/app.py#L1-L1
"""

TABLES_ZH = """\
| 术语 | 定义 | 勿用别名 | 代码位置 |
|---|---|---|---|
| 计费 | 批处理。 | 作业 | `BillingRun`[^br] |

| 用途 | 命令 | 状态 |
|---|---|---|
| 测试 | `pytest`[^pt] | not-run |

| 类别 | 规则 | 检查方式 |
|---|---|---|

| 关键约束 | 由谁保证 | 违反会怎样 |
|---|---|---|
| 不可变 | `a.py`[^inv] | 数据损坏 |

| 路径 | 原因 |
|---|---|
"""


def test_tables_en(tmp_path):
    _, ws = _repo(tmp_path)
    write(ws.wiki / "c.md", {"type": "Glossary"}, TABLES_EN)
    found = _page.tables(_page.load_page(ws, "c.md"))
    assert set(found) == {"glossary", "commands", "rules", "invariants", "not_covered", "change_guide"}
    assert found["change_guide"][0].rows[0].footnotes == []
    glossary = found["glossary"][0]
    assert glossary.kind == "glossary" and glossary.line == 1
    assert glossary.header == ["Term", "Meaning", "Avoid", "Where"]
    assert [(r.cells[0], r.line, r.footnotes) for r in glossary.rows] == [
        ("Billing run", 3, ["br"]),
        ("Ledger", 4, ["led", "br"]),
    ]
    assert glossary.rows[1].cells[2] == ""
    assert found["commands"][0].rows[0].footnotes == ["pt"]
    assert found["commands"][0].rows[0].cells[2] == "verified"
    assert found["rules"][0].rows[0].footnotes == ["err"]
    assert found["invariants"][0].rows == []
    assert found["not_covered"][0].rows[0].footnotes == []


def test_tables_zh(tmp_path):
    _, ws = _repo(tmp_path, "zh")
    write(ws.wiki / "c.md", {"type": "Conventions"}, TABLES_ZH)
    found = _page.tables(_page.load_page(ws, "c.md"))
    assert set(found) == {"glossary", "commands", "rules", "invariants", "not_covered"}
    assert found["glossary"][0].rows[0].footnotes == ["br"]
    assert found["commands"][0].rows[0].cells[2] == "not-run"
    assert found["rules"][0].rows == []
    assert found["invariants"][0].rows[0].footnotes == ["inv"]


def test_templates_carry_the_change_guide_table_and_hints():
    for lang in ("en", "zh"):
        for type in ("Module", "Workflow"):
            structure = _markdown.extract(_page.template(lang, type))
            kinds = [_page.table_kind(t.header) for t in structure.tables]
            assert kinds == ["change_guide"], (lang, type, kinds)
            assert structure.hints and not any("okf:hint" in text for _, text in structure.hints)


def test_sources_from_footnotes(tmp_path):
    _, ws = _repo(tmp_path)
    body = (
        "Second defined, first referenced.[^b] Then[^a] and again[^b].\n"
        "Missing def[^nodef]; bad locator[^bad]; in code `[^code]`.\n"
        "Empty[^empty] and noted[^note]. Bad label[^_x].\n\n"
        "[^a]: src/app.py#L2-L3\n"
        "[^b]: src/app.py#L1-L1 the call site\n"
        "[^bad]: /etc/passwd\n"
        "[^code]: src/app.py\n"
        "[^empty]:\n"
        "[^note]: src/app.py#L4 some note\n"
        "[^_x]: src/app.py\n"
        "[^unused]: src/app.py\n"
    )
    write(ws.wiki / "m.md", {"type": "Module"}, body)
    assert _page.sources_from_footnotes(_page.load_page(ws, "m.md")) == [
        {"id": "b", "resource": "src/app.py#L1"},
        {"id": "a", "resource": "src/app.py#L2-L3"},
        {"id": "note", "resource": "src/app.py#L4"},
    ]


def test_crlf_page_parses_like_lf(tmp_path):
    _, ws = _repo(tmp_path)
    text = "---\ntype: Module\ntitle: T\n---\n\nFirst.[^a]\n\n[^a]: src/app.py#L1\n"
    (ws.wiki / "lf.md").write_text(text, encoding="utf-8", newline="\n")
    (ws.wiki / "crlf.md").write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
    lf, crlf = _page.load_page(ws, "lf.md"), _page.load_page(ws, "crlf.md")
    assert (crlf.meta, crlf.body, crlf.body_offset) == (lf.meta, lf.body, lf.body_offset)
    assert crlf.structure == lf.structure
    assert crlf.content_sha256() == lf.content_sha256() and crlf.file_sha256() == lf.file_sha256()


def test_form_feed_does_not_split_body_lines(tmp_path):
    _, ws = _repo(tmp_path)
    (ws.wiki / "a.md").write_text("---\ntype: Module\n---\n\nA\x0cB C\nRef.[^a]\n", encoding="utf-8")
    assert _page.load_page(ws, "a.md").structure.footnote_refs == [("a", 2)]


@pytest.mark.skipif(os.name == "nt", reason="posix permissions")
def test_write_keeps_file_permissions(tmp_path):
    _, ws = _repo(tmp_path)
    page = _page.new_page(ws, "a.md", "Module", "d", ["src/**"])
    mask = os.umask(0)
    os.umask(mask)
    assert stat.S_IMODE(page.file.stat().st_mode) == 0o666 & ~mask  # not mkstemp's 0600
    page.file.chmod(0o640)
    page.body += "More.\n"
    _page.write_page(page)
    assert stat.S_IMODE(page.file.stat().st_mode) == 0o640
