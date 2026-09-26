#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-2 update recall: do planted code changes reach the impact report?

Builds a single-repository fixture and a two-source hub fixture, each with a
complete, stamped wiki. Every scenario starts from a fresh copy of that
baseline, plants one semantic change (a commit), then scores the kernel's
``_impact.impact`` against the pages that must and must not be reported:

- recall: expected pages reported / expected pages (must be 1.0);
- precision: expected pages reported / pages reported;
- reason kinds: each reported page carries exactly the expected reason kinds,
  and every expected suggested locator is present;
- update: ``_impact.update`` drafts exactly the reported pages (plus the
  Architecture page for unmapped modules or deleted Not covered paths), and
  each draft's todo block holds the reason lines.

Prints a table (or ``--json``) and exits 1 when recall < 1.0, a must-not page
is reported, a reason kind or suggestion is wrong, or update drafts the wrong
pages. Kernel gaps that are known and documented are listed separately and do
not fail the run unless ``--strict`` is given.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import _config
import _impact
import _page
import _stamp
import _validate

PRODUCER = "repo-wiki/eval-update"

# --- git and fixture helpers ------------------------------------------------------------


class Failure(Exception):
    pass


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise Failure(f"git {' '.join(args)} failed in {repo}: {result.stderr.strip()}")
    return result.stdout.strip()


def put(repo: Path, files: dict[str, str | None]) -> None:
    for rel, text in files.items():
        target = repo / rel
        if text is None:
            target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")


def commit(repo: Path, message: str, files: dict[str, str | None] | None = None) -> str:
    put(repo, files or {})
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def git_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Eval")
    git(path, "config", "user.email", "eval@example.com")
    git(path, "config", "commit.gpgsign", "false")
    commit(path, "init", files)
    return path


def set_body(ws: _config.Workspace, path: str, body: str) -> None:
    page = _page.load_page(ws, path)
    page.body = body
    _page.write_page(page)


def stamp_baseline(ws: _config.Workspace, repo: Path) -> None:
    errors = [i.to_dict() for i in _validate.validate(ws) if i.severity in ("error", "pending")]
    if errors:
        raise Failure(f"baseline wiki does not validate: {json.dumps(errors, indent=2)}")
    result = _stamp.stamp(ws, PRODUCER, unreviewed=True)
    if result["blocked"]:
        raise Failure(f"baseline stamp blocked: {json.dumps(result['blocked'], indent=2)}")
    commit(repo, "wiki v1")
    report = _impact.impact(ws)
    if report["pages"] or report["unmapped_modules"] or report["deleted_not_covered"] or report["missing_scope"]:
        raise Failure(f"baseline is not clean: {json.dumps(report, indent=2)}")


# --- single-repository fixture ----------------------------------------------------------

RUN_PY = (
    "from payments.client import Client\n"
    "\n"
    "\n"
    "class BillingRun:\n"
    "    \"\"\"Scheduled pass that turns due subscriptions into invoices.\"\"\"\n"
    "\n"
    "    def post(self, invoice):\n"
    "        if invoice.posted:\n"
    "            raise ValueError(\"posted invoices are immutable\")\n"
    "        invoice.posted = True\n"
    "        return Client().charge(invoice)\n"
)
RETRY_PY = (
    "MAX_ATTEMPTS = 3\n"
    "\n"
    "\n"
    "def schedule(attempt):\n"
    "    if attempt >= MAX_ATTEMPTS:\n"
    "        return None\n"
    "    return attempt + 1\n"
)
CLIENT_PY = (
    "class Client:\n"
    "    def charge(self, invoice):\n"
    "        return invoice.total\n"
    "\n"
    "    def refund(self, invoice):\n"
    "        return -invoice.total\n"
)
FORMAT_PY = "def money(cents):\n    return f\"{cents / 100:.2f}\"\n"

