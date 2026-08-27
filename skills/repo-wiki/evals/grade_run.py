#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Outcome-based grader for a published v4 repo-wiki run."""

import argparse
import json
import pathlib
import random
import re
import subprocess

SKILL = pathlib.Path(__file__).resolve().parent.parent
CITE = re.compile(
    r"okf-source://([A-Za-z0-9-]+)/([0-9a-f]{40,64})/([^\s#]+)#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?"
)


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def grade(ws: pathlib.Path) -> list[dict]:
    results = []

    def check(name: str, passed: bool, evidence: str) -> None:
        results.append({"text": name, "passed": bool(passed), "evidence": evidence})

    pointer = load(ws / ".okf-wiki/publication/current.json")
    bundle = ws / ".okf-wiki/publication/generations" / pointer["generation"]
    manifest = load(bundle / ".okf-manifest.json")
    run_id = manifest["producer_run_id"]
    run_dir = ws / ".okf-wiki/runs" / run_id
    state = load(run_dir / "state.json")
    incomplete = [
        key for key, value in state["tasks"].items() if value["status"] != "complete"
    ]
    check(
        "run published with all targets complete",
        state["status"] == "published" and not incomplete,
        f"status={state['status']}, incomplete={incomplete[:5]}",
    )
    attempts = state.get("review_attempts", [])
    check(
        "independent approved review recorded",
        bool(attempts)
        and attempts[-1]["verdict"] == "approved"
        and attempts[-1]["session"] != state["producer_session"],
        f"attempts={len(attempts)}",
    )

    pages = sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )
    check(
        "required routing concepts exist",
        (bundle / "overview.md").is_file() and (bundle / "architecture.md").is_file(),
        f"{len(pages)} concepts",
    )
    validation = subprocess.run(
        [
            "uv",
            "run",
            str(SKILL / "scripts/okf.py"),
            "validate",
            "--published",
            "--json",
        ],
        cwd=ws,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        errors = json.loads(validation.stdout)["errors"]
    except (json.JSONDecodeError, KeyError):
        errors = -1
    check("published validation has zero errors", errors == 0, f"errors={errors}")

    revisions = {item["name"]: item for item in state["revisions"]}
    workspace = load(ws / ".okf-wiki/workspace.json")
    source_paths = {
        item["name"]: ws.joinpath(*pathlib.PurePosixPath(item["path"]).parts)
        for item in workspace["sources"]
        if item["kind"] == "git"
    }
    citations = []
    for page in pages:
        citations.extend(
            (page, match) for match in CITE.finditer(page.read_text(encoding="utf-8"))
        )
    random.Random(0).shuffle(citations)
    bad = []
    for page, match in citations[:12]:
        source, commit, rel, lo, hi = match.groups()
        revision = revisions.get(source)
        source_path = source_paths.get(source)
        upper = int(hi or lo)
        content = subprocess.run(
            ["git", "-C", str(source_path), "show", f"{commit}:{rel}"],
            capture_output=True,
            text=True,
            check=False,
        ) if source_path else None
        if (
            not revision
            or revision.get("commit") != commit
            or content is None
            or content.returncode
        ):
            bad.append(f"{page.name}: unresolved {match.group(0)}")
            continue
        count = len(content.stdout.splitlines())
        if upper > count:
            bad.append(f"{page.name}: L{upper} exceeds {count}")
    check(
        "sampled revision citations resolve",
        bool(citations) and not bad,
        "; ".join(bad) or f"{min(12, len(citations))}/{len(citations)} checked",
    )

    proposals = sorted((run_dir / "proposals").glob("agents-block-*.md"))
    git_sources = state["revisions"]
    proposal_ok = all(
        text.count("<!-- okf-wiki:begin") == 1
        and text.count("<!-- okf-wiki:end -->") == 1
        for text in (path.read_text(encoding="utf-8") for path in proposals)
    )
    check(
        "one valid AGENTS proposal per Git source",
        len(proposals) == len(git_sources) and proposal_ok,
        f"{len(proposals)} proposals for {len(git_sources)} sources",
    )
    root_index = (bundle / "index.md").read_text(encoding="utf-8")
    log = (bundle / "log.md").read_text(encoding="utf-8")
    check(
        "OKF reserved files conform",
        root_index.startswith('---\nokf_version: "0.2"\n---\n')
        and "type: Index" not in root_index
        and re.search(r"^## \d{4}-\d{2}-\d{2}$", log, re.MULTILINE),
        "root index and log inspected",
    )
    trust_missing = [
        path.name
        for path in pages
        if not all(
            token in path.read_text(encoding="utf-8")
            for token in (
                "generated:",
                "verified:",
                "status: stable",
                "stale_after:",
            )
        )
    ]
    check(
        "published concepts carry lifecycle trust fields",
        not trust_missing,
        ", ".join(trust_missing) or "all concepts stamped",
    )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=pathlib.Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        results = grade(args.workspace.resolve())
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        results = [
            {
                "text": "run produced a readable publication",
                "passed": False,
                "evidence": str(exc),
            }
        ]
    passed = all(item["passed"] for item in results)
    if args.json:
        print(
            json.dumps(
                {"passed": passed, "expectations": results},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in results:
            print(
                f"[{'PASS' if item['passed'] else 'FAIL'}] {item['text']}: {item['evidence']}"
            )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
