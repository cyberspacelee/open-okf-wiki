#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-2 knowledge recall: what did the wiki miss that a human expert expects?

An answer key, written by someone who knows the repository, names the
knowledge a wiki must hold; the score is the share the wiki actually holds.
Validation checks that what the wiki says is grounded; this checks what it
leaves out, the failure a shallow discovery or a brief-only writer produces.

Key (YAML), every section optional:

  workflows:                 # a Workflow or Flow page scopes every trigger and reaches every `through` file
    - name: order checkout
      triggers: [src/order/web/OrderController.java]
      through: [src/payment/PaymentListener.java]
  invariants:                # some page cites lines overlapping the locator
    - name: order and outbox share one transaction
      locator: src/order/OrderService.java#L77-L95
  terms: [Settlement window]  # a glossary row names it (Term or Avoid)
  boundaries:                # an Architecture or Overview page cites a file in each module
    - {from: src/order, to: src/payment}

Subcommands (run from the repository or hub root, or pass --repo):

  score     recall per section and overall, with every miss named
  selftest  build a fixture repository and wiki and check the scoring
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import _config
import _page
import _validate

SECTIONS = ("workflows", "invariants", "terms", "boundaries")


class EvalError(Exception):
    """User-facing; the message names the fix."""


# --- scoring ---------------------------------------------------------------------------------


def load_key(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise EvalError(f"cannot read the key {path}: {exc}") from None
    if not isinstance(data, dict) or set(data) - set(SECTIONS):
        raise EvalError(f"the key must be a mapping with sections {', '.join(SECTIONS)}")
    return {section: data.get(section) or [] for section in SECTIONS}


def score(ws: _config.Workspace, key: dict) -> dict:
    pages = [p for p in _page.load_pages(ws) if not p.error and not p.is_generated]
    facts = _validate.Facts(ws)
    cited = {p.path: [loc for _, loc, _ in _validate.cited_locators(p)] for p in pages}

    def scoped(page, path: str) -> bool:
        return any(path in facts.matches(glob) for glob in _validate.scope_globs(page))

    results: dict[str, list[dict]] = {section: [] for section in SECTIONS}
    workflows = [p for p in pages if p.type in ("Workflow", "Flow")]
    for item in key["workflows"]:
        triggers, through = list(item.get("triggers") or []), list(item.get("through") or [])
        best = None
        for page in workflows:
            missing = [t for t in triggers if not scoped(page, t)]
            missing += [f for f in through if not scoped(page, f) and not any(c.path == f for c in cited[page.path])]
            if best is None or len(missing) < len(best[1]):
                best = (page.path, missing)
        page, missing = best or (None, triggers + through)
        results["workflows"].append({"name": item.get("name") or ", ".join(triggers), "hit": not missing,
                                     "page": page, "missing": missing})
    for item in key["invariants"]:
        want = _config.parse_locator(item["locator"])
        pages_hit = sorted(path for path, locs in cited.items() if any(_overlaps(loc, want) for loc in locs))
        results["invariants"].append({"name": item.get("name") or item["locator"], "hit": bool(pages_hit),
                                      "pages": pages_hit})
    names = _glossary_names(pages)
    for term in key["terms"]:
        results["terms"].append({"name": term, "hit": term.strip().lower() in names})
    # A boundary is drawn on the architecture page or, in a hub, on a source's overview.
    arch = [loc for page in pages if page.type in ("Architecture", "Overview") for loc in cited.get(page.path, [])]
    for item in key["boundaries"]:
        sides = [item["from"], item["to"]]
        missing = [side for side in sides if not any(_under(loc.path, side) for loc in arch)]
        results["boundaries"].append({"name": f"{item['from']} -> {item['to']}", "hit": not missing,
                                      "missing": missing})
    summary = {}
    for section, items in results.items():
        hits = sum(item["hit"] for item in items)
        summary[section] = {"hits": hits, "total": len(items),
                            "recall": round(hits / len(items), 3) if items else None}
    total = sum(s["total"] for s in summary.values())
    hits = sum(s["hits"] for s in summary.values())
    summary["overall"] = {"hits": hits, "total": total, "recall": round(hits / total, 3) if total else None}
    return {"summary": summary, "items": results}


def _overlaps(have: _config.Locator, want: _config.Locator) -> bool:
    if have.path != want.path:
        return False
    if have.start is None or want.start is None:
        return True
    return have.start <= want.end and want.start <= have.end


def _under(path: str, directory: str) -> bool:
    directory = directory.rstrip("/")
    return path == directory or path.startswith(directory + "/")


def _glossary_names(pages) -> set[str]:
    names = set()
    for page in pages:
        for table in _page.tables(page).get("glossary", []):
            for row in table.rows:
                cells = row.cells + ["", "", ""]
                names.add(_validate._plain(cells[0]).lower())
                names |= {a.strip().lower() for a in _validate._plain(cells[2]).split(",") if a.strip()}
    return names


# --- selftest ----------------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise EvalError(f"selftest: {message}")


def selftest(base: Path) -> dict:
    repo = base / "shop"
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.name", "Eval")
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "commit.gpgsign", "false")
    _write(repo, {
        "src/order/api.py": "@router.post('/orders')\ndef create():\n    save()\n    publish()\n",
        "src/order/service.py": "def save():\n    with tx():\n        insert_order()\n        insert_outbox()\n",
        "src/order/admin.py": "@router.get('/admin')\ndef admin():\n    pass\n",
        "src/payment/listener.py": "@app.agent(topic)\nasync def on(event):\n    charge(event)\n",
        "src/payment/charge.py": "def charge(event):\n    if event.paid:\n        raise ValueError('paid')\n",
    })
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    ws = _config.init(repo, create_canon=False)
    _page.new_page(ws, "Workflow", "checkout", "Read before changing checkout.",
                   ["src/order/api.py", "src/order/service.py"])
    page = ws.wiki / "workflows/checkout.md"
    head, _, _ = page.read_text(encoding="utf-8").partition("\n---\n")
    page.write_text(head + "\n---\n\n## Flow\n\nOrder and outbox rows share one "
                    "transaction.[^tx]\n\n[^tx]: src/order/service.py#L2-L4\n", encoding="utf-8")
    _write(ws.wiki, {
        "glossary.md": "---\ntype: Glossary\ntitle: Glossary\ndescription: Terms.\n---\n\n"
                       "| Term | Meaning | Avoid | Where |\n|---|---|---|---|\n"
                       "| Outbox | In order, rows published after commit. | event table | `x`[^o] |\n\n"
                       "[^o]: src/order/service.py#L4\n",
        "architecture.md": "---\ntype: Architecture\ntitle: Architecture\ndescription: Boundaries.\n---\n\n"
                           "Order publishes; payment consumes.[^a][^b]\n\n"
                           "[^a]: src/order/api.py#L4\n[^b]: src/payment/listener.py#L1\n",
    })
    key = {
        "workflows": [
            {"name": "checkout", "triggers": ["src/order/api.py"], "through": ["src/order/service.py"]},
            {"name": "payment capture", "triggers": ["src/payment/listener.py"], "through": ["src/payment/charge.py"]},
        ],
        "invariants": [
            {"name": "order and outbox in one transaction", "locator": "src/order/service.py#L3"},
            {"name": "paid events are rejected", "locator": "src/payment/charge.py#L2-L3"},
        ],
        "terms": ["Outbox", "event table", "Settlement"],
        "boundaries": [{"from": "src/order", "to": "src/payment"}, {"from": "src/order", "to": "src/billing"}],
    }
    key_file = base / "key.yaml"
    key_file.write_text(yaml.safe_dump(key), encoding="utf-8")
    result = score(ws, load_key(key_file))
    summary = result["summary"]
    _check(summary["workflows"] == {"hits": 1, "total": 2, "recall": 0.5}, f"workflows {summary['workflows']}")
    missed = result["items"]["workflows"][1]
    _check(missed["missing"] == ["src/payment/listener.py", "src/payment/charge.py"], f"missed workflow {missed}")
    _check(summary["invariants"] == {"hits": 1, "total": 2, "recall": 0.5}, f"invariants {summary['invariants']}")
    _check(result["items"]["invariants"][0]["pages"] == ["workflows/checkout.md"],
           f"invariant pages {result['items']['invariants'][0]}")
    _check(summary["terms"] == {"hits": 2, "total": 3, "recall": 0.667}, f"terms {summary['terms']}")
    _check(result["items"]["boundaries"][1]["missing"] == ["src/billing"], f"boundaries {result['items']['boundaries']}")
    _check(summary["overall"] == {"hits": 5, "total": 9, "recall": 0.556}, f"overall {summary['overall']}")
    return {"selftest": "ok", "summary": summary}