SHOP = {
    "README.md": "# Shop\n\nSmall billing service.\n",
    "Makefile": "test:\n\tpython -m pytest -q\n\nlint:\n\truff check .\n",
    "ruff.toml": "line-length = 100\n",
    "src/billing/__init__.py": "\"\"\"Invoice posting and charge retries.\"\"\"\n",
    "src/billing/run.py": RUN_PY,
    "src/billing/retry.py": RETRY_PY,
    "src/billing/format.py": FORMAT_PY,
    "src/payments/__init__.py": "\"\"\"Payment gateway client.\"\"\"\n",
    "src/payments/client.py": CLIENT_PY,
    "src/reports/summary.py": "def summary(invoices):\n    return len(invoices)\n",
    "tests/test_billing.py": "def test_post():\n    assert True\n",
    "tests/test_retry.py": "def test_retry():\n    assert True\n",
    "third_party/vendor.py": "X = 1\n",
}

SHOP_PAGES = {
    "architecture.md": """## Boundaries and dependencies

Billing depends on payments only through `payments.Client`.[^seam]

| Invariant | Enforced at | Breaks when |
|---|---|---|
| Billing reaches the gateway only through `Client`. | `BillingRun.post`[^seam] | Charges bypass payment retries. |

## Change impact

| Change | Also change or check |
|---|---|
| `MAX_ATTEMPTS` | `tests/test_retry.py`[^retry-cap] |

## Not covered

| Path | Reason |
|---|---|
| `third_party/` | Vendored upstream code; never modified here. |
| `src/reports/` | Read-only report helpers with no invariants. |
| `tests/` | Tests are listed per page under Related tests. |

[^seam]: src/billing/run.py#L1-L11
[^retry-cap]: src/billing/retry.py#L1
""",
    "glossary.md": """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | Scheduled pass that turns due subscriptions into invoices. | invoice job | `BillingRun`[^billing-run] |
| Gateway client | The only object that talks to the payment gateway. | processor | `Client`[^gateway] |

[^billing-run]: src/billing/run.py#L4-L5
[^gateway]: src/payments/client.py#L1
""",
    "conventions.md": """## Commands

| Purpose | Command | Status |
|---|---|---|
| Unit tests | `python -m pytest -q`[^test] | not-run |
| Lint | `ruff check .`[^lint] | verified |

## Rules

| Area | Rule | Enforced by |
|---|---|---|
| build-ci | Lines stay within 100 characters.[^ruff] | lint |

[^test]: Makefile#L1-L2
[^lint]: Makefile#L4-L5
[^ruff]: ruff.toml#L1
""",
    "modules/billing.md": """## Responsibility and boundaries

Billing owns invoice posting and charge retries. Posting charges through `payments.Client`.[^charge]

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never posted again. | `BillingRun.post`[^posted] | Customers are charged twice. |
| At most 3 charge attempts. | `schedule`[^retry-cap] | Repeated charges after a gateway timeout. |

Why 3 attempts: rationale not recorded.

[^posted]: src/billing/run.py#L7-L10
[^charge]: src/billing/run.py#L11
[^retry-cap]: src/billing/retry.py#L1-L7
""",
    "modules/payments.md": """## Responsibility and boundaries

Payments wraps the gateway; charges and refunds go through `Client`.[^client]

[^client]: src/payments/client.py#L1-L3
""",
    "workflows/checkout.md": """## Trigger to outcome

A billing run posts the invoice[^post] and the gateway client charges it.[^charge]

```mermaid
flowchart LR
  run[BillingRun.post] --> client[Client.charge]
```

[^post]: src/billing/run.py#L11
[^charge]: src/payments/client.py#L2-L3
""",
}

SHOP_NEW = [
    ("modules/billing.md", "Module", "Read before changing invoice posting or charge retries.", ["src/billing/**"]),
    ("modules/payments.md", "Module", "Read before changing the payment gateway client.", ["src/payments/**"]),
    ("workflows/checkout.md", "Workflow", "Read before changing how a posted invoice gets charged.",
     ["src/billing/run.py", "src/payments/client.py"]),
]


def build_shop(base: Path) -> Path:
    repo = git_repo(base / "shop", SHOP)
    ws = _config.init(repo)
    for path, type, description, scope in SHOP_NEW:
        _page.new_page(ws, path, type, description, scope)
    for path, body in SHOP_PAGES.items():
        set_body(ws, path, body)
    stamp_baseline(ws, repo)
    return repo


# --- hub fixture ----------------------------------------------------------------------

APP_PY = "def handle(request):\n    return authorize(request) and dispatch(request)\n"
AUTH_PY = "def authorize(request):\n    return request.token is not None\n"
JOB_PY = "def run(job):\n    return job.execute()\n"
JOB_RETRY_PY = "LIMIT = 5\n"

