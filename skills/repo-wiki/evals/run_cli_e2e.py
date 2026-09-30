#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-1 deterministic end-to-end run of the okf CLI on a fixture repository.

Plays the host agent with fixed page text: init -> discover -> structure ->
research -> write -> review -> stamp -> done, then changes the code (moved
lines, changed invariant, new module, HEAD moved under a draft) and checks
impact, update, status and a second stamp. A second run does the same for a hub
of two sources that share a route, a topic and a library: derived page paths,
contracts claimed and described, the assemble stage, layered indexes, the
System map, the log, a per-source pointer, and a contract change that stales the
Flow page from outside its scope. Exits non-zero on the first failure.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

OKF = Path(__file__).resolve().parent.parent / "scripts" / "okf.py"

FIXTURE = {
    "README.md": "# Shop\n\nSmall billing service.\n",
    "Makefile": "test:\n\tpython -m pytest -q\n\nlint:\n\truff check .\n",
    "ruff.toml": "line-length = 100\n",
    "src/billing/__init__.py": "",
    "src/billing/run.py": (
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
    ),
    "src/billing/retry.py": (
        "MAX_ATTEMPTS = 3\n"
        "\n"
        "\n"
        "def schedule(attempt):\n"
        "    if attempt >= MAX_ATTEMPTS:\n"
        "        return None\n"
        "    return attempt + 1\n"
    ),
    "src/billing/tasks.py": (
        "from celery import shared_task\n"
        "\n"
        "from billing.run import BillingRun\n"
        "\n"
        "\n"
        "@shared_task\n"
        "def nightly_billing(invoice):\n"
        "    return BillingRun().post(invoice)\n"
    ),
    "src/payments/__init__.py": "",
    "src/payments/client.py": (
        "class Client:\n"
        "    def charge(self, invoice):\n"
        "        return invoice.total\n"
    ),
    "tests/test_billing.py": "def test_post():\n    assert True\n",
    "tests/test_retry.py": "def test_retry():\n    assert True\n",
    "third_party/vendor.py": "X = 1\n",
}

ARCHITECTURE = """## Structure

Billing depends on payments only through `payments.Client`.[^seam]

```mermaid
flowchart LR
  billing --> payments
```

| Invariant | Enforced at | Breaks when |
|---|---|---|
| Billing reaches the gateway only through `Client`. | `BillingRun.post`[^seam] | Charges bypass payment retries. |

## Cross-module changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Charge through the gateway differently | `BillingRun.post`[^seam] | `payments.Client` | `tests/test_billing.py` |

## Not covered

| Path | Reason |
|---|---|
| `third_party/` | Vendored upstream code; never modified here. |
| `src/payments/` | A thin gateway client; its only seam is described above. |
| `tests/` | Tests are named per page in the Verify column. |

[^seam]: src/billing/run.py#L1-L11
"""

GLOSSARY = """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | Scheduled pass that turns due subscriptions into invoices. | invoice job | `BillingRun`[^billing-run] |

[^billing-run]: src/billing/run.py#L4-L5
"""

CONVENTIONS = """## Commands

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
"""

BILLING = """## Responsibility

Billing owns invoice posting and charge retries.

## How it works

`BillingRun.post` marks the invoice posted, then `schedule` decides whether a failed charge is retried.[^posted] [^retry-cap]

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Change the attempt cap | `MAX_ATTEMPTS`[^retry-cap] | `tests/test_retry.py` | `python -m pytest -q tests/test_retry.py` |

## Invariants

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never posted again. | `BillingRun.post`[^posted] | Customers are charged twice. |
| At most 3 charge attempts. | `schedule`[^retry-cap] | Repeated charges after a gateway timeout. |

Why 3 attempts: rationale not recorded.

[^posted]: src/billing/run.py#L7-L10
[^retry-cap]: src/billing/retry.py#L1-L7
"""

WORKFLOW = """## Flow

The `nightly_billing` Celery task posts one invoice through `BillingRun.post`.[^task]

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Schedule or batch size | `nightly_billing`[^task] | - | `tests/test_billing.py` |

[^task]: src/billing/tasks.py#L6-L8
"""


class Failure(Exception):
    pass


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def put(repo: Path, files: dict[str, str | None]) -> None:
    for rel, text in files.items():
        target = repo / rel
        if text is None:
            target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")


def commit(repo: Path, message: str, files: dict[str, str | None] | None = None) -> None:
    put(repo, files or {})
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)


