from _frontmatter import parse_page

NORMAL_PAGE = """\
---
type: Architecture
title: "My Page"
description: Overview of the system
coverage: full
---
Body text here.
"""

SOURCES_PAGE = """\
---
title: Sources Demo
sources:
  - id: state
    resource: api/src/state.py
  - id: db
    resource: catalog:app/orders
---
Body.
"""

NO_FM_PAGE = "Just body text, no frontmatter.\n"

DUPLICATE_KEY_PAGE = """\
---
title: First
title: Second
---
Body.
"""

QUOTED_PAGE = """\
---
title: 'Single quoted'
description: "Double quoted value"
---
Body.
"""


def test_normal_page():
    r = parse_page(NORMAL_PAGE)
    assert r.meta["type"] == "Architecture"
    assert r.meta["title"] == "My Page"
    assert r.meta["description"] == "Overview of the system"
    assert r.meta["coverage"] == "full"
    assert r.body.strip() == "Body text here."
    assert r.errors == []


def test_no_frontmatter():
    r = parse_page(NO_FM_PAGE)
    assert r.meta == {}
    assert len(r.errors) == 1
    assert "No frontmatter" in r.errors[0]
    assert "Just body" in r.body


def test_sources_list():
    r = parse_page(SOURCES_PAGE)
    assert r.errors == []
    sources = r.meta["sources"]
    assert len(sources) == 2
    assert sources[0] == {"id": "state", "resource": "api/src/state.py"}
    assert sources[1] == {"id": "db", "resource": "catalog:app/orders"}


def test_quoted_scalars():
    r = parse_page(QUOTED_PAGE)
    assert r.meta["title"] == "Single quoted"
    assert r.meta["description"] == "Double quoted value"
    assert r.errors == []


def test_duplicate_key():
    r = parse_page(DUPLICATE_KEY_PAGE)
    assert any("Duplicate" in e and "title" in e for e in r.errors)


def test_unknown_field_recorded():
    page = "---\nunknown_field: some_value\n---\nBody.\n"
    r = parse_page(page)
    assert "unknown_field" in r.meta
    assert r.meta["unknown_field"] == "some_value"


def test_missing_closing_delimiter():
    page = "---\ntitle: Oops\nBody without closing.\n"
    r = parse_page(page)
    assert r.meta == {}
    assert any("closing" in e or "---" in e for e in r.errors)


def test_body_preserved():
    r = parse_page(NORMAL_PAGE)
    assert "Body text here." in r.body


def test_sources_empty_list():
    page = "---\ntitle: T\nsources:\n---\nBody.\n"
    r = parse_page(page)
    assert r.meta["sources"] is None