HUB_PAGES = {
    "architecture.md": """## Boundaries and dependencies

api enqueues work that worker executes; they share no code.[^handle]

## Not covered

| Path | Reason |
|---|---|

[^handle]: api/src/app.py#L1-L2
""",
    "glossary.md": """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Handle | Entry point of every API request. | controller | `handle`[^handle] |

[^handle]: api/src/app.py#L1-L2
""",
    "conventions.md": """## Commands

| Purpose | Command | Status |
|---|---|---|

## Rules

| Area | Rule | Enforced by |
|---|---|---|
""",
    "modules/api.md": """## Responsibility and boundaries

The API authorizes each request before dispatching it.[^auth]

[^auth]: api/src/auth.py#L1-L2
""",
    "modules/worker.md": """## Responsibility and boundaries

The worker executes queued jobs.[^run]

[^run]: worker/jobs/run.py#L1-L2
""",
    "workflows/request.md": """## Trigger to outcome

A request is handled by the API[^handle] and its job runs in the worker.[^run]

[^handle]: api/src/app.py#L1-L2
[^run]: worker/jobs/run.py#L1-L2
""",
}

HUB_NEW = [
    ("modules/api.md", "Module", "Read before changing request handling or authorization.", ["api/src/**"]),
    ("modules/worker.md", "Module", "Read before changing job execution or retries.", ["worker/jobs/**"]),
    ("workflows/request.md", "Workflow", "Read before changing the path from request to job.",
     ["api/src/app.py", "worker/jobs/run.py"]),
]


def build_hub(base: Path) -> Path:
    hub = git_repo(base / "hub", {"README.md": "# Platform hub\n"})
    git_repo(hub / "api", {"src/app.py": APP_PY, "src/auth.py": AUTH_PY, "README.md": "api\n"})
    git_repo(hub / "worker", {"jobs/run.py": JOB_PY, "jobs/retry.py": JOB_RETRY_PY, "README.md": "worker\n"})
    ws = _config.init(hub, hub_sources=["api", "worker"])
    commit(hub, "wiki stubs")
    for path, type, description, scope in HUB_NEW:
        _page.new_page(ws, path, type, description, scope)
    for path, body in HUB_PAGES.items():
        set_body(ws, path, body)
    stamp_baseline(ws, hub)
    return hub


# --- scenarios -------------------------------------------------------------------------


@dataclass
class Scenario:
    name: str
    fixture: str  # "shop" or "hub"
    change: str  # one line: the planted semantic change
    apply: Callable[[Path], None]
    # page -> exact set of reason kinds it must carry
    expect: dict[str, set[str]]
    # (page, footnote label) -> suggested locator
    suggested: dict[tuple[str, str], str] = field(default_factory=dict)
    unmapped: list[str] = field(default_factory=list)
    deleted_not_covered: list[str] = field(default_factory=list)
    # (page, glob) pairs whose glob no longer matches any file
    missing_scope: list[tuple[str, str]] = field(default_factory=list)
    # pages that must not be reported; None means every page not in ``expect``
    must_not: set[str] | None = None
    # (page, detail) -> why the kernel deviates; scored but not failed without --strict
    known_gaps: dict[str, str] = field(default_factory=dict)


def _edit(rel: str, old: str, new: str) -> Callable[[Path], None]:
    def apply(repo: Path) -> None:
        text = (repo / rel).read_text(encoding="utf-8")
        if old not in text:
            raise Failure(f"{rel} does not contain {old!r}")
        commit(repo, f"edit {rel}", {rel: text.replace(old, new, 1)})

    return apply


def _files(message: str, files: dict[str, str | None]) -> Callable[[Path], None]:
    return lambda repo: commit(repo, message, files)


def _mv(old: str, new: str) -> Callable[[Path], None]:
    def apply(repo: Path) -> None:
        (repo / new).parent.mkdir(parents=True, exist_ok=True)
        git(repo, "mv", old, new)
        commit(repo, f"rename {old} to {new}")

    return apply