def okf(repo: Path, *args: str, code: int = 0) -> dict | str:
    env = os.environ | {"PYTHONUTF8": "1"}
    result = subprocess.run(
        [sys.executable, str(OKF), *args], cwd=repo, capture_output=True, text=True, env=env,
        check=False,  # the exit code is compared with the expected one below
    )
    if result.returncode != code:
        raise Failure(f"okf {' '.join(args)} exited {result.returncode}, expected {code}:\n{result.stdout}\n{result.stderr}")
    return json.loads(result.stdout) if "--json" in args else result.stdout


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


def phase(repo: Path, expected: str) -> dict:
    status = okf(repo, "status", "--json")
    expect(status["phase"] == expected, f"phase {status['phase']!r}, expected {expected!r}: {json.dumps(status, indent=2)}")
    return status


def set_body(page: Path, body: str) -> None:
    text = page.read_text(encoding="utf-8")
    head, _, _ = text.partition("\n---\n")
    page.write_text(f"{head}\n---\n\n{body}", encoding="utf-8", newline="\n")


def brief(page: Path, text: str) -> None:
    """Write a discovery brief into the page's empty todo block."""
    body = page.read_text(encoding="utf-8")
    page.write_text(body.replace("<!-- okf:todo\n-->", f"<!-- okf:todo\n{text}\n-->", 1),
                    encoding="utf-8", newline="\n")


def approve(repo: Path, reviewer: str = "repo-wiki-reviewer/e2e") -> None:
    subject = okf(repo, "review", "prepare", "--json")
    report = {"subject_digest": subject["subject_digest"], "reviewer": reviewer, "verdict": "approved", "issues": []}
    (repo / subject["review_file"]).write_text(json.dumps(report), encoding="utf-8")