# --- CLI -----------------------------------------------------------------------------------------


def _report(result: dict) -> str:
    lines = []
    for section in (*SECTIONS, "overall"):
        s = result["summary"][section]
        if s["total"]:
            lines.append(f"{section:<11} {s['hits']}/{s['total']}  recall {s['recall']:.2f}")
    for section in SECTIONS:
        for item in result["items"][section]:
            if not item["hit"]:
                detail = f" (missing: {', '.join(item['missing'])})" if item.get("missing") else ""
                lines.append(f"miss {section[:-1]}: {item['name']}{detail}")
    return "\n".join(lines)


def cmd_score(args) -> int:
    ws = _config.load(Path(args.repo).resolve(), args.wiki)
    result = score(ws, load_key(Path(args.key)))
    print(json.dumps(result, indent=2, ensure_ascii=False) if args.json else _report(result))
    overall = result["summary"]["overall"]["recall"]
    return 1 if args.min is not None and (overall or 0) < args.min else 0


def cmd_selftest(args) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        result = selftest(Path(tmp))
    print(json.dumps(result, indent=2) if args.json else "eval_recall selftest: ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    subs = parser.add_subparsers(dest="command", required=True)
    sc = subs.add_parser("score", help="recall of the wiki against an answer key")
    sc.add_argument("--repo", default=".", help="repository or hub root (default: current directory)")
    sc.add_argument("--wiki", help="wiki directory, when several repo-wiki.yaml exist")
    sc.add_argument("--key", required=True, help="answer key (YAML)")
    sc.add_argument("--min", type=float, help="exit 1 when overall recall is below this")
    sc.add_argument("--json", action="store_true")
    sc.set_defaults(func=cmd_score)
    st = subs.add_parser("selftest", help="check the scoring on a fixture")
    st.add_argument("--json", action="store_true")
    st.set_defaults(func=cmd_selftest)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (EvalError, _config.ConfigError, _config.LocatorError) as exc:
        print(f"eval_recall: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
