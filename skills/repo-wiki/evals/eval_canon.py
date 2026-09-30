#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-2 terminology and convention recall against a hand-curated gold file.

    eval_canon.py score --gold gold.yaml [--root R] [--wiki W] [--run-commands] [--json]
    eval_canon.py selftest

Gold file (YAML, one per fixture):

    terms:    [{term: Billing run, aliases: [invoice job]}]
    rules:    [{area: testing, keywords: [tests/, test_]}]
    commands: [{purpose: Unit tests, command: python -m pytest -q}]

Recall: a gold term is found when the term or one of its aliases equals a
Glossary Term or Avoid entry (case-insensitive, normalized); a gold rule when a
Conventions rules row has the same Area and its Rule cell contains every
keyword; a gold command when a commands row has the same normalized command.
Signals: glossary terms not in the gold file, rules enforced by `convention`
that name fewer than two instances, and commands marked verified.
--run-commands runs every verified command in a throwaway detached `git
worktree` at the source HEAD (reset and cleaned between commands, removed
afterwards), from the directory okf scan records as the command's `cwd`,
re-derived from the file its first citation names (a command cited at
web/package.json runs in web/; `uv run evals/run_e2e.py` cited at that script
runs at the source root), and reports which still pass.
"""

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import _config
import _git
import _page
import _scan
import _validate

DEFAULT_TIMEOUT = 600
OUTPUT_TAIL = 20
_INSTANCES = re.compile(
    r"(\d+)\s*(?:instances?|places?|occurrences?|call\s*sites?|sites?|files?|modules?|uses?|处|个实例|个位置|个文件)",
    re.IGNORECASE,
)
_PAREN = re.compile(r"\s*[(（]([^)）]*)[)）]\s*")


class EvalError(Exception):
    """User-facing; the message names the fix."""


# --- normalization ----------------------------------------------------------------


def norm_text(text: str) -> str:
    """Case-folded, NFKC, backticks and footnotes dropped, - and _ as spaces."""
    text = unicodedata.normalize("NFKC", _validate._plain(str(text)))
    text = re.sub(r"[-_\s]+", " ", text.casefold())
    return text.strip(" .,;:，。；：")


def norm_command(text: str) -> str:
    """Command text as written: backticks, footnotes, a leading '$ ' and extra spaces dropped."""
    text = unicodedata.normalize("NFKC", _validate._plain(str(text)))
    text = re.sub(r"^\$\s+", "", text.strip())
    return " ".join(text.split())


def term_forms(cell: str) -> set[str]:
    """A Term cell and its parenthesized short form: 'Billing run (BR)' -> both."""
    plain = _validate._plain(cell)
    forms = {norm_text(plain)}
    inner = _PAREN.findall(plain)
    if inner:
        forms.add(norm_text(_PAREN.sub(" ", plain)))
        forms.update(norm_text(i) for i in inner)
    return {f for f in forms if f}


def split_aliases(cell: str) -> list[str]:
    plain = _validate._plain(cell).replace("，", ",").replace("、", ",").replace(";", ",")
    return [a.strip() for a in plain.split(",") if a.strip() and a.strip() not in ("-", "—")]


# --- gold -----------------------------------------------------------------------------


def _strings(value, where: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise EvalError(f"{where} must be a list of non-empty strings")
    return value


def load_gold(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise EvalError(f"cannot read gold file {path}: {exc}") from None
    data = data or {}
    if not isinstance(data, dict):
        raise EvalError(f"{path} must be a mapping with terms, rules and commands")
    unknown = sorted(set(data) - {"terms", "rules", "commands"})
    if unknown:
        raise EvalError(f"{path}: unknown keys {', '.join(unknown)}; use terms, rules, commands")
    gold = {"terms": [], "rules": [], "commands": []}
    for index, item in enumerate(data.get("terms") or []):
        where = f"{path}: terms[{index}]"
        if isinstance(item, str):
            item = {"term": item}
        if not isinstance(item, dict) or not isinstance(item.get("term"), str) or not item["term"].strip():
            raise EvalError(f"{where} needs a term string")
        gold["terms"].append({"term": item["term"], "aliases": _strings(item.get("aliases"), f"{where}.aliases")})
    for index, item in enumerate(data.get("rules") or []):
        where = f"{path}: rules[{index}]"
        if not isinstance(item, dict) or item.get("area") not in _page.RULE_AREAS:
            raise EvalError(f"{where} needs an area, one of {', '.join(_page.RULE_AREAS)}")
        keywords = _strings(item.get("keywords"), f"{where}.keywords")
        if not keywords:
            raise EvalError(f"{where} needs at least one keyword")
        gold["rules"].append({"area": item["area"], "keywords": keywords})
    for index, item in enumerate(data.get("commands") or []):
        where = f"{path}: commands[{index}]"
        if not isinstance(item, dict) or not isinstance(item.get("command"), str) or not item["command"].strip():
            raise EvalError(f"{where} needs a command string")
        gold["commands"].append({"purpose": str(item.get("purpose") or ""), "command": item["command"]})
    return gold


# --- wiki canon ----------------------------------------------------------------------------


def _cells(row: _page.Row, width: int) -> list[str]:
    return list(row.cells) + [""] * max(0, width - len(row.cells))


def canon(ws: _config.Workspace) -> dict:
    """Glossary, rules and commands rows from the Glossary and Conventions pages."""
    found = {"glossary": [], "rules": [], "commands": [], "pages": {}}
    for page in _page.load_pages(ws):
        if page.error or page.type not in ("Glossary", "Conventions"):
            continue
        found["pages"][page.path] = page.status
        defs = page.structure.footnote_defs
        tables = _page.tables(page)

        def locators(row: _page.Row, defs=defs) -> list[str]:
            out = []
            for label in row.footnotes:
                token, _ = _config.definition_locator(defs.get(label, ("", 0))[0])
                if token and token not in out:
                    out.append(token)
            return out

        def where(row: _page.Row, page=page) -> str:
            return f"{page.path}:{row.line + page.body_offset}"

        if page.type == "Glossary":
            for table in tables.get("glossary", []):
                for row in table.rows:
                    cells = _cells(row, 4)
                    found["glossary"].append({
                        "term": _validate._plain(cells[0]),
                        "forms": sorted(term_forms(cells[0])),
                        "avoid": split_aliases(cells[2]),
                        "at": where(row),
                    })
        if page.type == "Conventions":
            for table in tables.get("rules", []):
                for row in table.rows:
                    cells = _cells(row, 3)
                    found["rules"].append({
                        "area": _validate._plain(cells[0]),
                        "rule": _validate._plain(cells[1]),
                        "enforced_by": _validate._plain(cells[2]),
                        "locators": locators(row),
                        "at": where(row),
                    })
            for table in tables.get("commands", []):
                for row in table.rows:
                    cells = _cells(row, 3)
                    found["commands"].append({
                        "purpose": _validate._plain(cells[0]),
                        "command": norm_command(cells[1]),
                        "status": _validate._plain(cells[2]),
                        "locators": locators(row),
                        "at": where(row),
                    })
    return found


def instances(rule: dict) -> int:
    """Instances a rule names: the largest count written in it, or its distinct citations."""
    counts = [int(m.group(1)) for m in _INSTANCES.finditer(rule["rule"])]
    return max(counts + [len(rule["locators"])])


# --- scoring --------------------------------------------------------------------------------


def _recall(found: int, total: int) -> float | None:
    return round(found / total, 4) if total else None


def score(ws: _config.Workspace, gold: dict) -> dict:
    wiki = canon(ws)
    terms = []
    matched_rows: set[int] = set()
    for item in gold["terms"]:
        wanted = {norm_text(item["term"])} | {norm_text(a) for a in item["aliases"]}
        wanted.discard("")
        hit = None
        for index, row in enumerate(wiki["glossary"]):
            if wanted & set(row["forms"]):
                hit, via = index, "term"
            elif wanted & {norm_text(a) for a in row["avoid"]}:
                hit, via = index, "avoid"
            else:
                continue
            break
        if hit is None:
            terms.append({"term": item["term"], "found": False})
        else:
            matched_rows.add(hit)
            row = wiki["glossary"][hit]
            terms.append({"term": item["term"], "found": True, "via": via, "wiki_term": row["term"], "at": row["at"]})

    rules = []
    for item in gold["rules"]:
        area = norm_text(item["area"])
        keywords = [norm_text(k) for k in item["keywords"]]
        hit = next(
            (r for r in wiki["rules"] if norm_text(r["area"]) == area and all(k in norm_text(r["rule"]) for k in keywords)),
            None,
        )
        rules.append({"area": item["area"], "keywords": item["keywords"], "found": hit is not None} | ({"at": hit["at"], "rule": hit["rule"]} if hit else {}))

    commands = []
    for item in gold["commands"]:
        wanted = norm_command(item["command"])
        hit = next((c for c in wiki["commands"] if c["command"] == wanted), None)
        commands.append({"purpose": item["purpose"], "command": wanted, "found": hit is not None} | ({"status": hit["status"], "at": hit["at"]} if hit else {}))

    gold_commands = {norm_command(c["command"]) for c in gold["commands"]}
    return {
        "wiki": ws.wiki_rel,
        "pages": wiki["pages"],
        "unstamped": sorted(p for p, status in wiki["pages"].items() if status != "stable"),
        "recall": {
            "terms": {"found": sum(t["found"] for t in terms), "gold": len(terms), "recall": _recall(sum(t["found"] for t in terms), len(terms))},
            "rules": {"found": sum(r["found"] for r in rules), "gold": len(rules), "recall": _recall(sum(r["found"] for r in rules), len(rules))},
            "commands": {"found": sum(c["found"] for c in commands), "gold": len(commands), "recall": _recall(sum(c["found"] for c in commands), len(commands))},
        },
        "terms": terms,
        "rules": rules,
        "commands": commands,
        "signals": {
            "glossary_rows": len(wiki["glossary"]),
            "extra_terms": [r["term"] for i, r in enumerate(wiki["glossary"]) if i not in matched_rows],
            "weak_convention_rules": [
                {"area": r["area"], "rule": r["rule"], "instances": instances(r), "at": r["at"]}
                for r in wiki["rules"] if r["enforced_by"] == "convention" and instances(r) < 2
            ],
            "verified_commands": [
                {"command": c["command"], "purpose": c["purpose"], "in_gold": c["command"] in gold_commands, "at": c["at"]}
                for c in wiki["commands"] if c["status"] == "verified"
            ],
            "extra_commands": [c["command"] for c in wiki["commands"] if c["command"] not in gold_commands],
        },
        "_commands": wiki["commands"],
    }


# --- running verified commands -----------------------------------------------------------------


def _source_for(ws: _config.Workspace, command: dict) -> tuple[_config.Source, str]:
    """The source a command belongs to and the source-relative directory it runs
    from, derived from the file its first valid locator names exactly as okf scan
    derives a command's ``cwd`` (``_scan.command_cwd``): the file's directory
    (web/package.json -> web), or the source root when the command names that file
    by its source-root path (``uv run evals/run_e2e.py``, a PEP 723 script). The
    source root when no locator resolves."""
    for text in command["locators"]:
        try:
            source, rel = _config.resolve(ws, _config.parse_locator(text).path)
        except _config.LocatorError:
            continue
        cwd = _scan.command_cwd(rel, command["command"])
        return source, "" if cwd == "." else cwd
    return ws.sources[0], ""


def _tail(text: str) -> str:
    return "\n".join(text.splitlines()[-OUTPUT_TAIL:])


def _git_quiet(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def run_commands(ws: _config.Workspace, commands: list[dict], timeout: float) -> list[dict]:
    """Run each verified command in a detached worktree of its source at HEAD."""
    results = []
    worktrees: dict[str, tuple[_config.Source, Path, str]] = {}
    with tempfile.TemporaryDirectory(prefix="okf-canon-") as tmp:
        try:
            for command in commands:
                source, directory = _source_for(ws, command)
                if source.name not in worktrees:
                    rev = _git.head(source.path)
                    tree = Path(tmp) / f"wt-{len(worktrees)}"
                    _git_quiet(source.path, "worktree", "add", "--detach", "-q", str(tree), rev)
                    worktrees[source.name] = (source, tree, rev)
                _, tree, rev = worktrees[source.name]
                cwd = tree / directory if directory else tree
                started = time.monotonic()
                result = {"command": command["command"], "source": source.name, "rev": rev, "cwd": directory or "."}
                if not cwd.is_dir():
                    results.append(result | {"status": "fail", "returncode": None, "seconds": 0.0,
                                             "output": f"directory {directory} does not exist at {rev[:12]}"})
                    continue
                try:
                    done = subprocess.run(
                        command["command"], shell=True, cwd=cwd, capture_output=True, text=True,
                        errors="replace", timeout=timeout, env=os.environ.copy(), stdin=subprocess.DEVNULL, check=False,
                    )
                    result |= {
                        "status": "pass" if done.returncode == 0 else "fail",
                        "returncode": done.returncode,
                        "output": _tail(done.stdout + done.stderr),
                    }
                except subprocess.TimeoutExpired as exc:
                    output = (exc.stdout or b"") + (exc.stderr or b"")
                    if isinstance(output, bytes):
                        output = output.decode("utf-8", errors="replace")
                    result |= {"status": "timeout", "returncode": None, "output": _tail(output)}
                result["seconds"] = round(time.monotonic() - started, 2)
                results.append(result)
                _git_quiet(tree, "reset", "-q", "--hard", rev)
                _git_quiet(tree, "clean", "-qfdx")
        finally:
            for source, tree, _ in worktrees.values():
                subprocess.run(["git", "-C", str(source.path), "worktree", "remove", "--force", str(tree)], capture_output=True, check=False)
                subprocess.run(["git", "-C", str(source.path), "worktree", "prune"], capture_output=True, check=False)
    return results


# --- output ----------------------------------------------------------------------------------------


def _pct(value) -> str:
    return "-" if value is None else f"{value:.1%}"


def print_report(report: dict) -> None:
    print(f"canon recall ({report['wiki']})")
    print(f"  {'kind':<10} {'found':>5} {'gold':>5} {'recall':>8}")
    for kind, r in report["recall"].items():
        print(f"  {kind:<10} {r['found']:>5} {r['gold']:>5} {_pct(r['recall']):>8}")
    missing = [t["term"] for t in report["terms"] if not t["found"]]
    if missing:
        print(f"missing terms: {', '.join(missing)}")
    via_avoid = [f"{t['term']} (wiki says {t['wiki_term']})" for t in report["terms"] if t.get("via") == "avoid"]
    if via_avoid:
        print(f"terms found only as an Avoid alias: {', '.join(via_avoid)}")
    for r in report["rules"]:
        if not r["found"]:
            print(f"missing rule: [{r['area']}] {', '.join(r['keywords'])}")
    for c in report["commands"]:
        if not c["found"]:
            print(f"missing command: {c['command']}")
    s = report["signals"]
    print("signals:")
    print(f"  glossary terms not in gold ({len(s['extra_terms'])}): {', '.join(s['extra_terms']) or '-'}")
    print(f"  convention rules naming < 2 instances ({len(s['weak_convention_rules'])}):")
    for r in s["weak_convention_rules"]:
        print(f"    {r['at']} [{r['area']}] {r['rule'][:90]}")
    print(f"  verified commands ({len(s['verified_commands'])}): {', '.join(c['command'] for c in s['verified_commands']) or '-'}")
    if report["unstamped"]:
        print(f"warning: not stable (unstamped) pages: {', '.join(report['unstamped'])}")
    if "runs" in report:
        print("verified command runs:")
        for run in report["runs"]:
            print(f"  {run['status'].upper():<7} {run['command']}  ({run['seconds']}s, {run['source']}@{run['rev'][:12]})")
            if run["status"] != "pass" and run["output"]:
                for line in run["output"].splitlines()[-5:]:
                    print(f"          {line}")


def evaluate(root: str, wiki: str | None, gold_path: str, run: bool, timeout: float) -> dict:
    try:
        ws = _config.load(Path(root), wiki)
    except _config.ConfigError as exc:
        raise EvalError(str(exc)) from None
    report = score(ws, load_gold(Path(gold_path)))
    commands = report.pop("_commands")
    if run:
        verified = [c for c in commands if c["status"] == "verified" and c["command"]]
        report["runs"] = run_commands(ws, verified, timeout)
        report["runs_passed"] = sum(r["status"] == "pass" for r in report["runs"])
    return report


def cmd_score(args) -> int:
    report = evaluate(args.root, args.wiki, args.gold, args.run_commands, args.timeout)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_report(report)
    return 0


# --- selftest -----------------------------------------------------------------------------------------

_SELF_FILES = {
    "Makefile": "test:\n\tsh check.sh\n\nlint:\n\tsh lint.sh\n",
    "check.sh": "test -f src/billing/run.py && echo built > out.txt && echo ok\n",
    "lint.sh": "echo 'lint failed' >&2\nexit 3\n",
    "src/billing/run.py": "class BillingRun:\n    def post(self, invoice):\n        invoice.posted = True\n",
    "src/billing/retry.py": "MAX = 3\n",
    "src/billing/errors.py": "class BillingError(Exception):\n    pass\n",
    "src/billing/api.py": "from .errors import BillingError\n\n\ndef charge():\n    raise BillingError()\n",
    "tests/test_run.py": "def test_run():\n    assert True\n",
}

_SELF_ARCH = """## Structure