def _wiki_only(repo: Path) -> None:
    ws = _config.load(repo)
    _stamp.verify(ws, "human:eval", ["modules/billing.md"])
    (ws.wiki / "notes").mkdir(exist_ok=True)
    commit(repo, "wiki: human review", {f"{ws.wiki_rel}/notes/review.txt": "Reviewed billing.\n"})


def _revert(repo: Path) -> None:
    commit(repo, "raise cap", {"src/billing/retry.py": RETRY_PY.replace("3", "4")})
    git(repo, "revert", "--no-edit", "HEAD")


def _mixed(repo: Path) -> None:
    commit(repo, "refund fee", {"src/payments/fees.py": "FEE = 30\n"})
    commit(repo, "cap 4", {"src/billing/retry.py": RETRY_PY.replace("= 3", "= 4")})
    commit(repo, "docs", {"README.md": "# Shop\n\nBilling and payments.\n"})


def _in_source(name: str, inner: Callable[[Path], None]) -> Callable[[Path], None]:
    return lambda hub: inner(hub / name)


SCENARIOS = [
    Scenario(
        "edit-cited-range", "shop", "change MAX_ATTEMPTS inside cited lines of retry.py",
        _edit("src/billing/retry.py", "MAX_ATTEMPTS = 3", "MAX_ATTEMPTS = 5"),
        {"architecture.md": {"cited-changed"}, "modules/billing.md": {"cited-changed"}},
    ),
    Scenario(
        "edit-beside-cited-range", "shop", "change the lint recipe (Makefile#L5) next to the cited test recipe",
        _edit("Makefile", "ruff check .", "ruff check src"),
        {"conventions.md": {"cited-context", "cited-changed"}},
    ),
    Scenario(
        "append-to-cited-file", "shop", "append a method after every cited range of run.py",
        _edit("src/billing/run.py", "charge(invoice)\n", "charge(invoice)\n\n    def void(self, invoice):\n        invoice.void = True\n"),
        {
            "architecture.md": {"cited-context"},
            "glossary.md": {"cited-context"},
            "modules/billing.md": {"cited-context"},
            "workflows/checkout.md": {"cited-context"},
        },
    ),
    Scenario(
        "move-cited-lines", "shop", "insert two lines at the top of run.py so every cited range moves",
        _edit("src/billing/run.py", "from payments", "# billing entry\n\nfrom payments"),
        {
            "architecture.md": {"cited-moved"},
            "glossary.md": {"cited-moved"},
            "modules/billing.md": {"cited-moved"},
            "workflows/checkout.md": {"cited-moved"},
        },
        suggested={
            ("architecture.md", "seam"): "src/billing/run.py#L3-L13",
            ("glossary.md", "billing-run"): "src/billing/run.py#L6-L7",
            ("modules/billing.md", "posted"): "src/billing/run.py#L9-L12",
            ("modules/billing.md", "charge"): "src/billing/run.py#L13",
            ("workflows/checkout.md", "post"): "src/billing/run.py#L13",
        },
    ),
    Scenario(
        "rename-cited-file", "shop", "git mv src/payments/client.py src/payments/gateway.py",
        _mv("src/payments/client.py", "src/payments/gateway.py"),
        {
            "modules/payments.md": {"cited-moved", "scope-added"},
            "glossary.md": {"cited-moved"},
            "workflows/checkout.md": {"cited-moved"},
        },
        suggested={
            ("modules/payments.md", "client"): "src/payments/gateway.py#L1-L3",
            ("glossary.md", "gateway"): "src/payments/gateway.py#L1",
            ("workflows/checkout.md", "charge"): "src/payments/gateway.py#L2-L3",
        },
        missing_scope=[("workflows/checkout.md", "src/payments/client.py")],
        known_gaps={
            "glossary.md": "rename not detected: the diff pathspec holds only the old cited path, "
            "so a page without a scope over the new path sees cited-deleted",
            "workflows/checkout.md": "same as glossary.md: rename outside the page scope reads as cited-deleted",
        },
    ),
    Scenario(
        "delete-cited-file", "shop", "git rm src/billing/retry.py",
        _files("drop retries", {"src/billing/retry.py": None}),
        {"architecture.md": {"cited-deleted"}, "modules/billing.md": {"cited-deleted"}},
    ),
    Scenario(
        "add-file-in-scope", "shop", "add src/billing/refund.py",
        _files("refunds", {"src/billing/refund.py": "def refund(invoice):\n    return invoice\n"}),
        {"modules/billing.md": {"scope-added"}},
    ),
    Scenario(
        "modify-uncited-in-scope", "shop", "change src/billing/format.py (in scope, never cited)",
        _edit("src/billing/format.py", ":.2f", ":,.2f"),
        {"modules/billing.md": {"scope-modified"}},
    ),
    Scenario(
        "delete-file-in-scope", "shop", "git rm src/billing/format.py",
        _files("drop format", {"src/billing/format.py": None}),
        {"modules/billing.md": {"scope-deleted"}},
    ),
    Scenario(
        "rename-out-of-scope", "shop", "git mv src/billing/format.py src/reports/format.py",
        _mv("src/billing/format.py", "src/reports/format.py"),
        {"modules/billing.md": {"scope-deleted"}},
    ),
    Scenario(
        "change-outside-scopes", "shop", "edit README.md, src/reports/summary.py and a test",
        _files("misc", {
            "README.md": "# Shop\n\nBilling service.\n",
            "src/reports/summary.py": "def summary(invoices):\n    return sum(1 for _ in invoices)\n",
            "tests/test_billing.py": "def test_post():\n    assert 1\n",
        }),
        {},
    ),
    Scenario(
        "new-top-level-module", "shop", "add worker/jobs.py (a new top-level code directory)",
        _files("worker", {"worker/jobs.py": "def nightly():\n    pass\n"}),
        {}, unmapped=["worker"],
    ),
    Scenario(
        "delete-not-covered-path", "shop", "git rm third_party/vendor.py (a Not covered row)",
        _files("unvendor", {"third_party/vendor.py": None}),
        {}, deleted_not_covered=["third_party"],
    ),
    Scenario(
        "wiki-only-commit", "shop", "record a human review and add a wiki note, nothing else",
        _wiki_only, {},
    ),
    Scenario(
        "change-then-revert", "shop", "change the retry cap, then git revert it",
        _revert, {},
    ),
    Scenario(
        "several-commits", "shop", "three commits: payments file added, retry cap changed, README edited",
        _mixed,
        {
            "modules/payments.md": {"scope-added"},
            "modules/billing.md": {"cited-changed"},
            "architecture.md": {"cited-changed"},
        },
    ),
    Scenario(
        "hub-one-source-scope", "hub", "change worker/jobs/retry.py only",
        _in_source("worker", _files("limit", {"jobs/retry.py": "LIMIT = 7\n"})),
        {"modules/worker.md": {"scope-modified"}},
    ),
    Scenario(
        "hub-one-source-cited", "hub", "change the cited worker/jobs/run.py only",
        _in_source("worker", _edit("jobs/run.py", "job.execute()", "job.execute(timeout=30)")),
        {"modules/worker.md": {"cited-changed"}, "workflows/request.md": {"cited-changed"}},
    ),
    Scenario(
        "hub-api-cited", "hub", "change the cited api/src/app.py only",
        _in_source("api", _edit("src/app.py", "and dispatch", "and audit(request) and dispatch")),
        {
            "architecture.md": {"cited-changed"},
            "glossary.md": {"cited-changed"},
            "modules/api.md": {"scope-modified"},
            "workflows/request.md": {"cited-changed"},
        },
    ),
    Scenario(
        "hub-source-outside-scopes", "hub", "change api/README.md only (outside every scope)",
        _in_source("api", _files("readme", {"README.md": "api service\n"})),
        {},
    ),
    Scenario(
        "hub-new-module", "hub", "add worker/cli/main.py (a new module in one source)",
        _in_source("worker", _files("cli", {"cli/main.py": "def main():\n    pass\n"})),
        {}, unmapped=["worker/cli"],
    ),
    Scenario(
        "hub-wiki-only-commit", "hub", "commit a wiki note in the hub repository only",
        lambda hub: commit(hub, "wiki note", {"docs/wiki/notes/todo.txt": "later\n"}),
        {},
    ),
]


