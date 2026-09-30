import _page
import _validate
from helpers import commit
from kit import BILLING, GLOSSARY, complete, set_body


def codes(ws, severity=None):
    return sorted(
        {(i.code, i.page) for i in _validate.validate(ws) if severity is None or i.severity == severity}
    )


def test_complete_wiki_has_no_errors(tmp_path):
    _, ws = complete(tmp_path)
    issues = _validate.validate(ws)
    assert [i for i in issues if i.severity != "warning"] == []


def test_todo_block_is_pending(tmp_path):
    _, ws = complete(tmp_path)
    set_body(ws, "modules/billing.md", "<!-- okf:todo\nBrief: x\n-->\n\n" + BILLING)
    issues = _validate.validate(ws)
    todo = [i for i in issues if i.code == "todo"]
    assert todo and todo[0].severity == "pending" and todo[0].page == "modules/billing.md"


def test_locator_rules(tmp_path):
    _, ws = complete(tmp_path, {".env": "KEY=1\n"})
    body = BILLING.replace("src/billing/run.py#L2-L5", "src/billing/run.py#L2-L99")
    body += "Also[^a] and[^b] and[^c].\n\n[^a]: src/nope.py\n[^b]: ./src/billing/run.py\n[^c]: .env\n"
    set_body(ws, "modules/billing.md", body)
    messages = [i.message for i in _validate.validate(ws) if i.code == "locator"]
    assert any("past the end" in m for m in messages)
    assert any("not a tracked file" in m for m in messages)
    assert any("invalid locator" in m for m in messages)
    assert any("secret file" in m for m in messages)


def test_locators_resolve_at_page_revision(tmp_path):
    root, ws = complete(tmp_path)
    commit(root, {"src/billing/run.py": "x = 1\n"})
    issues = _validate.validate(ws)
    # The draft revision is behind HEAD: revision error, but locators are still
    # read at the recorded revision and stay valid.
    assert {"revision"} == {i.code for i in issues if i.severity == "error"} - {"coverage"}


def test_wiki_only_commit_keeps_drafts_current(tmp_path):
    root, ws = complete(tmp_path)
    commit(root, {}, "wiki progress")
    assert not [i for i in _validate.validate(ws) if i.code == "revision"]


def test_footnote_join_and_required_citation(tmp_path):
    _, ws = complete(tmp_path)
    body = GLOSSARY.replace("`BillingRun`[^run]", "`BillingRun`") + "Unused.[^missing]\n"
    set_body(ws, "glossary.md", body)
    found = codes(ws, "error")
    assert ("required-citation", "glossary.md") in found
    assert ("footnote-join", "glossary.md") in found


def test_table_values(tmp_path):
    _, ws = complete(tmp_path)
    conventions = _page.load_page(ws, "conventions.md").body
    set_body(ws, "conventions.md", conventions.replace("| verified |", "| done |").replace("| testing |", "| co-change |"))
    messages = [i.message for i in _validate.validate(ws) if i.code == "table-values"]
    assert len(messages) == 2


def test_coverage_scope_and_not_covered(tmp_path):
    _, ws = complete(tmp_path, {"docs_src/x.py": "x = 1\n"})
    page = _page.load_page(ws, "modules/billing.md")
    page.meta["scope"] = ["src/billing/**", "src/nothing/**"]
    _page.write_page(page)
    arch = _page.load_page(ws, "architecture.md").body
    set_body(ws, "architecture.md", arch + "| `gone/` | Old code. |\n")
    found = codes(ws, "error")
    assert ("coverage", "architecture.md") in found  # docs_src module unmapped
    assert ("scope", "modules/billing.md") in found
    assert ("not-covered", "architecture.md") in found


def test_alias_why_and_parrot_warnings(tmp_path):
    _, ws = complete(tmp_path)
    body = BILLING + (
        "\nThe invoice job retries because gateways time out.\n\n"
        "Why: rationale not recorded, because nobody wrote it down.\n\n"
        "| Name | Kind |\n|---|---|\n| `post` | `method` |\n| `MAX` | `int` |\n"
    )
    set_body(ws, "modules/billing.md", body)
    warnings = [i for i in _validate.validate(ws) if i.severity == "warning"]
    assert {i.code for i in warnings} == {"alias", "uncited-why", "parrot"}
    assert len([i for i in warnings if i.code == "uncited-why"]) == 1


def test_alias_in_code_span_is_allowed(tmp_path):
    _, ws = complete(tmp_path)
    set_body(ws, "modules/billing.md", BILLING + "\nSee `invoice job` in logs.\n")
    assert not [i for i in _validate.validate(ws) if i.code == "alias"]


