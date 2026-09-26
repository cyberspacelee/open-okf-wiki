#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-2 routing recall: does the wiki index lead an agent to the right pages?

Real commits made after the wiki was written become tasks (the commit message
is the task, the touched source files are the answer key). A router sees only
the wiki ``index.md`` and the task text and names up to K pages; a task's file
is covered when one of those pages has it in its ``scope`` or cites it.

Subcommands (run from the repository or hub root, or pass --repo):

  tasks     derive tasks from commits after --since (JSON)
  packet    router packets, one JSONL line per task: {id, task, index, k}
  baseline  deterministic token-overlap router; writes answers JSONL
  score     file recall, task hit rate and full-coverage rate for answers
  selftest  build fixture repositories and check the whole pipeline

Answers are JSONL lines {"id": ..., "pages": ["modules/billing.md", ...]};
page paths may be wiki-relative or carry the wiki directory prefix.
"""

import argparse
import contextlib
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import _config
import _page
import _validate

DEFAULT_K = 3
MAX_TASK_CHARS = 1000


class EvalError(Exception):
    """User-facing; the message names the fix."""


# --- git -----------------------------------------------------------------------------


def git(repo: Path, *args: str, env: dict | None = None) -> str:
    result = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, check=False,
    )
    if result.returncode:
        raise EvalError(f"git {' '.join(args)} failed in {repo}: {result.stderr.strip()}")
    return result.stdout


def _is_ancestor(repo: Path, old: str, new: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new], capture_output=True, check=False
    )
    return result.returncode == 0


def _verify(repo: Path, rev: str) -> str:
    if not rev or rev.startswith("-"):
        raise EvalError(f"invalid revision {rev!r}")
    try:
        return git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}").strip()
    except EvalError:
        raise EvalError(f"revision {rev} does not exist in {repo}; pass an existing commit to --since") from None


# --- workspace and pages ------------------------------------------------------------------


def workspace(args) -> _config.Workspace:
    return _config.load(Path(args.repo), args.wiki)


def author_pages(ws: _config.Workspace) -> list[_page.Page]:
    return [p for p in _page.load_pages(ws) if not p.error and not p.is_generated]


def page_files(page: _page.Page) -> tuple[list[str], set[str]]:
    """(scope globs, cited workspace paths) of a page."""
    globs = [g for g in page.scope if isinstance(g, str) and g.strip()]
    cited = {loc.path for _, loc, _ in _validate.cited_locators(page)}
    return globs, cited


def covers(entry: tuple[list[str], set[str]], path: str) -> bool:
    globs, cited = entry
    return path in cited or any(_config.glob_match(g, path) for g in globs)


# --- tasks --------------------------------------------------------------------------------


def _since_map(ws: _config.Workspace, values: list[str] | None) -> dict[str, str]:
    """Source name -> commit after which commits become tasks."""
    values = values or []
    if not ws.hub:
        if len(values) > 1 or any("=" in v for v in values):
            raise EvalError("a single repository takes one --since REV")
        source = ws.sources[0]
        if values:
            return {source.name: _verify(source.path, values[0])}
        last = git(ws.root, "log", "-1", "--format=%H", "--", ws.wiki_rel).strip()
        if not last:
            raise EvalError(f"no commit touches {ws.wiki_rel}; commit the wiki or pass --since REV")
        return {source.name: last}
    given: dict[str, str] = {}
    for value in values:
        name, sep, rev = value.partition("=")
        if not sep or name not in {s.name for s in ws.sources}:
            raise EvalError(f"--since {value!r}: in a hub use --since SOURCE=REV with one of "
                            f"{', '.join(s.name for s in ws.sources)}")
        given[name] = rev
    result = {}
    pages = author_pages(ws)
    for source in ws.sources:
        if source.name in given:
            result[source.name] = _verify(source.path, given[source.name])
            continue
        revs = sorted({
            p.revision[source.name] for p in pages
            if p.status == "stable" and isinstance(p.revision.get(source.name), str)
        })
        revs = [r for r in revs if _rev_ok(source.path, r)]
        if not revs:
            raise EvalError(f"no stable page records a revision of source {source.name}; "
                            f"stamp the wiki or pass --since {source.name}=REV")
        result[source.name] = _newest(source.path, revs)
    return result


def _rev_ok(repo: Path, rev: str) -> bool:
    try:
        _verify(repo, rev)
        return True
    except EvalError:
        return False


def _newest(repo: Path, revs: list[str]) -> str:
    """The revision every other one is an ancestor of; else the latest by commit time."""
    for rev in revs:
        if all(other == rev or _is_ancestor(repo, other, rev) for other in revs):
            return rev
    return max(revs, key=lambda r: int(git(repo, "show", "-s", "--format=%ct", r).strip()))


def _message(text: str, limit: int) -> str:
    text = "\n".join(line.rstrip() for line in text.strip().splitlines())
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def derive_tasks(ws: _config.Workspace, since: dict[str, str], limit: int | None, max_chars: int) -> list[dict]:
    found = []
    for source in ws.sources:
        commits = git(source.path, "rev-list", "--reverse", "--no-merges", f"{since[source.name]}..HEAD").split()
        for sha in commits:
            names = git(source.path, "diff-tree", "--no-commit-id", "-r", "--name-only", "--no-renames", "-z", sha)
            files = []
            for path in (p for p in names.split("\0") if p):
                if not ws.hub and (path == ws.wiki_rel or path.startswith(ws.wiki_rel + "/")):
                    continue
                files.append(source.prefix + path)
            if not files:
                continue
            meta = git(source.path, "show", "-s", "--format=%ct%x00%s%n%n%b", sha)
            stamp, _, message = meta.partition("\0")
            found.append({
                "id": f"{source.name}@{sha[:12]}" if ws.hub else sha[:12],
                "source": source.name,
                "commit": sha,
                "time": int(stamp),
                "task": _message(message, max_chars),
                "files": sorted(files),
            })
            if limit and not ws.hub and len(found) >= limit:
                break
    if ws.hub:  # interleave the sources' histories by commit time
        found.sort(key=lambda t: (t["time"], t["source"]))
    tasks = found[:limit] if limit else found
    for task in tasks:
        del task["time"]
    return tasks


def cmd_tasks(args) -> int:
    ws = workspace(args)
    since = _since_map(ws, args.since)
    tasks = derive_tasks(ws, since, args.limit, args.max_chars)
    result = {"repo": str(ws.root), "wiki": ws.wiki_rel, "hub": ws.hub, "since": since, "tasks": tasks}
    _write(args.out, json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    if args.out:
        print(f"{len(tasks)} task(s) -> {args.out}", file=sys.stderr)
    return 0


def load_tasks(path: str) -> list[dict]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvalError(f"cannot read tasks file {path} ({exc}); write it with the tasks subcommand") from None
    tasks = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(tasks, list) or not all(isinstance(t, dict) and "id" in t and "task" in t and "files" in t for t in tasks):
        raise EvalError(f"{path} is not a tasks file; write it with the tasks subcommand")
    return tasks


def _write(out: str | None, text: str) -> None:
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(text, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(text)


def _jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


# --- packet ------------------------------------------------------------------------------


def cmd_packet(args) -> int:
    ws = workspace(args)
    index = ws.wiki / "index.md"
    if not index.is_file():
        raise EvalError(f"{ws.wiki_rel}/index.md not found; stamp the wiki first (okf stamp)")
    text = index.read_text(encoding="utf-8")
    rows = [{"id": t["id"], "task": t["task"], "index": text, "k": args.k} for t in load_tasks(args.tasks)]
    _write(args.out, _jsonl(rows))
    return 0


# --- baseline router ------------------------------------------------------------------------

_STOP = frozenset((
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "its",
    "of", "on", "or", "that", "the", "this", "to", "with", "read", "before", "changing", "change",
    "changes", "when", "how", "what", "which", "new", "add", "adds", "added", "fix", "fixes", "fixed",
    "use", "uses", "update", "updates", "updated", "make", "makes", "src", "lib", "py", "md",
))


def tokens(text: str) -> set[str]:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(text))
    out = set()
    for word in re.split(r"[^A-Za-z0-9]+", text.lower()):
        if len(word) < 2 or word.isdigit() or word in _STOP:
            continue
        if word.endswith("ies") and len(word) > 4:
            word = word[:-3] + "y"
        elif word.endswith("s") and not word.endswith("ss") and len(word) > 3:
            word = word[:-1]
        if word not in _STOP:
            out.add(word)
    return out


def page_tokens(page: _page.Page) -> set[str]:
    parts = [str(page.meta.get("title") or ""), str(page.meta.get("description") or "")]
    parts += [g for g in page.scope if isinstance(g, str)]
    parts.append(Path(page.path).stem)
    return tokens(" ".join(parts))


def route(task: str, docs: dict[str, set[str]], k: int) -> list[str]:
    count = len(docs)
    df: dict[str, int] = {}
    for words in docs.values():
        for word in words:
            df[word] = df.get(word, 0) + 1
    wanted = tokens(task)
    scored = []
    for path, words in docs.items():
        score = sum(math.log((count + 1) / (df[w] + 1)) + 1 for w in wanted & words)
        if score > 0:
            scored.append((-score, path))
    return [path for _, path in sorted(scored)[:k]]


def cmd_baseline(args) -> int:
    ws = workspace(args)
    docs = {p.path: page_tokens(p) for p in author_pages(ws)}
    rows = [{"id": t["id"], "pages": route(t["task"], docs, args.k)} for t in load_tasks(args.tasks)]
    _write(args.out, _jsonl(rows))
    return 0


# --- score ---------------------------------------------------------------------------------


def load_answers(path: str) -> dict[str, list]:
    answers: dict[str, list] = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise EvalError(f"cannot read answers file {path} ({exc})") from None
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EvalError(f"{path}:{number} is not JSON ({exc}); write one {{id, pages}} object per line") from None
        if not isinstance(row, dict) or "id" not in row or not isinstance(row.get("pages"), list):
            raise EvalError(f"{path}:{number} needs {{\"id\": ..., \"pages\": [...]}}")
        answers[str(row["id"])] = row["pages"]
    return answers


def _normalize(ws: _config.Workspace, page: object) -> str:
    text = str(page).strip().split("#", 1)[0].removeprefix("./").lstrip("/")
    return text.removeprefix(ws.wiki_rel + "/")


def _oracle(files: list[str], entries: dict[str, tuple], k: int) -> set[str]:
    """Files a greedy best choice of k pages covers (a ceiling for any router)."""
    left, covered = set(files), set()
    for _ in range(k):
        best, gain = None, set()
        for path in sorted(entries):
            hit = {f for f in left if covers(entries[path], f)}
            if len(hit) > len(gain):
                best, gain = path, hit
        if best is None:
            break
        covered |= gain
        left -= gain
    return covered


def score(ws: _config.Workspace, tasks: list[dict], answers: dict[str, list], k: int) -> dict:
    entries = {p.path: page_files(p) for p in author_pages(ws)}
    rows = []
    for task in tasks:
        files = list(task["files"])
        raw = answers.get(str(task["id"]))
        chosen = [_normalize(ws, p) for p in (raw or [])]
        chosen = list(dict.fromkeys(chosen))
        over = chosen[k:]
        chosen = chosen[:k]
        unknown = [p for p in chosen if p not in entries]
        valid = [p for p in chosen if p in entries]
        covered = [f for f in files if any(covers(entries[p], f) for p in valid)]
        coverable = [f for f in files if any(covers(e, f) for e in entries.values())]
        rows.append({
            "id": task["id"],
            "answered": raw is not None,
            "pages": chosen,
            "unknown_pages": unknown,
            "over_k": over,
            "files": len(files),
            "covered": len(covered),
            "coverable": len(coverable),
            "oracle": len(_oracle(files, entries, k)),
            "uncovered": [f for f in files if f not in covered],
            "recall": len(covered) / len(files) if files else 1.0,
            "hit": bool(covered),
            "full": len(covered) == len(files),
        })
    n = len(rows)
    files = sum(r["files"] for r in rows)
    covered = sum(r["covered"] for r in rows)
    coverable = sum(r["coverable"] for r in rows)

    def rate(count: float, total: int) -> float:
        return count / total if total else 0.0

    summary = {
        "tasks": n,
        "answered": sum(r["answered"] for r in rows),
        "k": k,
        "files": files,
        "file_recall": rate(covered, files),
        "mean_task_recall": rate(sum(r["recall"] for r in rows), n),
        "hit_rate": rate(sum(r["hit"] for r in rows), n),
        "full_coverage_rate": rate(sum(r["full"] for r in rows), n),
        "coverable_file_rate": rate(coverable, files),
        "recall_of_coverable": rate(covered, coverable),
        "oracle_file_recall": rate(sum(r["oracle"] for r in rows), files),
        "oracle_full_coverage_rate": rate(sum(r["oracle"] == r["files"] for r in rows), n),
        "unknown_pages": sum(len(r["unknown_pages"]) for r in rows),
        "over_k": sum(len(r["over_k"]) for r in rows),
    }
    return {"summary": summary, "tasks": rows}


def print_score(result: dict) -> None:
    rows = [("id", "files", "covered", "coverable", "oracle", "hit", "full", "pages")]
    for r in result["tasks"]:
        rows.append((
            str(r["id"]), str(r["files"]), str(r["covered"]), str(r["coverable"]), str(r["oracle"]),
            "y" if r["hit"] else "-", "y" if r["full"] else "-", ", ".join(r["pages"]) or "(none)",
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())
    s = result["summary"]
    print(
        f"routing@{s['k']}: {s['tasks']} task(s), file recall {s['file_recall']:.2f} "
        f"(oracle {s['oracle_file_recall']:.2f}, coverable {s['coverable_file_rate']:.2f}), "
        f"hit rate {s['hit_rate']:.2f}, full coverage {s['full_coverage_rate']:.2f} "
        f"(oracle {s['oracle_full_coverage_rate']:.2f}), unknown pages {s['unknown_pages']}"
    )


def cmd_score(args) -> int:
    ws = workspace(args)
    result = score(ws, load_tasks(args.tasks), load_answers(args.answers), args.k)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_score(result)
    return 0


# --- selftest -------------------------------------------------------------------------------


def _repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    for key, value in (("user.name", "Eval"), ("user.email", "eval@example.com"), ("commit.gpgsign", "false")):
        git(path, "config", key, value)
    _commit(path, "init", files)
    return path


_CLOCK = [1_700_000_000]


def _dated() -> dict:
    """Environment with a strictly increasing commit date, so history order is deterministic."""
    _CLOCK[0] += 60
    date = f"{_CLOCK[0]} +0000"
    return os.environ | {"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}


def _commit(repo: Path, message: str, files: dict[str, str | None] | None = None) -> str:
    for rel, text in (files or {}).items():
        target = repo / rel
        if text is None:
            target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message, env=_dated())
    return git(repo, "rev-parse", "HEAD").strip()


def _set_body(ws: _config.Workspace, path: str, body: str) -> None:
    page = _page.load_page(ws, path)
    page.body = body
    _page.write_page(page)


def _stamp_wiki(ws: _config.Workspace, bodies: dict[str, str]) -> None:
    import _stamp

    for path, body in bodies.items():
        _set_body(ws, path, body)
    errors = [i.to_dict() for i in _validate.validate(ws) if i.severity in ("error", "pending")]
    if errors:
        raise EvalError(f"selftest wiki does not validate: {json.dumps(errors, indent=2)}")
    result = _stamp.stamp(ws, "repo-wiki/eval-routing", unreviewed=True)
    if result["blocked"]:
        raise EvalError(f"selftest stamp blocked: {json.dumps(result['blocked'], indent=2)}")


_CONVENTIONS = """## Commands

