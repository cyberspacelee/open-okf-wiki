import pathlib
import dataclasses
import pytest

import _validate
from _validate import validate_page, validate_target, validate_candidate


# --- stub workspace ---

@dataclasses.dataclass
class StubSource:
    name: str
    path: pathlib.Path
    origin: str = "self"


@dataclasses.dataclass
class StubWorkspace:
    root: pathlib.Path
    sources: dict

    def resolve_locator(self, locator: str) -> pathlib.Path | None:
        anchor_stripped = locator.split("#")[0]
        candidate = (self.root / anchor_stripped).resolve()
        try:
            candidate.relative_to(self.root.resolve())
        except ValueError:
            return None
        return candidate


def make_ws(tmp_path):
    src = StubSource(name="self", path=tmp_path)
    return StubWorkspace(root=tmp_path, sources={"self": src})


def write_page(tmp_path, rel, content):
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


GOOD_PAGE = """\
---
type: overview
title: Test Page
description: A test page.
coverage: full
sources:
  - id: ref1
    resource: somefile.py
---

## Overview

Some content here. [^ref1]

[^ref1]: somefile.py title
"""


# ===== frontmatter-missing =====

def test_frontmatter_missing_trigger(tmp_path):
    p = write_page(tmp_path, "page.md", "No frontmatter here\n")
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "frontmatter-missing" for i in issues)


def test_frontmatter_missing_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "frontmatter-missing" for i in issues)


# ===== frontmatter-error =====

def test_frontmatter_error_trigger(tmp_path):
    p = write_page(tmp_path, "page.md", "---\nduplicate: a\nduplicate: b\n---\nbody\n")
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "frontmatter-error" for i in issues)


def test_frontmatter_error_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "frontmatter-error" for i in issues)


# ===== field-missing =====

def test_field_missing_trigger(tmp_path):
    p = write_page(tmp_path, "page.md", "---\ntype: x\n---\nbody\n")
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    codes = [i["code"] for i in issues]
    assert codes.count("field-missing") >= 4  # title, description, coverage, sources missing


def test_field_missing_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "field-missing" for i in issues)


# ===== coverage-invalid =====

def test_coverage_invalid_trigger(tmp_path):
    p = write_page(tmp_path, "page.md",
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: bad\nsources:\n---\nbody\n")
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "coverage-invalid" for i in issues)


def test_coverage_invalid_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "coverage-invalid" for i in issues)


# ===== footnote-unmatched =====

def test_footnote_unmatched_trigger(tmp_path):
    content = "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\nSee [^missing]\n"
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "footnote-unmatched" for i in issues)


def test_footnote_unmatched_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "footnote-unmatched" for i in issues)


# ===== source-unused =====

def test_source_unused_trigger(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: unused\n    resource: catalog:foo\n---\n\n## Sec\n\nBody with no ref.\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "source-unused" for i in issues)


def test_source_unused_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "source-unused" for i in issues)


# ===== locator-unresolved =====

def test_locator_unresolved_trigger(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: r1\n    resource: does_not_exist.py\n---\n\nSee [^r1]\n\n[^r1]: x\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "locator-unresolved" for i in issues)


def test_locator_unresolved_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "locator-unresolved" for i in issues)


# ===== line-range-invalid =====

def test_line_range_invalid_trigger(tmp_path):
    (tmp_path / "short.py").write_text("a\nb\n")
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: r1\n    resource: short.py#L5-L10\n---\n\nSee [^r1]\n\n[^r1]: x\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "line-range-invalid" for i in issues)


def test_line_range_invalid_trigger_inverted(tmp_path):
    (tmp_path / "myfile.py").write_text("a\nb\nc\nd\ne\n")
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: r1\n    resource: myfile.py#L5-L2\n---\n\nSee [^r1]\n\n[^r1]: x\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "line-range-invalid" for i in issues)


def test_line_range_invalid_not_triggered(tmp_path):
    (tmp_path / "myfile.py").write_text("a\nb\nc\nd\ne\n")
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: r1\n    resource: myfile.py#L1-L3\n---\n\nSee [^r1]\n\n[^r1]: x\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "line-range-invalid" for i in issues)


# ===== placeholder-remaining =====

def test_placeholder_remaining_trigger(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n{{TODO: fill this}}\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "placeholder-remaining" for i in issues)


def test_placeholder_remaining_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "placeholder-remaining" for i in issues)


# ===== section-empty =====

