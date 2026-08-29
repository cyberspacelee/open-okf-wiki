from _markdown import extract

NORMAL_BODY = """\
## Introduction
Some intro text.

### Sub-section
Sub content.

## Conclusion
End text.
"""

CODE_BLOCK_BODY = """\
## Real Heading
Normal [link](./real.md) here.

```python
## Not a heading
[not a link](./fake.md)
{{not_a_placeholder}}
[^notref]
```

## After Code
Post code text.
"""

LINKS_BODY = """\
## Links
See [internal](./other.md) and [anchor](#section).
External [web](https://example.com) ignored.
Also [relative with fragment](docs/page.md#intro).
"""

FOOTNOTE_BODY = """\
## Notes
Some text[^1] and another[^abc].

[^1]: First footnote definition.
[^abc]: Second footnote.
"""

PLACEHOLDER_BODY = """\
## Draft
{{TODO: fill this in}}
Some {{partial}} placeholder.
"""

H2_H3_BODY = """\
## Top
Top content.

### Child
Child content.

### Child Two
Child two content.

## Second Top
Second content.
"""


def test_h1_is_a_section():
    s = extract("# Schema\n\nTable body.\n\n## Gaps\n\nMissing indexes.\n")
    assert [sec.title for sec in s.sections] == ["Schema", "Gaps"]
    assert s.sections[0].level == 1


def test_h2_h3_sections():
    s = extract(NORMAL_BODY)
    assert len(s.sections) == 3
    assert s.sections[0].level == 2
    assert s.sections[0].title == "Introduction"
    assert s.sections[1].level == 3
    assert s.sections[1].title == "Sub-section"
    assert s.sections[2].level == 2
    assert s.sections[2].title == "Conclusion"


def test_section_content():
    s = extract(NORMAL_BODY)
    assert "Some intro text." in s.sections[0].content
    assert "Sub content." in s.sections[1].content
    assert "End text." in s.sections[2].content


def test_code_block_excluded():
    s = extract(CODE_BLOCK_BODY)
    titles = [sec.title for sec in s.sections]
    assert "Not a heading" not in titles
    assert "Real Heading" in titles
    assert "After Code" in titles

    link_targets = [t for t, _ in s.links]
    assert "./fake.md" not in link_targets
    assert "./real.md" in link_targets

    placeholder_vals = [p for p, _ in s.placeholders]
    assert "{{not_a_placeholder}}" not in placeholder_vals

    fn_ids = [fid for fid, _ in s.footnote_refs]
    assert "notref" not in fn_ids
    assert s.fences[0].language == "python"
    assert s.fences[0].start_line == 4
    assert s.fences[0].end_line == 9
    assert "## Not a heading" in s.fences[0].content


def test_unclosed_fence_is_recorded():
    s = extract("## Diagram\n\n```mermaid\nflowchart LR\nA-->B\n")
    assert len(s.fences) == 1
    assert s.fences[0].language == "mermaid"
    assert s.fences[0].end_line is None


def test_links_internal_only():
    s = extract(LINKS_BODY)
    targets = [t for t, _ in s.links]
    assert "./other.md" in targets
    assert "#section" in targets
    assert "docs/page.md#intro" in targets
    assert not any(t.startswith("https://") for t in targets)


def test_footnote_refs_and_defs():
    s = extract(FOOTNOTE_BODY)
    ref_ids = [fid for fid, _ in s.footnote_refs]
    assert "1" in ref_ids
    assert "abc" in ref_ids
    assert s.footnote_defs["1"] == "First footnote definition."
    assert s.footnote_defs["abc"] == "Second footnote."


def test_placeholders():
    s = extract(PLACEHOLDER_BODY)
    vals = [p for p, _ in s.placeholders]
    assert "{{TODO: fill this in}}" in vals
    assert "{{partial}}" in vals


def test_h2_h3_nesting():
    s = extract(H2_H3_BODY)
    levels = [sec.level for sec in s.sections]
    assert levels == [2, 3, 3, 2]
    titles = [sec.title for sec in s.sections]
    assert titles == ["Top", "Child", "Child Two", "Second Top"]


def test_start_line_numbers():
    s = extract(NORMAL_BODY)
    assert s.sections[0].start_line == 1
    assert s.sections[1].start_line == 4
    assert s.sections[2].start_line == 7


def test_link_line_numbers():
    s = extract(LINKS_BODY)
    link_map = {t: ln for t, ln in s.links}
    assert link_map["./other.md"] == 2
    assert link_map["#section"] == 2
