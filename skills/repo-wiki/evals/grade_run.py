#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Deterministic grader for a finished repo-wiki run.

Checks environment state, not transcripts (outcome-based verification).
Usage: grade_run.py <workspace> [--json]
Exit 0 = all assertions pass.
"""

import json
import pathlib
import random
import re
import subprocess
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
CITE_RE = re.compile(r"([\w./-]+\.\w+)#L(\d+)(?:-L?(\d+))?")
PAGE_BUDGET = (4, 12)
SAMPLED_CITATIONS = 12


def grade(ws: pathlib.Path) -> list[dict]:
    results = []

    def check(name: str, passed: bool, evidence: str):
        results.append({"text": name, "passed": bool(passed), "evidence": evidence})

    state_file = ws / ".okf-wiki" / "state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    phases = state.get("phases", {})
    all_targets = [(ph, t, v) for ph, pd in phases.items()
                   for t, v in pd.get("targets", {}).items()]
    incomplete = [(ph, t) for ph, t, v in all_targets if v["status"] != "complete"]
    check("run reached publish with every target complete",
          state.get("phase") == "publish" and all_targets and not incomplete,
          f"phase={state.get('phase')}, incomplete={incomplete[:5]}")

    check("phase timestamps recorded",
          all("started_at" in pd for pd in phases.values() if pd.get("targets")),
          "started_at on all active phases")

    wiki = ws / "wiki"
    pages = sorted(p for p in wiki.rglob("*.md")) if wiki.exists() else []
    content_pages = [p for p in pages if p.name != "index.md"]
    check(f"published page count within {PAGE_BUDGET} (thin-wiki budget)",
          PAGE_BUDGET[0] <= len(content_pages) <= PAGE_BUDGET[1],
          f"{len(content_pages)} content pages: {[str(p.relative_to(wiki)) for p in content_pages]}")

    proc = subprocess.run(
        ["uv", "run", str(SKILL / "scripts" / "okf.py"), "validate", "--json"],
        cwd=ws, capture_output=True, text=True)
    try:
        vjson = json.loads(proc.stdout)
        errors = vjson.get("errors", -1)
    except json.JSONDecodeError:
        errors = -1
    check("validate reports 0 errors on published candidate",
          errors == 0, f"errors={errors}")

    # Anti-fabrication: sampled cited line ranges must exist in pinned sources.
    # Resolve source-name prefixes through workspace.json (link sources live
    # outside the workspace directory).
    ws_cfg = json.loads((ws / ".okf-wiki" / "workspace.json").read_text())
    source_roots = {s["name"]: pathlib.Path(s["target"]) for s in ws_cfg["sources"]}

    def resolve(res: str) -> pathlib.Path:
        head, _, rest = res.partition("/")
        if head in source_roots:
            return source_roots[head] / rest
        return ws / res

    citations = []
    for p in content_pages:
        for m in CITE_RE.finditer(p.read_text(encoding="utf-8")):
            citations.append((p, m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))))
    random.seed(0)
    sample = random.sample(citations, min(SAMPLED_CITATIONS, len(citations)))
    bad = []
    for page, res, lo, hi in sample:
        f = resolve(res)
        if not f.exists():
            bad.append(f"{res} missing (cited in {page.name})")
            continue
        n = len(f.read_text(encoding="utf-8", errors="replace").splitlines())
        if not (1 <= lo <= hi <= n):
            bad.append(f"{res}#L{lo}-{hi} out of range (file has {n} lines)")
    check(f"sampled citations resolve ({len(sample)}/{len(citations)} checked)",
          bool(citations) and not bad, "; ".join(bad) or "all sampled ranges exist")

    props = sorted((ws / ".okf-wiki" / "proposals").glob("agents-block*.md"))
    n_sources = len(json.loads((ws / ".okf-wiki" / "workspace.json").read_text())["sources"])
    block_ok = []
    for p in props:
        text = p.read_text(encoding="utf-8")
        inner = re.search(r"<!-- okf-wiki:begin[^>]*-->\n(.*?)<!-- okf-wiki:end -->",
                          text, re.DOTALL)
        lines = len([l for l in inner.group(1).splitlines() if l.strip()]) if inner else 99
        block_ok.append(inner is not None and lines <= 15)
    check("one AGENTS proposal per source, markers paired, <=15 lines",
          len(props) == n_sources and all(block_ok),
          f"{len(props)} proposals for {n_sources} sources")

    missing_desc = []
    for p in content_pages:
        head = p.read_text(encoding="utf-8")[:800]
        m = re.search(r'^description:\s*"?(.+?)"?\s*$', head, re.MULTILINE)
        if not m or not m.group(1).strip():
            missing_desc.append(p.name)
    check("every page has non-empty routing description",
          content_pages and not missing_desc, ", ".join(missing_desc) or "all present")

    return results


def main() -> int:
    ws = pathlib.Path(sys.argv[1]).resolve()
    results = grade(ws)
    as_json = "--json" in sys.argv
    if as_json:
        print(json.dumps({"passed": all(r["passed"] for r in results),
                          "expectations": results}, ensure_ascii=False, indent=2))
    else:
        for r in results:
            mark = "PASS" if r["passed"] else "FAIL"
            print(f"[{mark}] {r['text']}\n       {r['evidence']}")
        n_pass = sum(r["passed"] for r in results)
        print(f"{n_pass}/{len(results)} assertions passed")
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