def run(base: Path) -> None:
    # init refuses a repository without a commit and leaves nothing behind.
    empty = base / "empty"
    empty.mkdir()
    git(empty, "init", "-q", "-b", "main")
    refused = okf(empty, "init", "--json", code=2)
    expect("no commit yet" in refused["error"] and not (empty / "docs").exists(), f"init without HEAD: {refused}")
    phase(empty, "init")

    repo = base / "shop"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "E2E")
    git(repo, "config", "user.email", "e2e@example.com")
    git(repo, "config", "commit.gpgsign", "false")
    commit(repo, "init", FIXTURE)
    wiki = repo / "docs/wiki"

    phase(repo, "init")
    okf(repo, "init", "--json")
    commit(repo, "wiki stubs")  # a wiki-only commit must not make drafts stale
    phase(repo, "discover")

    scan = okf(repo, "scan", "--json")
    modules = sorted(m["path"] for m in scan["modules"])
    # src/ is a code root: its packages are the modules; tests/ is no module.
    expect(modules == ["src/billing", "src/payments", "third_party"], f"scan modules {modules}")
    expect(any(c["command"] == "python -m pytest -q" and c["kind"] == "test" for c in scan["commands"]),
           f"scan misses the test command: {scan['commands']}")
    expect(all(c["kind"] in ("build", "test", "lint", "format", "typecheck", "other")
               for c in scan["commands"]), f"scan command kinds {scan['commands']}")
    expect(scan["sources"][0]["shallow"] is False, f"scan sources {scan['sources']}")
    expect(scan["truncated"] == {}, f"scan truncated {scan['truncated']}")
    expect([(t["path"], t["kinds"]) for t in scan["triggers"]] == [("src/billing/tasks.py", ["job"])],
           f"scan triggers {scan['triggers']}")
    expect(any(d["from"] == "src/billing" and d["to"] == "src/payments" for d in scan["deps"]),
           f"scan deps {scan['deps']}")

    okf(repo, "new", "--type", "Module", "--name", "billing", "--description",
        "Read before changing invoice posting or charge retries.", "--scope", "src/billing/**", "--json")
    status = phase(repo, "discover")  # a stub without a brief while the canon briefs are empty
    expect("modules/billing.md" in status["next_actions"][0], f"discover actions {status['next_actions']}")
    set_body(wiki / "modules/billing.md", "<!-- okf:todo\nInvariant: posted invoice never reposted src/billing/run.py#L7-L10\n-->\n\n## Responsibility\n")
    status = phase(repo, "discover")  # every canon page needs its brief
    expect("architecture.md" in status["next_actions"][0], f"discover actions {status['next_actions']}")
    brief(wiki / "architecture.md", "Boundary: billing -> payments via Client src/billing/run.py#L1")
    brief(wiki / "glossary.md", "Term: Billing run src/billing/run.py#L4-L5")
    brief(wiki / "conventions.md", "Command: make test Makefile#L1-L2")
    status = phase(repo, "discover")  # the Celery task starts a flow no workflow page traces yet
    expect("1 trigger files" in status["next_actions"][0] and status["issues"][0]["code"] == "trigger-coverage",
           f"discover actions {json.dumps(status, indent=2)}")
    okf(repo, "new", "--type", "Workflow", "--name", "nightly-billing", "--description",
        "Read before changing the nightly billing task.", "--scope", "src/billing/tasks.py", "--json")
    brief(wiki / "workflows/nightly-billing.md", "Trace: nightly_billing -> BillingRun.post src/billing/tasks.py#L6-L8")
    hints = [i for i in okf(repo, "validate", "--json", code=1)["issues"]  # coverage errors remain
             if i["code"] == "hint" and i["page"] == "workflows/nightly-billing.md"]
    expect(len(hints) == 3 and all(i["severity"] == "pending" for i in hints), f"template hints: {hints}")
    status = phase(repo, "structure")  # src/payments and third_party are in no scope yet
    expect(status["issues"][0]["code"] == "coverage", f"structure issues {status['issues']}")
    set_body(wiki / "architecture.md", ARCHITECTURE)
    set_body(wiki / "glossary.md", GLOSSARY)
    set_body(wiki / "conventions.md", CONVENTIONS)
    phase(repo, "write")  # canon done; billing still holds its todo block
    set_body(wiki / "modules/billing.md", BILLING.replace("Billing owns", "The invoice job owns"))
    validation = okf(repo, "validate", "--json")
    expect(any(i["code"] == "alias" for i in validation["issues"]), "alias drift not reported")
    set_body(wiki / "modules/billing.md", BILLING)
    set_body(wiki / "workflows/nightly-billing.md", WORKFLOW)
    validation = okf(repo, "validate", "--json")
    expect(validation["errors"] == 0 and validation["pending"] == 0, f"validate: {json.dumps(validation, indent=2)}")

    status = phase(repo, "review")
    expect(any("--unreviewed" in a for a in status["next_actions"]), "no unreviewed fallback offered")
    subject = okf(repo, "review", "prepare", "--json")
    expect(len(subject["pages"]) == 5, f"review subject pages {subject['pages']}")
    report = {
        "subject_digest": subject["subject_digest"], "reviewer": "repo-wiki-reviewer/e2e",
        "verdict": "changes_requested",
        "issues": [{"page": "modules/billing.md", "kind": "missing", "claim": "posting calls payments",
                    "fix": "Mention that posting charges through Client.", "locator": "src/billing/run.py#L11"}],
    }
    (repo / subject["review_file"]).write_text(json.dumps(report), encoding="utf-8")
    status = phase(repo, "review")
    expect(not any("--unreviewed" in a for a in status["next_actions"]), f"--unreviewed offered: {status}")
    okf(repo, "stamp", "--by", "repo-wiki/e2e", "--json", code=1)  # changes requested blocks stamp
    refused = okf(repo, "stamp", "--by", "repo-wiki/e2e", "--unreviewed", "--json", code=1)
    expect(any("requests changes (1 issues)" in i["message"] for i in refused["issues"]), f"unreviewed stamp: {refused}")

    set_body(wiki / "modules/billing.md", BILLING.replace(
        "retries.\n", "retries. Posting charges through `payments.Client`.[^charge]\n"
    ) + "[^charge]: src/billing/run.py#L11\n")
    phase(repo, "review")  # the old report is stale now
    approve(repo)
    phase(repo, "stamp")
    stamped = okf(repo, "stamp", "--by", "repo-wiki/e2e", "--json")
    expect(len(stamped["stamped"]) == 5 and stamped["verified_by"] == "repo-wiki-reviewer/e2e", f"stamp: {stamped}")
    expect(isinstance(stamped["warnings"], list) and "docs/wiki/index.md" in stamped["derived"]
           and "docs/wiki/log.md" in stamped["derived"], f"stamp: {stamped}")
    expect(not (wiki / "_review.json").exists(), "_review.json survived stamp")
    index = (wiki / "index.md").read_text(encoding="utf-8")
    expect("[Billing](modules/billing.md)" in index and "`third_party/` - Not covered" in index, f"index:\n{index}")
    commit(repo, "wiki v1")
    status = phase(repo, "done")
    expect(status["next_actions"] == ["nothing to do: the wiki is committed and current"], f"done: {status}")

    pointer = okf(repo, "pointer")
    expect("ruff check ." in pointer and "python -m pytest" not in pointer, f"pointer:\n{pointer}")
    expect(len(pointer.strip().splitlines()) <= 15, "pointer longer than 15 lines")
    files = okf(repo, "impact", "--files", "src/billing/retry.py", "third_party/vendor.py", "--json")["files"]
    retry = files["src/billing/retry.py"]
    expect(retry["read"] == ["modules/billing.md"] and retry["update"] == ["modules/billing.md"]
           and [(r["change"], r["verify"]) for r in retry["change_guide"]]
           == [("Change the attempt cap", "python -m pytest -q tests/test_retry.py")]
           and retry["canon"] == ["glossary.md", "conventions.md"] and retry["note"] is None,
           f"impact --files: {retry}")
    expect(files["third_party/vendor.py"]["note"] == "not covered: Vendored upstream code; never modified here.",
           f"impact --files not covered: {files}")
    files = okf(repo, "impact", "--files", str(repo / "src/billing"), "--json")
    expect("modules/billing.md" in files["files"]["src/billing"]["read"], f"impact --files on a directory: {files}")
    okf(repo, "validate", "modules/nosuch.md", code=2)  # a page filter must name a page
    # Read-only commands walk up from a subdirectory; relative paths start there.
    files = okf(repo / "src/billing", "impact", "--files", "retry.py", "--json")["files"]
    expect(files["src/billing/retry.py"]["read"] == ["modules/billing.md"], f"impact from a subdirectory: {files}")
    expect(okf(repo / "src", "status", "--json")["phase"] == "done", "status from a subdirectory")
    wrong = okf(repo, "--wiki", "kb", "status", "--json")
    expect(wrong["phase"] == "blocked" and "--wiki docs/wiki" in wrong["next_actions"][0], f"wrong --wiki: {wrong}")

    # A stable page edited by hand is caught.
    billing = (wiki / "modules/billing.md").read_text(encoding="utf-8")
    (wiki / "modules/billing.md").write_text(billing + "\nExtra.\n", encoding="utf-8")
    validation = okf(repo, "validate", "--json", code=1)
    expect(any(i["code"] == "unreviewed-edit" for i in validation["issues"]), "hand edit not caught")
    (wiki / "modules/billing.md").write_text(billing, encoding="utf-8")

    # Code changes: lines move in run.py, the retry cap changes, a module appears.
    commit(repo, "change code", {
        "src/billing/run.py": "# billing entry\n\n" + FIXTURE["src/billing/run.py"],
        "src/billing/retry.py": FIXTURE["src/billing/retry.py"].replace("3", "5"),
        "worker/jobs.py": "def nightly():\n    pass\n",
        "src/billing/api.py": "@app.post('/invoices')\ndef create():\n    pass\n",
    })
    report = okf(repo, "impact", "--json")
    by_page = {p["page"]: p["reasons"] for p in report["pages"]}
    kinds = {r["kind"] for r in by_page.get("modules/billing.md", [])}
    expect({"cited-moved", "cited-changed"} <= kinds, f"billing reasons {by_page}")
    moved = [r for r in by_page["modules/billing.md"] if r["kind"] == "cited-moved" and r["label"] == "posted"]
    expect(moved and moved[0]["suggested"] == "src/billing/run.py#L9-L12", f"moved suggestion {moved}")
    expect(report["unmapped_modules"] == ["worker"], f"unmapped {report['unmapped_modules']}")
    expect(report["unclaimed_triggers"] == [{"path": "src/billing/api.py", "kinds": ["http"]}],
           f"unclaimed triggers {report['unclaimed_triggers']}")
    phase(repo, "update")

    update = okf(repo, "update", "--json")
    expect("modules/billing.md" in update["drafted"] and "architecture.md" in update["drafted"], f"update {update}")
    billing = (wiki / "modules/billing.md").read_text(encoding="utf-8")
    expect("status: draft" in billing and "suggested src/billing/run.py#L9-L12" in billing, billing)
    expect(" (since " in billing, f"reason lines lack their base revision:\n{billing}")
    arch = (wiki / "architecture.md").read_text(encoding="utf-8")
    expect("unclaimed-trigger src/billing/api.py (http)" in arch, f"architecture todo:\n{arch}")
    phase(repo, "structure")  # worker is unmapped

    # HEAD moves under the drafts: status asks for update, update rebases.
    commit(repo, "unrelated", {"README.md": "# Shop\n\nBilling service.\n"})
    phase(repo, "update")
    okf(repo, "update", "--json")
    phase(repo, "structure")

    arch = (wiki / "architecture.md").read_text(encoding="utf-8")
    arch = arch.replace("| `tests/` |", "| `worker/` | Scheduled jobs, documented later. |\n"
                        "| `src/billing/api.py` | One route onto `BillingRun.post`; no flow of its own. |\n| `tests/` |")
    arch = arch.split("<!-- okf:todo", 1)[0] + arch.split("-->\n", 1)[1].lstrip("\n")
    (wiki / "architecture.md").write_text(arch, encoding="utf-8")
    body = BILLING.replace("At most 3", "At most 5").replace("Why 3", "Why 5").replace(
        "#L7-L10", "#L9-L12")
    set_body(wiki / "modules/billing.md", body)
    arch_body = (wiki / "architecture.md").read_text(encoding="utf-8").replace("run.py#L1-L11", "run.py#L1-L13")
    (wiki / "architecture.md").write_text(arch_body, encoding="utf-8")
    glossary = (wiki / "glossary.md").read_text(encoding="utf-8")
    expect("suggested src/billing/run.py#L6-L7" in glossary, f"glossary not redrafted:\n{glossary}")
    set_body(wiki / "glossary.md", GLOSSARY.replace("#L4-L5", "#L6-L7"))
    status = okf(repo, "status", "--json")
    expect(status["phase"] == "review", f"after repair: {json.dumps(status, indent=2)}")
    stamped = okf(repo, "stamp", "--by", "repo-wiki/e2e", "--unreviewed", "--json")
    billing = (wiki / "modules/billing.md").read_text(encoding="utf-8")
    expect("verified:" not in billing and "status: stable" in billing, "unreviewed stamp wrote verified")
    commit(repo, "wiki v2")
    phase(repo, "done")

    # A reviewer entry added by hand to an --unreviewed stamp is an unreviewed edit.
    billing = (wiki / "modules/billing.md").read_text(encoding="utf-8")
    forged = billing.replace("stamp:\n", "verified:\n- by: repo-wiki-reviewer/fake\n  at: '2099-01-01T00:00:00Z'\nstamp:\n", 1)
    expect(forged != billing, "could not forge verified")
    (wiki / "modules/billing.md").write_text(forged, encoding="utf-8")
    validation = okf(repo, "validate", "--json", code=1)
    expect(any(i["code"] == "unreviewed-edit" for i in validation["issues"]), "forged verified not caught")
    (wiki / "modules/billing.md").write_text(billing, encoding="utf-8")

    okf(repo, "verify", "--actor", "human:alice", "modules/billing.md", "--json")
    billing = (wiki / "modules/billing.md").read_text(encoding="utf-8")
    expect("human:alice" in billing, "human verification missing")
    commit(repo, "human review")
    phase(repo, "done")

    # A cited file renamed out of every scope is followed, not reported deleted.
    git(repo, "mv", "src/billing/retry.py", "src/core_retry.py")
    commit(repo, "move retry")
    report = okf(repo, "impact", "--json")
    moved = {(p["page"], r["kind"], r.get("suggested")) for p in report["pages"] for r in p["reasons"]
             if r["kind"].startswith("cited-") and r["path"] == "src/billing/retry.py"}
    expect(moved == {("modules/billing.md", "cited-moved", "src/core_retry.py#L1-L7")},
           f"renamed citation: {json.dumps(report, indent=2)}")

    # A missing canon page routes to research with the command that restores it,
    # never to an update that could not place its reasons.
    (wiki / "architecture.md").unlink()
    commit(repo, "lose architecture", {"jobs/cron.py": "def tick():\n    pass\n"})
    status = phase(repo, "research")
    expect(status["next_actions"][0] == "recreate the canon page: okf new --type Architecture", f"{status}")
    update = okf(repo, "update", "--json")
    expect(any(u["reason"].startswith("unmapped-module jobs") for u in update["unplaced"]), f"unplaced: {update}")
    phase(repo, "research")