Billing has no dependencies.

## Not covered

| Path | Reason |
|---|---|
| `tests/` | Test code. |
"""

_SELF_GLOSSARY = """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run (BR) | Pass that posts invoices. | invoice job | `BillingRun`[^run] |
| Charge cap | Most charge attempts. | retry-limit | `MAX`[^cap] |
| Posting | Marks an invoice posted. | - | `post`[^run] |

[^run]: src/billing/run.py#L1-L3
[^cap]: src/billing/retry.py#L1
"""

_SELF_CONVENTIONS = """## Commands

| Purpose | Command | Status |
|---|---|---|
| Tests | `sh check.sh`[^test] | verified |
| Lint | `sh lint.sh`[^lint] | verified |
| Format | `black .`[^test] | not-run |

## Rules

| Area | Rule | Enforced by |
|---|---|---|
| testing | Tests live in `tests/` as `test_*.py`.[^test] | convention |
| errors | Service code raises `BillingError` subclasses (2 instances).[^err] | convention |
| build-ci | Lint runs through `lint.sh`.[^lint] | ci |

[^test]: Makefile#L1-L2
[^lint]: Makefile#L4-L5
[^err]: src/billing/api.py#L1-L5
"""

_SELF_MODULE = """## Responsibility

Billing posts invoices.