def test_section_empty_trigger_full(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n## Overview\n\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "section-empty" and i["severity"] == "error" for i in issues)


def test_section_empty_trigger_partial_is_warning(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: partial\nsources:\n---\n\n## Overview\n\n## Gaps\n\nsome gap\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "section-empty" and i["severity"] == "warning" for i in issues)


def test_section_empty_not_triggered(tmp_path):
    (tmp_path / "somefile.py").write_text("x\n")
    p = write_page(tmp_path, "page.md", GOOD_PAGE)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "section-empty" for i in issues)


def test_section_empty_h2_leading_h3_is_ok(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n"
        "## Concepts\n\n### encoder\n\ndetail here\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "section-empty" for i in issues)


def test_section_empty_h2_then_empty_h2_still_triggers(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n"
        "## Empty\n\n## Filled\n\ntext\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "section-empty" for i in issues)


# ===== gaps-missing =====

def test_gaps_missing_trigger(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: partial\nsources:\n---\n\n## Overview\n\nsome content\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "gaps-missing" for i in issues)


def test_gaps_missing_not_triggered(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: partial\nsources:\n---\n\n## Overview\n\nsome content\n\n## Gaps\n\nmissing X\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "gaps-missing" for i in issues)


# ===== causal-unanchored =====

def test_causal_unanchored_trigger(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n"
        "This works because it is designed that way.\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "causal-unanchored" for i in issues)


def test_causal_unanchored_not_triggered_with_ref(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n"
        "  - id: r1\n    resource: catalog:foo\n---\n\n"
        "This works because of design. [^r1]\n\n[^r1]: ref\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert not any(i["code"] == "causal-unanchored" for i in issues)


def test_causal_unanchored_chinese(tmp_path):
    content = (
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n"
        "为了提高性能,我们重写了模块。\n"
    )
    p = write_page(tmp_path, "page.md", content)
    ws = make_ws(tmp_path)
    issues = validate_page(ws, p)
    assert any(i["code"] == "causal-unanchored" for i in issues)


# ===== validate_target: missing-target =====

def test_validate_target_missing(tmp_path):
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "survey", "nonexistent")
    assert any(i["code"] == "missing-target" for i in issues)


def test_validate_target_review_missing_report(tmp_path):
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "review", "candidate")
    assert any(i["code"] == "missing-target" for i in issues)


def test_validate_target_review_verdict_missing(tmp_path):
    ws = make_ws(tmp_path)
    report = tmp_path / ".okf-wiki" / "drafts" / "review" / "candidate.md"
    report.parent.mkdir(parents=True)
    report.write_text("looks good overall\n")
    issues = validate_target(ws, "review", "candidate")
    assert any(i["code"] == "review-verdict-missing" for i in issues)


def test_validate_target_review_verdict_ok(tmp_path):
    ws = make_ws(tmp_path)
    report = tmp_path / ".okf-wiki" / "drafts" / "review" / "candidate.md"
    report.parent.mkdir(parents=True)
    report.write_text("approved\n\nno issues found\n")
    assert validate_target(ws, "review", "candidate") == []


def test_validate_target_inspect_returns_empty(tmp_path):
    ws = make_ws(tmp_path)
    assert validate_target(ws, "inspect", "anything") == []


def test_validate_target_publish_returns_empty(tmp_path):
    ws = make_ws(tmp_path)
    assert validate_target(ws, "publish", "anything") == []


# ===== draft contract: survey =====

SURVEY_COMPLETE = """\
## Area

Some area.

## Domains

Some domains.

## Leads

Some leads.

## Remaining

none

## Gaps

some gaps
"""

SURVEY_INCOMPLETE = """\
## Area

Some area.

## Domains

Some domains.

## Leads

Some leads.

## Remaining

still working

## Gaps

some gaps
"""

SURVEY_MISSING_SECTION = """\
## Area

Some area.

## Domains

Some domains.

## Remaining

none

## Gaps

gaps here
"""


def test_survey_complete(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "survey"
    d.mkdir(parents=True)
    (d / "topic.md").write_text(SURVEY_COMPLETE)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "survey", "topic")
    assert not any(i["severity"] == "error" for i in issues)


def test_survey_incomplete(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "survey"
    d.mkdir(parents=True)
    (d / "topic.md").write_text(SURVEY_INCOMPLETE)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "survey", "topic")
    assert any(i["code"] == "draft-incomplete" for i in issues)


def test_survey_missing_section(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "survey"
    d.mkdir(parents=True)
    (d / "topic.md").write_text(SURVEY_MISSING_SECTION)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "survey", "topic")
    assert any(i["code"] == "draft-section-missing" for i in issues)


# ===== draft contract: synthesize =====

SYNTHESIZE_COMPLETE = """\
## Topology

Some topology.

## Connections

Some connections.

## Unverified leads

Some leads.

## Remaining

none

## Gaps

some gaps
"""


def test_synthesize_complete(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "synthesize"
    d.mkdir(parents=True)
    (d / "topic.md").write_text(SYNTHESIZE_COMPLETE)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "synthesize", "topic")
    assert not any(i["severity"] == "error" for i in issues)


def test_synthesize_incomplete(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "synthesize"
    d.mkdir(parents=True)
    content = SYNTHESIZE_COMPLETE.replace("## Remaining\n\nnone", "## Remaining\n\nstill pending")
    (d / "topic.md").write_text(content)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "synthesize", "topic")
    assert any(i["code"] == "draft-incomplete" for i in issues)


def test_synthesize_missing_section(tmp_path):
    d = tmp_path / ".okf-wiki" / "drafts" / "synthesize"
    d.mkdir(parents=True)
    content = "\n".join(l for l in SYNTHESIZE_COMPLETE.splitlines() if "## Topology" not in l)
    (d / "topic.md").write_text(content)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "synthesize", "topic")
    assert any(i["code"] == "draft-section-missing" for i in issues)


# ===== validate_target: write =====

def test_validate_target_write_missing(tmp_path):
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "write", "nofile.md")
    assert any(i["code"] == "missing-target" for i in issues)


def test_validate_target_write_runs_validate_page(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "p.md").write_text("no frontmatter\n")
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "write", "p.md")
    assert any(i["code"] == "frontmatter-missing" for i in issues)


# ===== validate_target: derive =====

def test_derive_missing_agents_block(tmp_path):
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "derive", "")
    assert any(i["code"] == "missing-target" for i in issues)


def test_derive_valid_block(tmp_path):
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    content = "# AGENTS\n<!-- okf-wiki:begin run=1 -->\npointer 1\npointer 2\n<!-- okf-wiki:end -->\n"
    (props / "agents-block1.md").write_text(content)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "derive", "")
    assert not issues