# --- scoring --------------------------------------------------------------------------


def _todo_text(page: _page.Page) -> str:
    return "\n".join(text for _, text in page.todos)


def _line(text: str) -> str:
    return " ".join(text.split()).replace("-->", "->")


def run_scenario(scenario: Scenario, baseline: Path, work: Path) -> dict:
    repo = work / scenario.name / baseline.name
    shutil.copytree(baseline, repo, symlinks=True)
    scenario.apply(repo)
    ws = _config.load(repo)
    all_pages = {p.path for p in _page.load_pages(ws) if not p.is_generated}
    report = _impact.impact(ws)
    reported = {item["page"]: item["reasons"] for item in report["pages"]}
    expected = set(scenario.expect)
    must_not = (all_pages - expected) if scenario.must_not is None else scenario.must_not
    hits = expected & set(reported)
    problems: list[str] = []
    gaps: list[str] = []

    def problem(page: str | None, message: str) -> None:
        if page is not None and page in scenario.known_gaps:
            gaps.append(f"{page}: {message} (known gap: {scenario.known_gaps[page]})")
        else:
            problems.append(f"{page}: {message}" if page else message)

    for page in sorted(expected - set(reported)):
        problem(None, f"{page}: missed (expected {sorted(scenario.expect[page])})")
    for page in sorted(must_not & set(reported)):
        problem(None, f"{page}: reported but must not be ({sorted({r['kind'] for r in reported[page]})})")
    kinds_ok = 0
    for page in sorted(hits):
        kinds = {r["kind"] for r in reported[page]}
        if kinds == scenario.expect[page]:
            kinds_ok += 1
        else:
            problem(page, f"reason kinds {sorted(kinds)}, expected {sorted(scenario.expect[page])}")
    suggestions_ok = 0
    for (page, label), locator in sorted(scenario.suggested.items()):
        got = [r.get("suggested") for r in reported.get(page, []) if r.get("label") == label]
        if locator in got:
            suggestions_ok += 1
        else:
            problem(page, f"[^{label}] suggested {got or 'nothing'}, expected {locator}")
    if report["unmapped_modules"] != scenario.unmapped:
        problem(None, f"unmapped_modules {report['unmapped_modules']}, expected {scenario.unmapped}")
    if report["deleted_not_covered"] != scenario.deleted_not_covered:
        problem(None, f"deleted_not_covered {report['deleted_not_covered']}, expected {scenario.deleted_not_covered}")
    missing = [(item["page"], item["glob"]) for item in report["missing_scope"]]
    if missing != scenario.missing_scope:
        problem(None, f"missing_scope {missing}, expected {scenario.missing_scope}")

    update_ok = _check_update(ws, report, problems)
    return {
        "scenario": scenario.name,
        "fixture": scenario.fixture,
        "change": scenario.change,
        "expected": sorted(expected),
        "reported": sorted(reported),
        "reasons": {page: sorted({r["kind"] for r in reasons}) for page, reasons in sorted(reported.items())},
        "recall": len(hits) / len(expected) if expected else 1.0,
        "precision": len(hits) / len(reported) if reported else 1.0,
        "kinds_correct": kinds_ok,
        "suggestions_correct": suggestions_ok,
        "suggestions_expected": len(scenario.suggested),
        "must_not_reported": sorted(must_not & set(reported)),
        "update_ok": update_ok,
        "problems": problems,
        "known_gaps": gaps,
        "ok": not problems,
    }


