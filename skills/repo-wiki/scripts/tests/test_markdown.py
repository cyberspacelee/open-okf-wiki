from _markdown import extract, strip_code_spans

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
[^notref]
| a | b |
|---|---|
<!-- okf:todo inside fence -->
```

## After Code
Post code text.
"""

LINKS_BODY = """\
## Links
See [internal](/modules/other.md) and [anchor](#section).
External [web](https://example.com) kept.
Also [titled](docs/page.md#intro "Intro") and ![diagram](img/a.png).
"""

FOOTNOTE_BODY = """\
## Notes
Some text[^posted] and another[^retry-policy].

[^posted]: src/billing/invoice.py#L40-L58
[^retry-policy]: src/billing/retry.py#L3 why max 3
"""

TABLE_BODY = """\
## Glossary

| Term | Meaning | Avoid | Where |
|---|:--:|---|---:|
| Billing run | Pass over subscriptions. | invoice job | `BillingRun`[^billing-run] |
| Pipe | `a | b` and a \\| b | none | `x`[^pipe] |

After the table.
"""


def test_h1_is_a_section():
    s = extract("# Schema\n\nTable body.\n\n## Gaps\n\nMissing indexes.\n")
    assert [sec.title for sec in s.sections] == ["Schema", "Gaps"]
    assert s.sections[0].level == 1


def test_h2_h3_sections_and_lines():
    s = extract(NORMAL_BODY)
    assert [(sec.title, sec.level, sec.start_line) for sec in s.sections] == [
        ("Introduction", 2, 1),
        ("Sub-section", 3, 4),
        ("Conclusion", 2, 7),
    ]


def test_section_content():
    s = extract(NORMAL_BODY)
    assert s.sections[0].content == "Some intro text."
    assert s.sections[1].content == "Sub content."
    assert s.sections[2].content == "End text."


def test_code_block_excluded():
    s = extract(CODE_BLOCK_BODY)
    assert [sec.title for sec in s.sections] == ["Real Heading", "After Code"]
    assert s.links == [("./real.md", 2)]
    assert s.footnote_refs == []
    assert s.tables == []
    assert s.todos == []
    assert s.fences[0].language == "python"
    assert s.fences[0].start_line == 4
    assert s.fences[0].end_line == 11
    assert "## Not a heading" in s.fences[0].content
    assert all(4 > line or line > 11 for line, _ in s.prose)


def test_tilde_fence_needs_matching_marker():
    s = extract("~~~~\n```\n[a](x.md)\n~~~~\nafter [b](y.md)\n")
    assert s.fences[0].end_line == 4
    assert s.links == [("y.md", 5)]


def test_unclosed_fence_is_recorded():
    s = extract("## Diagram\n\n```mermaid\nflowchart LR\nA-->B\n")
    assert len(s.fences) == 1
    assert s.fences[0].language == "mermaid"
    assert s.fences[0].end_line is None
    assert s.fences[0].content == "flowchart LR\nA-->B"


def test_links():
    s = extract(LINKS_BODY)
    assert s.links == [
        ("/modules/other.md", 2),
        ("#section", 2),
        ("https://example.com", 3),
        ("docs/page.md#intro", 4),
    ]


def test_links_in_code_spans_excluded():
    s = extract("Use `[x](fake.md)` or ``[y](a`b.md)`` but [z](real.md).\n")
    assert s.links == [("real.md", 1)]


def test_footnote_refs_and_defs():
    s = extract(FOOTNOTE_BODY)
    assert s.footnote_refs == [("posted", 2), ("retry-policy", 2)]
    assert s.footnote_defs == {
        "posted": ("src/billing/invoice.py#L40-L58", 4),
        "retry-policy": ("src/billing/retry.py#L3 why max 3", 5),
    }
    assert s.duplicate_defs == []


def test_footnote_refs_in_code_spans_excluded():
    s = extract("Literal `[^fake]` and real[^real].\n\n[^real]: a.py#L1\n")
    assert s.footnote_refs == [("real", 1)]


def test_duplicate_footnote_defs_are_reported():
    s = extract("x[^a]\n\n[^a]: first.py#L1\n[^a]: second.py#L2\n")
    assert s.footnote_defs == {"a": ("first.py#L1", 3)}
    assert s.duplicate_defs == [("a", 4)]


def test_table_cells_rows_and_refs():
    s = extract(TABLE_BODY)
    assert len(s.tables) == 1
    table = s.tables[0]
    assert table.line == 3
    assert table.header == ["Term", "Meaning", "Avoid", "Where"]
    assert [row.line for row in table.rows] == [5, 6]
    assert table.rows[0].cells == [
        "Billing run",
        "Pass over subscriptions.",
        "invoice job",
        "`BillingRun`[^billing-run]",
    ]
    assert table.rows[1].cells == ["Pipe", "`a | b` and a | b", "none", "`x`[^pipe]"]
    assert s.footnote_refs == [("billing-run", 5), ("pipe", 6)]
    assert s.prose == [(8, "After the table.")]


def test_table_requires_delimiter_row():
    s = extract("| a | b |\n| c | d |\n")
    assert s.tables == []
    assert [line for line, _ in s.prose] == [1, 2]


def test_table_without_outer_pipes():
    s = extract("A | B\n--- | ---\n1 | 2\n")
    assert s.tables[0].header == ["A", "B"]
    assert s.tables[0].rows[0].cells == ["1", "2"]


def test_table_ends_at_blank_line():
    s = extract("| a |\n|---|\n| 1 |\n\n| not a row |\n")
    assert [row.cells for row in s.tables[0].rows] == [["1"]]


def test_todo_single_line():
    s = extract("<!-- okf:todo check retry policy -->\nBody.\n")
    assert s.todos == [(1, "check retry policy")]
    assert s.prose == [(2, "Body.")]


def test_todo_multi_line():
    body = (
        "Intro.\n"
        "<!-- okf:todo\n"
        "Brief: see src/billing/invoice.py#L40-L58;\n"
        "retry [^x] policy\n"
        "-->\n"
        "Invoices are immutable.[^posted]\n"
    )
    s = extract(body)
    assert s.todos == [
        (2, "Brief: see src/billing/invoice.py#L40-L58;\nretry [^x] policy")
    ]
    assert s.footnote_refs == [("posted", 6)]
    assert [line for line, _ in s.prose] == [1, 6]


def test_todo_unterminated_runs_to_end():
    s = extract("Intro.\n<!-- okf:todo\nopen question\n## Not a heading\n")
    assert s.todos == [(2, "open question\n## Not a heading")]
    assert s.sections == []


def test_plain_html_comment_is_not_todo_or_prose():
    s = extract("<!-- note\nhidden [a](b.md)\n-->\nVisible.\n")
    assert s.todos == []
    assert s.links == []
    assert s.prose == [(4, "Visible.")]


def test_prose_excludes_structure_and_code_spans():
    body = (
        "# Title\n"
        "Uses `invoice_job` because retries.[^r]\n"
        "\n"
        "| a |\n"
        "|---|\n"
        "| b |\n"
        "```\n"
        "code\n"
        "```\n"
        "[^r]: a.py#L1\n"
    )
    s = extract(body)
    assert s.prose == [(2, "Uses  because retries.[^r]")]


def test_strip_code_spans():
    assert strip_code_spans("a `b` c ``d ` e`` f") == "a  c  f"
    assert strip_code_spans("unclosed `tick") == "unclosed `tick"