def test_derive_unmatched_begin(tmp_path):
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    content = "# AGENTS\n<!-- okf-wiki:begin run=1 -->\npointer 1\n"
    (props / "agents-block1.md").write_text(content)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "derive", "")
    assert any(i["code"] == "missing-target" for i in issues)


def test_derive_block_too_long(tmp_path):
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    lines = "\n".join(f"line{i}" for i in range(20))
    content = f"<!-- okf-wiki:begin run=1 -->\n{lines}\n<!-- okf-wiki:end -->\n"
    (props / "agents-block1.md").write_text(content)
    ws = make_ws(tmp_path)
    issues = validate_target(ws, "derive", "")
    assert any(i["code"] == "missing-target" for i in issues)


# ===== validate_candidate: broken-link =====

def test_broken_link_trigger(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "page.md").write_text(
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n[broken](missing.md)\n"
    )
    ws = make_ws(tmp_path)
    issues = validate_candidate(ws)
    assert any(i["code"] == "broken-link" for i in issues)


def test_broken_link_not_triggered(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "page.md").write_text(
        "---\ntype: x\ntitle: t\ndescription: d\ncoverage: full\nsources:\n---\n\n[other](other.md)\n"
    )
    (cand / "other.md").write_text(
        "---\ntype: x\ntitle: o\ndescription: d\ncoverage: full\nsources:\n---\n\nbody\n"
    )
    ws = make_ws(tmp_path)
    issues = validate_candidate(ws)
    assert not any(i["code"] == "broken-link" for i in issues)


# ===== validate_candidate: BFS reachability =====

def test_unreachable_trigger(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "index.md").write_text(
        "---\ntype: x\ntitle: Index\ndescription: d\ncoverage: full\nsources:\n---\n\nbody\n"
    )
    (cand / "orphan.md").write_text(
        "---\ntype: x\ntitle: Orphan\ndescription: d\ncoverage: full\nsources:\n---\n\nbody\n"
    )
    ws = make_ws(tmp_path)
    issues = validate_candidate(ws)
    assert any(i["code"] == "unreachable" for i in issues)


def test_unreachable_not_triggered(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "index.md").write_text(
        "---\ntype: x\ntitle: Index\ndescription: d\ncoverage: full\nsources:\n---\n\n[page](page.md)\n"
    )
    (cand / "page.md").write_text(
        "---\ntype: x\ntitle: Page\ndescription: d\ncoverage: full\nsources:\n---\n\nbody\n"
    )
    ws = make_ws(tmp_path)
    issues = validate_candidate(ws)
    assert not any(i["code"] == "unreachable" for i in issues)


def test_unreachable_skipped_without_index(tmp_path):
    cand = tmp_path / ".okf-wiki" / "candidate"
    cand.mkdir(parents=True)
    (cand / "page.md").write_text(
        "---\ntype: x\ntitle: Page\ndescription: d\ncoverage: full\nsources:\n---\n\nbody\n"
    )
    ws = make_ws(tmp_path)
    issues = validate_candidate(ws)
    assert not any(i["code"] == "unreachable" for i in issues)


def test_validate_target_derive_no_markers_rejected(tmp_path):
    ws = make_ws(tmp_path)
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    (props / "agents-block-api.md").write_text("no markers here\n")
    issues = validate_target(ws, "derive", "proposals")
    assert any(i["code"] == "managed-block-missing" for i in issues)


def test_validate_target_derive_with_markers_ok(tmp_path):
    ws = make_ws(tmp_path)
    props = tmp_path / ".okf-wiki" / "proposals"
    props.mkdir(parents=True)
    (props / "agents-block-api.md").write_text(
        "<!-- okf-wiki:begin run=r-x -->\n- pointer\n<!-- okf-wiki:end -->\n")
    assert validate_target(ws, "derive", "proposals") == []
