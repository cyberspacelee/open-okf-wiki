"""A small documented repository with a complete, valid wiki, shared by kernel tests."""

import json

import _git
import _page
import _review
from helpers import commit, git_repo, wiki_ws

FILES = {
    "Makefile": "test:\n\tpytest -q\n",
    "src/billing/run.py": "class BillingRun:\n    def post(self, invoice):\n        if invoice.posted:\n            raise ValueError('immutable')\n        invoice.posted = True\n",
    "src/billing/retry.py": "MAX = 3\n\ndef schedule(n):\n    return None if n >= MAX else n + 1\n",
    "tests/test_run.py": "def test_run():\n    assert True\n",
}

ARCH = """## Boundaries and dependencies

Billing has no dependencies.

## Not covered

| Path | Reason |
|---|---|
| `tests/` | Test code. |
"""

GLOSSARY = """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | Pass that posts invoices. | invoice job | `BillingRun`[^run] |

[^run]: src/billing/run.py#L1
"""

CONVENTIONS = """## Commands

| Purpose | Command | Status |
|---|---|---|
| Tests | `pytest -q`[^test] | verified |

## Rules

| Area | Rule | Enforced by |
|---|---|---|
| testing | Tests live in tests/ as test_*.py.[^test] | convention |

[^test]: Makefile#L1-L2
"""

BILLING = """## Responsibility and boundaries

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never posted again. | `post`[^posted] | Double charge. |

[^posted]: src/billing/run.py#L2-L5
"""


def repo(tmp_path, files=None):
    root = git_repo(tmp_path / "repo", dict(FILES, **(files or {})))
    return root, wiki_ws(root)


def set_body(ws, path, body):
    page = _page.load_page(ws, path)
    page.body = body
    _page.write_page(page)


def complete(tmp_path, files=None):
    """Repository with canon pages and one module page, all drafts without todo blocks."""
    root, ws = repo(tmp_path, files)
    _page.create_canon(ws)
    _page.new_page(ws, "modules/billing.md", "Module", "Read before changing billing.", ["src/billing/**"])
    set_body(ws, "architecture.md", ARCH)
    set_body(ws, "glossary.md", GLOSSARY)
    set_body(ws, "conventions.md", CONVENTIONS)
    set_body(ws, "modules/billing.md", BILLING)
    return root, ws


def approve(ws, reviewer="repo-wiki-reviewer/test", issues=None):
    subject = _review.subject(ws, _page.load_pages(ws))
    report = {
        "subject_digest": subject["subject_digest"],
        "reviewer": reviewer,
        "verdict": "changes_requested" if issues else "approved",
        "issues": issues or [],
    }
    (ws.wiki / _review.REVIEW_FILE).write_text(json.dumps(report), encoding="utf-8")
    return report


def head(ws):
    return _git.head(ws.root)


__all__ = ["commit"]