def test_secret_and_mermaid_and_link(tmp_path):
    _, ws = complete(tmp_path)
    body = BILLING + (
        "\nkey: AKIAABCDEFGHIJKLMNOP\n\n```mermaid\nflowchart LR\n  a -->\n```\n\n"
        "[missing](/modules/none.md) and [ok](/glossary.md)\n"
    )
    set_body(ws, "modules/billing.md", body)
    found = {i.code for i in _validate.validate(ws) if i.severity == "error"}
    assert {"secret", "mermaid", "link"} <= found


def test_canon_missing_and_empty(tmp_path):
    _, ws = complete(tmp_path)
    (ws.wiki / "glossary.md").unlink()
    set_body(ws, "conventions.md", "## Commands\n\n| Purpose | Command | Status |\n|---|---|---|\n")
    found = codes(ws)
    assert ("canon-missing", "glossary.md") in found
    assert ("canon-table", "conventions.md") in found  # no rules table
    assert ("canon-empty", "conventions.md") in found


def test_stable_page_edit_is_caught(tmp_path):
    _, ws = complete(tmp_path)
    page = _page.load_page(ws, "modules/billing.md")
    page.meta |= {"status": "stable", "stamp": {"content_sha256": "0" * 64}, "sources": _page.sources_from_footnotes(page)}
    _page.write_page(page)
    assert ("unreviewed-edit", "modules/billing.md") in codes(ws, "error")


def test_frontmatter_errors(tmp_path):
    _, ws = complete(tmp_path)
    page = _page.load_page(ws, "modules/billing.md")
    page.meta["scope"] = []
    page.meta["revision"] = {".": "abc"}
    page.meta["status"] = "done"
    _page.write_page(page)
    messages = [i.message for i in _validate.validate(ws) if i.code == "frontmatter"]
    assert len(messages) == 3


def test_only_filters_reported_pages(tmp_path):
    _, ws = complete(tmp_path)
    set_body(ws, "glossary.md", "broken[^x]\n")
    issues = _validate.validate(ws, only=["modules/billing.md"])
    assert all(i.page == "modules/billing.md" for i in issues)


def test_nested_module_is_not_covered_by_its_child_scope(tmp_path):
    _, ws = complete(tmp_path, {
        "svc/go.mod": "module svc\n", "svc/main.go": "package main\n",
        "svc/plugin/go.mod": "module plugin\n", "svc/plugin/p.go": "package plugin\n",
    })
    _page.new_page(ws, "Module", "plugin", "Read before changing the plugin.",
                   ["svc/plugin/**"])
    set_body(ws, "modules/plugin.md", "## Responsibility and boundaries\n\nPlugin.\n")
    messages = [i.message for i in _validate.validate(ws) if i.code == "coverage"]
    # svc owns svc/main.go; a scope inside svc/plugin says nothing about it.
    assert messages == ["module svc is in no page scope"]
    page = _page.load_page(ws, "modules/plugin.md")
    page.meta["scope"] = ["svc/**"]
    _page.write_page(page)
    assert [i for i in _validate.validate(ws) if i.code == "coverage"] == []


def test_secret_in_frontmatter_is_caught(tmp_path):
    # Frontmatter title/description/tags are copied into index.md (I8).
    _, ws = complete(tmp_path)
    page = _page.load_page(ws, "modules/billing.md")
    page.meta["description"] = "Token AKIAABCDEFGHIJKLMNOP for billing."
    _page.write_page(page)
    secrets = [i for i in _validate.validate(ws) if i.code == "secret"]
    lines = (ws.wiki / "modules/billing.md").read_text(encoding="utf-8").split("\n")
    assert [(i.page, i.severity) for i in secrets] == [("modules/billing.md", "error")]
    assert "AKIA" in lines[secrets[0].line - 1] and secrets[0].line <= page.body_offset


def test_line_counts_split_on_newline_only(tmp_path):
    # git counts one line in "a = 1\fb = 2\n"; str.splitlines counted two (also for
    # U+2028 and a lone CR), so #L2 was accepted.
    files = {"src/billing/ff.py": "a = 1\x0cb = 2 c\rd\n"}
    _, ws = complete(tmp_path, files)
    set_body(ws, "modules/billing.md", BILLING + "\nOne line.[^ff]\n\n[^ff]: src/billing/ff.py#L2\n")
    messages = [i.message for i in _validate.validate(ws) if i.code == "locator"]
    assert messages == ["[^ff]: src/billing/ff.py#L2 is past the end of the file (1 lines)"]