# --- hub: two sources that share a route, a topic and a library -------------------------

HUB_API = {
    "pom.xml": (
        "<project>\n  <groupId>com.acme</groupId>\n  <artifactId>order-api</artifactId>\n  <dependencies>\n"
        "    <dependency>\n      <groupId>com.acme</groupId>\n      <artifactId>common</artifactId>\n"
        "    </dependency>\n  </dependencies>\n</project>\n"
    ),
    "src/main/java/com/acme/order/OrderController.java": (
        "package com.acme.order;\n\n@RestController\n@RequestMapping(\"/api/orders\")\n"
        "public class OrderController {\n  @PostMapping\n  public Order create(Order order) {\n"
        "    inventory.reserve(order.id);\n    kafka.send(\"order-created\", order);\n    return order;\n  }\n}\n"
    ),
    "src/main/java/com/acme/order/InventoryClient.java": (
        "package com.acme.order;\n\n@FeignClient(name = \"worker\")\npublic interface InventoryClient {\n"
        "  @PostMapping(\"/reservations/{orderId}\")\n  void reserve(@PathVariable long orderId);\n}\n"
    ),
}
HUB_WORKER = {
    "pom.xml": "<project>\n  <groupId>com.acme</groupId>\n  <artifactId>common</artifactId>\n</project>\n",
    "src/main/java/com/acme/inv/ReservationController.java": (
        "package com.acme.inv;\n\n@RestController\npublic class ReservationController {\n"
        "  @PostMapping(\"/reservations/{id}\")\n  public void reserve(long id) {\n"
        "    if (id <= 0) throw new IllegalArgumentException(\"id\");\n  }\n\n"
        "  @KafkaListener(topics = \"order-created\")\n  public void onOrder(String message) {}\n}\n"
    ),
}
ORDER = "api/src/main/java/com/acme/order/OrderController.java"
CLIENT = "api/src/main/java/com/acme/order/InventoryClient.java"
RESERVE = "worker/src/main/java/com/acme/inv/ReservationController.java"
RESERVE_ID = "http POST /reservations/{}"