| Purpose | Command | Status |
|---|---|---|

## Rules

| Area | Rule | Enforced by |
|---|---|---|
"""


def _single_fixture(base: Path) -> tuple[Path, str, str]:
    repo = _repo(base / "shop", {
        "README.md": "# Shop\n",
        "src/billing/run.py": "class BillingRun:\n    def post(self, invoice):\n        invoice.posted = True\n",
        "src/billing/retry.py": "MAX_ATTEMPTS = 3\n",
        "src/payments/client.py": "class Client:\n    def charge(self, invoice):\n        return invoice.total\n",
        "tests/test_billing.py": "def test_post():\n    assert True\n",
    })
    ws = _config.init(repo)
    _page.new_page(ws, "modules/billing.md", "Module",
                   "Read before changing invoice posting or charge retries.", ["src/billing/**"])
    _page.new_page(ws, "modules/payments.md", "Module",
                   "Read before changing the payment gateway client or refunds.", ["src/payments/**"])
    _stamp_wiki(ws, {
        "architecture.md": "## Boundaries and dependencies\n\nBilling calls payments.[^post]\n\n"
                           "## Not covered\n\n| Path | Reason |\n|---|---|\n| `tests/` | Test code. |\n\n"
                           "[^post]: src/billing/run.py#L1-L3\n",
        "glossary.md": "| Term | Meaning | Avoid | Where |\n|---|---|---|---|\n"
                       "| Billing run | Pass that posts invoices. | | `BillingRun`[^run] |\n\n[^run]: src/billing/run.py#L1\n",
        "conventions.md": _CONVENTIONS,
        "modules/billing.md": "## Responsibility and boundaries\n\nPosting marks the invoice.[^post]\n\n"
                              "[^post]: src/billing/run.py#L2-L3\n",
        "modules/payments.md": "## Responsibility and boundaries\n\nThe client charges invoices.[^charge]\n\n"
                               "[^charge]: src/payments/client.py#L1-L3\n",
    })
    wiki_commit = _commit(repo, "wiki v1")
    _commit(repo, "Raise billing retry cap to five attempts\n\nGateway timeouts need more retries.",
            {"src/billing/retry.py": "MAX_ATTEMPTS = 5\n"})
    _commit(repo, "Payments client: support refunds",
            {"src/payments/client.py": "class Client:\n    def charge(self, invoice):\n        return invoice.total\n"
                                       "\n    def refund(self, invoice):\n        return -invoice.total\n"})
    _commit(repo, "Post invoices and charge the payment client\n\n" + "Long body line. " * 200, {
        "src/billing/run.py": "class BillingRun:\n    def post(self, invoice):\n        invoice.posted = True\n"
                              "        return invoice\n",
        "src/payments/client.py": "class Client:\n    def charge(self, invoice):\n        return invoice.total or 0\n"
                                  "\n    def refund(self, invoice):\n        return -invoice.total\n",
        "docs/wiki/notes/todo.txt": "later, maybe\n",
    })
    git(repo, "checkout", "-q", "-b", "feature")
    _commit(repo, "Billing: format invoice totals", {"src/billing/format.py": "def money(c):\n    return c / 100\n"})
    git(repo, "checkout", "-q", "main")
    last_wiki = _commit(repo, "Wiki note only", {"docs/wiki/notes/todo.txt": "later\n"})
    git(repo, "merge", "-q", "--no-ff", "--no-edit", "feature", env=_dated())
    _commit(repo, "Reword README", {"README.md": "# Shop service\n"})
    return repo, wiki_commit, last_wiki


def _hub_fixture(base: Path) -> tuple[Path, str]:
    hub = _repo(base / "hub", {"README.md": "# Hub\n"})
    api = _repo(hub / "api", {"src/app.py": "def handle(request):\n    return authorize(request)\n",
                              "src/auth.py": "def authorize(request):\n    return request.token\n"})
    worker = _repo(hub / "worker", {"jobs/run.py": "def run(job):\n    return job.execute()\n"})
    before = _commit(worker, "Worker: already documented change", {"jobs/retry.py": "LIMIT = 5\n"})
    ws = _config.init(hub, hub_sources=["api", "worker"])
    _page.new_page(ws, "modules/api.md", "Module", "Read before changing request handling or token authorization.",
                   ["api/src/**"])
    _page.new_page(ws, "modules/worker.md", "Module", "Read before changing job execution or job retries.",
                   ["worker/jobs/**"])
    _stamp_wiki(ws, {
        "architecture.md": "## Boundaries and dependencies\n\napi enqueues jobs for worker.[^handle]\n\n"
                           "## Not covered\n\n| Path | Reason |\n|---|---|\n\n[^handle]: api/src/app.py#L1-L2\n",
        "glossary.md": "| Term | Meaning | Avoid | Where |\n|---|---|---|---|\n"
                       "| Handle | Request entry point. | | `handle`[^h] |\n\n[^h]: api/src/app.py#L1\n",
        "conventions.md": _CONVENTIONS,
        "modules/api.md": "## Responsibility and boundaries\n\nRequests are authorized first.[^auth]\n\n"
                          "[^auth]: api/src/auth.py#L1-L2\n",
        "modules/worker.md": "## Responsibility and boundaries\n\nJobs execute in the worker.[^run]\n\n"
                             "[^run]: worker/jobs/run.py#L1-L2\n",
    })
    _commit(hub, "wiki v1")
    _commit(api, "API: validate token authorization", {"src/auth.py": "def authorize(request):\n    return bool(request.token)\n"})
    _commit(worker, "Worker: retry failed jobs with backoff", {"jobs/retry.py": "LIMIT = 5\nBACKOFF = 2\n"})
    _commit(hub, "wiki: note", {"docs/wiki/notes/todo.txt": "later\n"})
    return hub, before


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise EvalError(f"selftest: {message}")


def _run(argv: list[str]) -> None:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        code = main(argv)
    _check(code == 0, f"{' '.join(argv)} exited {code}")


def selftest(base: Path) -> dict:
    out = {}
    # Single repository.
    repo, wiki_commit, last_wiki = _single_fixture(base)
    r = ["--repo", str(repo)]
    tasks_file, packets, answers = base / "tasks.json", base / "packets.jsonl", base / "answers.jsonl"
    _run(["tasks", *r, "--since", wiki_commit, "--out", str(tasks_file)])
    tasks = load_tasks(str(tasks_file))
    subjects = [t["task"].splitlines()[0] for t in tasks]
    _check(subjects == [
        "Raise billing retry cap to five attempts", "Payments client: support refunds",
        "Post invoices and charge the payment client", "Billing: format invoice totals", "Reword README",
    ], f"task subjects {subjects}")
    _check(tasks[0]["task"].endswith("Gateway timeouts need more retries."), "commit body missing from task")
    _check(len(tasks[2]["task"]) <= MAX_TASK_CHARS and tasks[2]["task"].endswith("..."), "long task not truncated")
    _check(tasks[2]["files"] == ["src/billing/run.py", "src/payments/client.py"], f"wiki file leaked: {tasks[2]['files']}")
    _run(["tasks", *r, "--out", str(base / "default.json")])
    default = load_tasks(str(base / "default.json"))
    _check([t["task"].splitlines()[0] for t in default] == ["Billing: format invoice totals", "Reword README"],
           f"default --since: {[t['task'][:40] for t in default]}")
    _check(json.loads((base / "default.json").read_text(encoding="utf-8"))["since"] == {".": last_wiki}, "default since")
    _run(["tasks", *r, "--since", wiki_commit, "--limit", "2", "--out", str(base / "limit.json")])
    _check(len(load_tasks(str(base / "limit.json"))) == 2, "--limit ignored")

    _run(["packet", *r, "--tasks", str(tasks_file), "--out", str(packets)])
    lines = [json.loads(line) for line in packets.read_text(encoding="utf-8").splitlines()]
    index = (repo / "docs/wiki/index.md").read_text(encoding="utf-8")
    _check(len(lines) == 5 and all(set(p) == {"id", "task", "index", "k"} for p in lines), "packet shape")
    _check(all(p["index"] == index and p["k"] == DEFAULT_K for p in lines), "packet index or k")
    _check(not any("src/billing/retry.py" in p["task"] or "files" in p for p in lines), "packet leaks the answer files")

    _run(["baseline", *r, "--tasks", str(tasks_file), "--out", str(answers)])
    ws = _config.load(repo)
    result = score(ws, tasks, load_answers(str(answers)), DEFAULT_K)
    by_subject = {s: row for s, row in zip(subjects, result["tasks"])}
    _check(by_subject["Raise billing retry cap to five attempts"]["pages"][0] == "modules/billing.md", "retry routing")
    _check(by_subject["Payments client: support refunds"]["pages"][0] == "modules/payments.md", "refund routing")
    _check(by_subject["Reword README"]["coverable"] == 0 and not by_subject["Reword README"]["hit"], "README is not coverable")
    _check(by_subject["Post invoices and charge the payment client"]["full"], "two-page task not fully covered")
    s = result["summary"]
    _check(s["tasks"] == 5 and s["files"] == 6 and s["coverable_file_rate"] == 5 / 6, f"summary {s}")
    _check(s["file_recall"] == 5 / 6 and s["hit_rate"] == 0.8 and s["full_coverage_rate"] == 0.8, f"baseline {s}")
    _check(s["oracle_file_recall"] == 5 / 6 and s["unknown_pages"] == 0, f"oracle {s}")

    # Scoring edge cases: prefixed paths, unknown pages, too many pages, missing answers.
    manual = base / "manual.jsonl"
    manual.write_text(_jsonl([
        {"id": tasks[0]["id"], "pages": ["docs/wiki/modules/billing.md#why"]},
        {"id": tasks[1]["id"], "pages": ["modules/nope.md", "glossary.md", "architecture.md", "modules/payments.md"]},
    ]), encoding="utf-8")
    edge = score(ws, tasks, load_answers(str(manual)), DEFAULT_K)
    rows = edge["tasks"]
    _check(rows[0]["full"] and rows[0]["pages"] == ["modules/billing.md"], f"prefixed page {rows[0]}")
    _check(rows[1]["unknown_pages"] == ["modules/nope.md"] and rows[1]["over_k"] == ["modules/payments.md"]
           and not rows[1]["hit"], f"unknown/over-k {rows[1]}")
    _check(edge["summary"]["answered"] == 2 and not rows[3]["hit"], "missing answers count as empty")
    cited = score(ws, tasks, {tasks[2]["id"]: ["architecture.md"]}, DEFAULT_K)["tasks"][2]
    _check(cited["covered"] == 1 and cited["uncovered"] == ["src/payments/client.py"], f"cited-file coverage {cited}")
    _run(["score", *r, "--tasks", str(tasks_file), "--answers", str(answers), "--json"])
    out["single"] = s

    # Hub: each source's own history, starting at the stamped revision.
    hub, before = _hub_fixture(base)
    h = ["--repo", str(hub)]
    hub_tasks = base / "hub-tasks.json"
    _run(["tasks", *h, "--out", str(hub_tasks)])
    tasks = load_tasks(str(hub_tasks))
    _check([t["files"] for t in tasks] == [["api/src/auth.py"], ["worker/jobs/retry.py"]], f"hub tasks {tasks}")
    _check(tasks[0]["id"].startswith("api@") and tasks[1]["id"].startswith("worker@"), "hub ids")
    _check(all(t["commit"] != before for t in tasks), "hub task from before the stamped revision")
    _run(["tasks", *h, "--since", f"worker={before}^", "--out", str(base / "hub-since.json")])
    _check(len(load_tasks(str(base / "hub-since.json"))) == 3, "hub --since override")
    _run(["baseline", *h, "--tasks", str(hub_tasks), "--out", str(base / "hub-answers.jsonl")])
    hub_score = score(_config.load(hub), tasks, load_answers(str(base / "hub-answers.jsonl")), DEFAULT_K)
    _check(hub_score["summary"]["full_coverage_rate"] == 1.0, f"hub baseline {hub_score}")
    with contextlib.redirect_stderr(io.StringIO()):
        _check(main(["tasks", *h, "--since", "nope=HEAD"]) == 2, "bad hub --since accepted")
    out["hub"] = hub_score["summary"]
    return out


def cmd_selftest(args) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        result = selftest(Path(tmp))
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"eval_routing selftest: ok (single file recall {result['single']['file_recall']:.2f}, "
              f"hub full coverage {result['hub']['full_coverage_rate']:.2f})")
    return 0


# --- entry point -----------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    where = argparse.ArgumentParser(add_help=False)
    where.add_argument("--repo", default=".", help="repository or hub root (default: current directory)")
    where.add_argument("--wiki", help="wiki directory, when several repo-wiki.yaml exist")

    tasks = commands.add_parser("tasks", parents=[where], help="derive tasks from commits after the wiki")
    tasks.add_argument("--since", action="append",
                       help="REV (single repository; default: last commit touching the wiki) or "
                            "SOURCE=REV in a hub (default: newest stable page revision); repeatable in a hub")
    tasks.add_argument("--limit", type=int, help="keep the first N tasks")
    tasks.add_argument("--max-chars", type=int, default=MAX_TASK_CHARS, help="truncate task text")
    tasks.add_argument("--out", help="write JSON here instead of stdout")
    tasks.set_defaults(func=cmd_tasks)

    for name, func, text in (
        ("packet", cmd_packet, "router packets (index + task) as JSONL"),
        ("baseline", cmd_baseline, "token-overlap router; answers as JSONL"),
    ):
        sub = commands.add_parser(name, parents=[where], help=text)
        sub.add_argument("--tasks", required=True, help="tasks JSON from the tasks subcommand")
        sub.add_argument("--k", type=int, default=DEFAULT_K, help="pages per task")
        sub.add_argument("--out", help="write JSONL here instead of stdout")
        sub.set_defaults(func=func)

    sc = commands.add_parser("score", parents=[where], help="score answers against tasks")
    sc.add_argument("--tasks", required=True)
    sc.add_argument("--answers", required=True, help="JSONL {id, pages}")
    sc.add_argument("--k", type=int, default=DEFAULT_K, help="pages counted per task; extra pages are ignored")
    sc.add_argument("--json", action="store_true")
    sc.set_defaults(func=cmd_score)

    st = commands.add_parser("selftest", help="build fixtures and check tasks -> baseline -> score")
    st.add_argument("--json", action="store_true")
    st.set_defaults(func=cmd_selftest)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, "k", 1) < 1 or (getattr(args, "limit", None) or 1) < 1:
        print("eval_routing: --k and --limit must be at least 1", file=sys.stderr)
        return 2
    try:
        return args.func(args)
    except (EvalError, _config.ConfigError) as exc:
        print(f"eval_routing: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