def _check_update(ws: _config.Workspace, report: dict, problems: list[str]) -> bool:
    """okf update drafts exactly the reported pages and records every reason line."""
    before = len(problems)
    arch = _page.CANON["Architecture"]
    want: dict[str, list[str]] = {item["page"]: [_impact.describe(r) for r in item["reasons"]] for item in report["pages"]}
    for module in report["unmapped_modules"]:
        want.setdefault(arch, []).append(f"unmapped-module {module}")
    for path in report["deleted_not_covered"]:
        want.setdefault(arch, []).append(f"not-covered-deleted {path}")
    for item in report["missing_scope"]:
        want.setdefault(item["page"], []).append(f"scope-empty {item['glob']}")
    result = _impact.update(ws)
    if sorted(result["drafted"]) != sorted(want):
        problems.append(f"update drafted {sorted(result['drafted'])}, expected {sorted(want)}")
    if result["rebased"]:
        problems.append(f"update rebased stable pages {result['rebased']}")
    head = _page.current_revision(ws)
    for page in _page.load_pages(ws):
        if page.is_generated:
            continue
        if page.path in want:
            todo = _todo_text(page)
            if page.status != "draft":
                problems.append(f"update left {page.path} {page.status}")
            if page.revision != head:
                problems.append(f"update did not rebase {page.path} to HEAD")
            for line in want[page.path]:
                if _line(line) not in todo:
                    problems.append(f"{page.path} todo block lacks {line!r}")
        elif page.status != "stable":
            problems.append(f"update touched {page.path} ({page.status})")
    again = _impact.update(ws)
    if again["drafted"] or again["rebased"]:
        problems.append(f"second update is not a no-op: {again['drafted']} {again['rebased']}")
    return len(problems) == before