HUB_BODIES = {
    "glossary.md": f"""| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Reservation | In worker, stock held for one order until it ships. | hold | `ReservationController`[^res] |

[^res]: {RESERVE}#L4
""",
    "conventions.md": """## Rules

| Area | Rule | Enforced by |
|---|---|---|
| dependencies | api builds against worker's `common` artifact; release common first.[^common] | review |

[^common]: api/pom.xml#L5-L8
""",
    "sources/api/conventions.md": """## Commands

| Purpose | Command | Status |
|---|---|---|
| Tests | `mvn -q test`[^pom] | not-run |

## Rules

| Area | Rule | Enforced by |
|---|---|---|

[^pom]: api/pom.xml#L1-L3
""",
    "sources/worker/conventions.md": """## Commands

| Purpose | Command | Status |
|---|---|---|

## Rules

| Area | Rule | Enforced by |
|---|---|---|
""",
    "sources/api/modules/orders.md": f"""## Responsibility

Orders owns order creation and the calls it makes to worker.

## How it works

`create` reserves stock through `InventoryClient`[^create] and publishes `order-created`.[^create]

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Order creation | `OrderController.create`[^create] | - | `mvn -q test` |

[^create]: {ORDER}#L7-L11
""",
    "sources/worker/modules/inventory.md": f"""## Responsibility

Inventory owns reservations.

## How it works

`reserve` rejects ids that are not positive.[^guard]

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Reservation rules | `ReservationController.reserve`[^guard] | - | `mvn -q test` |

[^guard]: {RESERVE}#L5-L8
""",
    "flows/order-placement.md": f"""## Call chain

| Step | Source | Entry | Contract | Next |
|---|---|---|---|---|
| 1 | api | `OrderController.create`[^create] | `{RESERVE_ID}` | worker reserves stock |
| 2 | worker | `ReservationController.reserve`[^reserve] | - | api publishes the order |
| 3 | api | `OrderController.create`[^create] | `topic order-created` | worker handles the event |
| 4 | worker | `ReservationController.onOrder`[^listen] | - | - |

```mermaid
sequenceDiagram
  participant api
  participant worker
  api->>worker: POST /reservations/{{id}}
  api->>worker: order-created
```

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Reservation request | `InventoryClient.reserve`[^client] | `ReservationController.reserve` | `mvn -q test` in both |

[^create]: {ORDER}#L7-L11
[^reserve]: {RESERVE}#L5-L8
[^listen]: {RESERVE}#L10-L11
[^client]: {CLIENT}#L5-L6
""",
    "sources/api/overview.md": """## Structure

One module, [orders](/sources/api/modules/orders.md); it calls worker as described in
[order placement](/flows/order-placement.md).

## Not covered

| Path | Reason |
|---|---|
""",
    "sources/worker/overview.md": """## Structure

One module, [inventory](/sources/worker/modules/inventory.md).

## Not covered

| Path | Reason |
|---|---|
""",
    "architecture.md": """## Structure

api owns orders and calls worker, which owns inventory; see the
[System map](/system-map.md), [api](/sources/api/overview.md), [worker](/sources/worker/overview.md)
and [order placement](/flows/order-placement.md).

## Contracts

| Contract | Provider | Consumers | Change order | Verify |
|---|---|---|---|---|
| `library com.acme:common` | worker | api | Release common from worker first, then bump api.[^common] | `mvn -q verify` in both |

## Not covered

| Path | Reason |
|---|---|

[^common]: api/pom.xml#L5-L8
""",
}