## How it works

`post` marks the invoice.[^run]

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Posting | `post`[^run] | - | `sh check.sh` |

[^run]: src/billing/run.py#L1-L3
"""

SELF_GOLD = """terms:
  - term: Billing run
    aliases: [BR]
  - term: Retry limit
  - term: Ledger
rules:
  - area: testing
    keywords: [tests/, test_]
  - area: errors
    keywords: [BillingError]
  - area: naming
    keywords: [snake_case]
commands:
  - purpose: Tests
    command: "`sh  check.sh`"
  - purpose: Lint
    command: sh lint.sh
  - purpose: Types
    command: mypy .
"""


def _git_run(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def _commit(repo: Path, files: dict[str, str], message: str) -> None:
    for rel, text in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
    _git_run(repo, "add", "-A")
    _git_run(repo, "commit", "-q", "--allow-empty", "-m", message)


def fixture(base: Path) -> tuple[Path, Path]:
    """A repository with a stamped wiki and its gold file."""
    import _stamp

    repo = base / "repo"
    repo.mkdir(parents=True)
    _git_run(repo, "init", "-q", "-b", "main")
    for key, value in (("user.name", "Eval"), ("user.email", "eval@example.com"), ("commit.gpgsign", "false")):
        _git_run(repo, "config", key, value)
    _commit(repo, _SELF_FILES, "init")
    ws = _config.init(repo)
    _page.new_page(ws, "Module", "billing", "Read before changing billing.", ["src/billing/**"])
    for path, body in (
        ("architecture.md", _SELF_ARCH),
        ("glossary.md", _SELF_GLOSSARY),
        ("conventions.md", _SELF_CONVENTIONS),
        ("modules/billing.md", _SELF_MODULE),
    ):
        page = _page.load_page(ws, path)
        page.body = body
        _page.write_page(page)
    result = _stamp.stamp(ws, "repo-wiki/eval", unreviewed=True)
    if result["blocked"]:
        raise AssertionError(f"fixture stamp blocked: {json.dumps(result['blocked'], indent=2)}")
    _commit(repo, {}, "wiki")
    gold = base / "gold.yaml"
    gold.write_text(SELF_GOLD, encoding="utf-8", newline="\n")
    return repo, gold


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def selftest(base: Path) -> None:
    repo, gold = fixture(base)
    report = evaluate(str(repo), None, str(gold), run=True, timeout=60)
    recall = report["recall"]
    _check(report["unstamped"] == [], f"unstamped {report['unstamped']}")
    # Billing run via Term, Retry limit via Avoid 'retry-limit', Ledger missing.
    _check(recall["terms"] == {"found": 2, "gold": 3, "recall": 0.6667}, f"terms {recall['terms']}")
    via = {t["term"]: t.get("via") for t in report["terms"]}
    _check(via == {"Billing run": "term", "Retry limit": "avoid", "Ledger": None}, f"via {via}")
    _check(recall["rules"] == {"found": 2, "gold": 3, "recall": 0.6667}, f"rules {recall['rules']}")
    _check(recall["commands"] == {"found": 2, "gold": 3, "recall": 0.6667}, f"commands {recall['commands']}")
    signals = report["signals"]
    _check(signals["extra_terms"] == ["Posting"], f"extra terms {signals['extra_terms']}")
    weak = [r["rule"] for r in signals["weak_convention_rules"]]
    _check(weak == ["Tests live in tests/ as test_*.py."], f"weak rules {weak}")
    verified = [c["command"] for c in signals["verified_commands"]]
    _check(verified == ["sh check.sh", "sh lint.sh"], f"verified {verified}")
    _check(signals["extra_commands"] == ["black ."], f"extra commands {signals['extra_commands']}")
    runs = {r["command"]: r for r in report["runs"]}
    _check(runs["sh check.sh"]["status"] == "pass" and "ok" in runs["sh check.sh"]["output"], f"runs {runs}")
    _check(runs["sh lint.sh"]["status"] == "fail" and runs["sh lint.sh"]["returncode"] == 3, f"runs {runs}")
    _check(report["runs_passed"] == 1, f"runs passed {report['runs_passed']}")
    # The repository stays clean and no worktree is left behind.
    _check(_git_run(repo, "status", "--porcelain") == "" and not (repo / "out.txt").exists(), "repository changed")
    _check(len(_git_run(repo, "worktree", "list").splitlines()) == 1, "worktree left behind")
    with contextlib.redirect_stdout(io.StringIO()) as printed:
        code = main(["score", "--root", str(repo), "--gold", str(gold), "--json"])
    _check(code == 0 and json.loads(printed.getvalue())["recall"] == recall, "score cli failed")


def cmd_selftest(args) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            selftest(Path(tmp))
        except AssertionError as exc:
            print(f"FAIL: {exc}")
            return 1
    print("eval_canon selftest: ok")
    return 0


# --- cli ------------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval_canon.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("score", help="term, rule and command recall of the wiki canon")
    s.add_argument("--gold", required=True, help="gold YAML with terms, rules and commands")
    s.add_argument("--root", default=".", help="repository or hub root (default: current directory)")
    s.add_argument("--wiki", help="wiki directory (default: found via repo-wiki.yaml)")
    s.add_argument("--run-commands", action="store_true", help="run verified commands in a throwaway worktree")
    s.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="seconds per command")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_score)
    s = sub.add_parser("selftest", help="fixture repo + stamped wiki + gold -> score with assertions")
    s.set_defaults(func=cmd_selftest)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.func(args)
    except (EvalError, _git.GitError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