# --- entry point ------------------------------------------------------------------------


def evaluate(names: list[str] | None = None) -> dict:
    chosen = [s for s in SCENARIOS if not names or s.name in names]
    unknown = sorted(set(names or []) - {s.name for s in SCENARIOS})
    if unknown:
        raise Failure(f"unknown scenario(s) {', '.join(unknown)}; see --list")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        baselines = {}
        if any(s.fixture == "shop" for s in chosen):
            baselines["shop"] = build_shop(base / "baseline")
        if any(s.fixture == "hub" for s in chosen):
            baselines["hub"] = build_hub(base / "baseline")
        results = [run_scenario(s, baselines[s.fixture], base / "runs") for s in chosen]
    expected = sum(len(r["expected"]) for r in results)
    reported = sum(len(r["reported"]) for r in results)
    hits = sum(round(r["recall"] * len(r["expected"])) for r in results)
    return {
        "scenarios": results,
        "summary": {
            "scenarios": len(results),
            "passed": sum(r["ok"] for r in results),
            "expected_pages": expected,
            "reported_pages": reported,
            "recall": hits / expected if expected else 1.0,
            "precision": hits / reported if reported else 1.0,
            "kinds_correct": sum(r["kinds_correct"] for r in results),
            "suggestions_correct": sum(r["suggestions_correct"] for r in results),
            "suggestions_expected": sum(r["suggestions_expected"] for r in results),
            "must_not_reported": sum(len(r["must_not_reported"]) for r in results),
            "update_ok": sum(r["update_ok"] for r in results),
            "known_gaps": sum(len(r["known_gaps"]) for r in results),
        },
    }


def print_table(result: dict) -> None:
    rows = [("scenario", "exp", "rep", "recall", "prec", "kinds", "update", "ok")]
    for r in result["scenarios"]:
        rows.append((
            r["scenario"], str(len(r["expected"])), str(len(r["reported"])),
            f"{r['recall']:.2f}", f"{r['precision']:.2f}",
            f"{r['kinds_correct']}/{len(set(r['expected']) & set(r['reported']))}",
            "ok" if r["update_ok"] else "FAIL", "ok" if r["ok"] else "FAIL",
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())
    for r in result["scenarios"]:
        for text in r["problems"]:
            print(f"FAIL {r['scenario']}: {text}")
        for text in r["known_gaps"]:
            print(f"GAP  {r['scenario']}: {text}")
    s = result["summary"]
    print(
        f"eval_update: {s['passed']}/{s['scenarios']} scenarios, recall {s['recall']:.2f}, "
        f"precision {s['precision']:.2f}, suggestions {s['suggestions_correct']}/{s['suggestions_expected']}, "
        f"must-not reported {s['must_not_reported']}, known gaps {s['known_gaps']}"
    )


def failed(result: dict, strict: bool) -> bool:
    s = result["summary"]
    return s["recall"] < 1.0 or s["must_not_reported"] > 0 or s["passed"] < s["scenarios"] or (strict and s["known_gaps"] > 0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    parser.add_argument("--strict", action="store_true", help="fail on known kernel gaps too")
    parser.add_argument("--list", action="store_true", help="list scenarios and exit")
    parser.add_argument("scenarios", nargs="*", help="run only these scenarios")
    args = parser.parse_args(argv)
    if args.list:
        for s in SCENARIOS:
            print(f"{s.name:28} {s.fixture:5} {s.change}")
        return 0
    try:
        result = evaluate(args.scenarios)
    except Failure as exc:
        print(f"eval_update: error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_table(result)
    return 1 if failed(result, args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