def hub_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "E2E")
    git(path, "config", "user.email", "e2e@example.com")
    git(path, "config", "commit.gpgsign", "false")
    commit(path, "init", files)
    return path


def claim(page: Path, contracts: list[str]) -> None:
    """Add a contracts list to a page's frontmatter (what a tracer does by hand)."""
    text = page.read_text(encoding="utf-8")
    lines = "".join(f"- {c}\n" for c in contracts)
    page.write_text(text.replace("\nscope: []\n", f"\nscope: []\ncontracts:\n{lines}", 1), encoding="utf-8")


def run_hub(base: Path) -> None:
    hub = hub_repo(base / "hub", {"README.md": "# Platform\n"})
    hub_repo(hub / "api", HUB_API)
    worker = hub_repo(hub / "worker", HUB_WORKER)
    api = hub / "api"
    init = okf(hub, "init", "--hub", "--source", "api", "--source", "worker", "--json")
    expect(init["pages"] == [
        "docs/wiki/glossary.md", "docs/wiki/conventions.md", "docs/wiki/architecture.md",
        "docs/wiki/sources/api/conventions.md", "docs/wiki/sources/api/overview.md",
        "docs/wiki/sources/worker/conventions.md", "docs/wiki/sources/worker/overview.md",
    ], f"hub init: {init}")
    commit(hub, "wiki stubs")
    wiki = hub / "docs/wiki"
    phase(hub, "discover")

    scan = okf(hub, "scan")
    ids = [c["id"] for c in json.loads(scan)["contracts"]]
    expect(ids == ["http POST /reservations/{}", "library com.acme:common", "topic order-created"], f"contracts {ids}")
    links = okf(hub, "links", "--file", CLIENT, "--json")
    (link,) = links["contracts"]
    expect(link["id"] == RESERVE_ID and link["providers"] == [{"source": "worker", "locator": f"{RESERVE}#L5"}],
           f"links --file: {links}")

    for path in ("glossary.md", "conventions.md", "architecture.md", "sources/api/conventions.md",
                 "sources/api/overview.md", "sources/worker/conventions.md", "sources/worker/overview.md"):
        brief(wiki / path, "Brief: from discovery")
    okf(hub, "new", "--type", "Module", "--name", "orders", "--scope", "api/src/**",
        "--description", "Read before changing order creation.", "--json")
    out = okf(hub, "new", "--type", "Module", "--name", "inventory", "--scope", "worker/src/**",
              "--description", "Read before changing reservations.", "--json")
    expect(out["page"] == "docs/wiki/sources/worker/modules/inventory.md", f"derived path: {out}")
    okf(hub, "new", "--type", "Module", "--name", "both", "--scope", "api/src/**", "--scope", "worker/src/**",
        "--description", "d", code=2)
    brief(wiki / "sources/api/modules/orders.md", "Entry: create")
    brief(wiki / "sources/worker/modules/inventory.md", "Entry: reserve")
    status = phase(hub, "discover")  # triggers and contracts are traced into no page yet
    expect(any("3 contracts" in a for a in status["next_actions"]), f"discover: {status['next_actions']}")
    out = okf(hub, "new", "--type", "Flow", "--name", "order-placement", "--scope", ORDER, "--scope", RESERVE,
              "--contract", RESERVE_ID, "--contract", "topic order-created",
              "--description", "Read before changing how an order reserves stock in worker.", "--json")
    expect(out["page"] == "docs/wiki/flows/order-placement.md", f"flow path: {out}")
    okf(hub, "new", "--type", "Flow", "--name", "x", "--scope", ORDER, "--scope", RESERVE,
        "--contract", "topic nope", "--description", "d", code=2)
    brief(wiki / "flows/order-placement.md", "Trace: create -> reserve")
    status = phase(hub, "structure")  # the library contract is claimed by no page
    codes = {i["code"] for i in status["issues"] if i["severity"] == "error"}
    expect(codes == {"link-coverage"}, f"structure issues: {status['issues']}")
    claim(wiki / "architecture.md", ["library com.acme:common"])
    phase(hub, "research")
    for path in ("glossary.md", "conventions.md", "sources/api/conventions.md", "sources/worker/conventions.md"):
        set_body(wiki / path, HUB_BODIES[path])
    phase(hub, "write")
    for path in ("sources/api/modules/orders.md", "sources/worker/modules/inventory.md", "flows/order-placement.md"):
        set_body(wiki / path, HUB_BODIES[path])
    phase(hub, "assemble")
    for path in ("sources/api/overview.md", "sources/worker/overview.md", "architecture.md"):
        set_body(wiki / path, HUB_BODIES[path])
    issues = okf(hub, "validate", "--json")
    expect(issues["errors"] == 0 and issues["pending"] == 0, f"hub validate: {json.dumps(issues, indent=2)}")
    phase(hub, "review")
    approve(hub)
    stamped = okf(hub, "stamp", "--by", "repo-wiki/e2e", "--json")
    expect(len(stamped["stamped"]) == 10, f"hub stamp: {stamped}")
    expect(set(stamped["derived"]) == {f"docs/wiki/{p}" for p in (
        "index.md", "log.md", "system-map.md", "sources/api/index.md", "sources/worker/index.md")},
        f"derived files: {stamped['derived']}")
    root_index = (wiki / "index.md").read_text(encoding="utf-8")
    expect("* [api](sources/api/) - Read before changing api" in root_index
           and "[Order Placement](flows/order-placement.md)" in root_index
           and "(reviewed " in root_index and "modules/orders.md" not in root_index, f"root index:\n{root_index}")
    api_index = (wiki / "sources/api/index.md").read_text(encoding="utf-8")
    expect(not api_index.startswith("---") and "[Orders](modules/orders.md)" in api_index
           and "* `api/src/` - [Order Placement](/flows/order-placement.md), [Orders](modules/orders.md)"
           in api_index, f"api index:\n{api_index}")
    system_map = (wiki / "system-map.md").read_text(encoding="utf-8")
    expect("type: Map" in system_map and f"| `{RESERVE_ID}` | worker `{RESERVE}#L5` |" in system_map
           and "[Order Placement](/flows/order-placement.md)" in system_map, f"system map:\n{system_map}")
    log = (wiki / "log.md").read_text(encoding="utf-8")
    expect(log.count("**Creation**") == 10 and "reviewed by repo-wiki-reviewer/e2e" in log, f"log:\n{log}")
    pointer = okf(hub, "pointer", "--source", "api")
    expect("docs/wiki/sources/api/index.md" in pointer and "docs/wiki/sources/api/conventions.md" in pointer
           and "docs/wiki/system-map.md" in pointer and len(pointer.splitlines()) <= 15, f"pointer:\n{pointer}")
    commit(hub, "wiki v1")
    status = phase(hub, "done")
    expect(status["next_actions"] == ["nothing to do: the wiki is committed and current"], f"hub done: {status}")
    entries = okf(hub, "log", "--files", RESERVE, "--json")["entries"]
    expect({e["path"] for e in entries} == {"sources/worker/modules/inventory.md", "flows/order-placement.md",
                                            "glossary.md"}, f"okf log --files: {entries}")

    files = okf(hub, "impact", "--files", CLIENT, "--json")["files"][CLIENT]
    (contract,) = files["contracts"]
    expect(contract["id"] == RESERVE_ID and contract["role"] == "consumer"
           and contract["counterparts"] == [f"worker {RESERVE}#L5"]
           and contract["pages"] == ["flows/order-placement.md"], f"impact contracts: {files}")
    expect(files["canon"] == ["glossary.md", "conventions.md", "sources/api/conventions.md",
                              "sources/api/overview.md"], f"impact canon: {files['canon']}")
    common = okf(hub, "impact", "--files", "worker/pom.xml", "--json")["files"]["worker/pom.xml"]["contracts"]
    expect(common[0]["change_order"][0]["change_order"].startswith("Release common from worker first"),
           f"change order row: {common}")

    # A consumer-side change outside every Flow scope still stales the Flow page.
    commit(api, "add quantity", {"src/main/java/com/acme/order/InventoryClient.java": HUB_API[
        "src/main/java/com/acme/order/InventoryClient.java"].replace("long orderId)", "long orderId, int qty)")})
    phase(hub, "update")
    report = okf(hub, "impact", "--json")
    kinds = {p["page"]: {r["kind"] for r in p["reasons"]} for p in report["pages"]}
    expect(kinds == {"flows/order-placement.md": {"contract-changed", "cited-changed"},
                     "sources/api/modules/orders.md": {"scope-modified"}}, f"hub impact: {kinds}")
    update = okf(hub, "update", "--json")
    flow = (wiki / "flows/order-placement.md").read_text(encoding="utf-8")
    expect(f"contract-changed {RESERVE_ID} {CLIENT}" in flow and "flows/order-placement.md" in update["drafted"],
           f"update: {update}")
    del worker


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            run(Path(tmp))
            run_hub(Path(tmp))
        except Failure as exc:
            print(f"FAIL: {exc}")
            return 1
    print("run_cli_e2e: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