def test_required_sections_per_type(tmp_path):
    _, ws = complete(tmp_path)
    assert not [i for i in _validate.validate(ws) if i.code == "section"]
    set_body(ws, "modules/billing.md", BILLING.replace("## How it works", "## Overview"))
    arch = _page.load_page(ws, "architecture.md").body
    set_body(ws, "architecture.md", arch.replace("## Not covered", "## Skipped paths"))
    conventions = _page.load_page(ws, "conventions.md").body
    set_body(ws, "conventions.md", conventions.replace("## Rules", "### rules"))  # any level, any case
    _page.new_page(ws, "Workflow", "post", "Read before posting.", ["src/billing/**"])
    set_body(ws, "workflows/post.md", "## Making changes\n\nPosting.\n")
    found = {(i.page, i.message) for i in _validate.validate(ws) if i.code == "section"}
    assert found == {
        ("modules/billing.md", "Module page lacks the section 'How it works' (工作原理)"),
        ("architecture.md", "Architecture page lacks the section 'Not covered' (未单独成页)"),
        ("workflows/post.md", "Workflow page lacks the section 'Flow' (执行流程)"),
    }
    assert all(i.severity == "error" for i in _validate.validate(ws) if i.code == "section")
    # The zh heading satisfies the rule in an en wiki too; other headings are free.
    set_body(ws, "workflows/post.md", "## 执行流程\n\nPosting.\n\n## 修改指南\n\n## Retry and idempotency\n")
    assert "workflows/post.md" not in {i.page for i in _validate.validate(ws) if i.code == "section"}


def test_module_and_workflow_pages_need_a_change_guide_row(tmp_path):
    _, ws = complete(tmp_path)
    assert not [i for i in _validate.validate(ws) if i.code == "change-guide"]
    empty = BILLING.replace("| Change posting | `BillingRun.post`[^posted] | - | `tests/test_run.py` |\n", "")
    set_body(ws, "modules/billing.md", empty)
    found = [i for i in _validate.validate(ws) if i.code == "change-guide"]
    assert [(i.page, i.severity) for i in found] == [("modules/billing.md", "error")]
    # While a todo block says the page is being written, the row is not asked for yet.
    set_body(ws, "modules/billing.md", "<!-- okf:todo\nlead\n-->\n\n" + empty)
    assert not [i for i in _validate.validate(ws) if i.code == "change-guide"]
    # Start at and Verify must say something; Also change may be a dash.
    set_body(ws, "modules/billing.md", BILLING.replace("| `tests/test_run.py` |", "| - |"))
    messages = [i.message for i in _validate.validate(ws) if i.code == "table-values"]
    assert messages == ["change guide row has no Verify: 'Change posting'"]


def test_template_hints_are_pending_until_deleted(tmp_path):
    _, ws = complete(tmp_path)
    set_body(ws, "modules/billing.md", BILLING.replace(
        "Billing posts invoices.", "Billing posts invoices.\n\n<!-- okf:hint say more\nover lines -->"))
    found = [(i.code, i.severity, i.line) for i in _validate.validate(ws) if i.code == "hint"]
    assert len(found) == 1 and found[0][:2] == ("hint", "pending")
    stub = _page.new_page(ws, "Workflow", "post", "Read before posting.", ["src/billing/**"])
    assert len(stub.structure.hints) == 3


def test_zh_templates_carry_their_required_sections(tmp_path):
    from helpers import git_repo, wiki_ws

    repo = git_repo(tmp_path / "zh", {"src/a.py": "x = 1\n"})
    ws = wiki_ws(repo, "zh")
    _page.create_canon(ws)
    _page.new_page(ws, "Module", "a", "d", ["src/**"])
    _page.new_page(ws, "Workflow", "a", "d", ["src/**"])
    assert not [i for i in _validate.validate(ws) if i.code == "section"]


def test_rule_areas_have_vcs_and_no_extension(tmp_path):
    _, ws = complete(tmp_path)
    conventions = _page.load_page(ws, "conventions.md").body
    rows = ("| vcs | Commit subjects are imperative.[^test] | review |\n"
            "| extension | Plugins register in one table.[^test] | review |\n")
    set_body(ws, "conventions.md", conventions.replace("\n[^test]", rows + "\n[^test]"))
    messages = [i.message for i in _validate.validate(ws) if i.code == "table-values"]
    assert messages == ["Area 'extension' is not allowed"]
    assert "vcs" in _page.RULE_AREAS and "extension" not in _page.RULE_AREAS
