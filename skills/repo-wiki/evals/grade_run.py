#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Outcome grader for a published ready-page DAG run."""

import argparse
import json
import pathlib
import random
import re
import subprocess

SKILL = pathlib.Path(__file__).resolve().parent.parent
CITE = re.compile(
    r"^\s*resource:\s*\"?([A-Za-z0-9][A-Za-z0-9-]*/[^\s#\"]+)"
    r"(?:#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?)?\"?\s*$",
    re.MULTILINE,
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
    targets = state.get("targets", {})
    incomplete = [
        key for key, value in targets.items() if value["status"] != "complete"
    ]
    check(
        "run published with every DAG target complete",
        state["status"] == "published" and not incomplete,
        f"status={state['status']}, incomplete={incomplete[:5]}",
    )
    legacy = [
        target["id"]
        for target in targets.values()
        if target.get("kind") not in {"plan", "page", "review"}
    ]
    check(
        "target graph contains no legacy phases",
        not legacy and "tasks" not in state,
        f"legacy={legacy[:5]}",
    )

    plans = [target for target in targets.values() if target["kind"] == "plan"]
    pages = [target for target in targets.values() if target["kind"] == "page"]
    reviews = [target for target in targets.values() if target["kind"] == "review"]
    plan = None
    if len(plans) == 1:
        try:
            plan_path = run_dir / plans[0]["artifact"]
            plan = load(plan_path)
        except (OSError, json.JSONDecodeError):
            plan = None
    planned = {item["path"]: item for item in (plan or {}).get("pages", [])}
    check(
        "page and review target counts come from the Page Plan",
        bool(planned)
        and {target["name"] for target in pages} == set(planned)
        and {target["name"] for target in reviews} == set(planned),
        f"planned={len(planned)}, pages={len(pages)}, reviews={len(reviews)}",
    )
    dependency_errors = []
    review_by_page = {target["name"]: target for target in reviews}
    for path, entry in planned.items():
        for child in entry.get("depends_on", []):
            if review_by_page.get(child, {}).get("status") != "complete":
                dependency_errors.append(f"{path}: child {child} not Machine-confirmed")
    check(
        "parent pages depend on Machine-confirmed children",
        not dependency_errors,
        "; ".join(dependency_errors[:5]) or "all dependency reviews complete",
    )

    revision_names = {item["name"] for item in state["revisions"]}
    indexes = sorted((run_dir / "drafts/index").glob("*.md"))
    bad_indexes = []
    for path in indexes:
        text = path.read_text(encoding="utf-8")
        if (
            path.stat().st_size > 64 * 1024
            or "inventory complete" not in text
            or "## Repository outline" not in text
            or "Stats columns" in text
        ):
            bad_indexes.append(path.name)
    check(
        "each Revision has one bounded agent-facing outline",
        len(indexes) == len(revision_names) and not bad_indexes,
        f"revisions={len(revision_names)}, indexes={len(indexes)}, bad={bad_indexes}",
    )

    manifest_pages = manifest.get("pages", {})
    page_by_name = {target["name"]: target for target in pages}
    digest_errors = [
        path
        for path, item in manifest_pages.items()
        if not item.get("output_digest")
        or not item.get("review_digest")
        or item.get("input_digest")
        != page_by_name.get(path, {}).get("last_attempt", {}).get("input_digest")
    ]
    check(
        "Publication binds page and independent review digests",
        set(manifest_pages) == set(planned) and not digest_errors,
        f"manifest={len(manifest_pages)}, missing={digest_errors[:5]}",
    )

    concept_pages = sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )
    check(
        "required routing concepts exist",
        (bundle / "overview.md").is_file() and (bundle / "architecture.md").is_file(),
        f"{len(concept_pages)} concepts",
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
    workspace = load(ws / "workspace.json")
    source_paths = {
        item["name"]: ws.joinpath(*pathlib.PurePosixPath(item["path"]).parts)
        for item in workspace["sources"]
        if item["kind"] == "git"
    }
    citations = []
    for page in concept_pages:
        citations.extend(
            (page, match) for match in CITE.finditer(page.read_text(encoding="utf-8"))
        )
    random.Random(0).shuffle(citations)
    bad_citations = []
    for page, match in citations[:12]:
        locator, lo, hi = match.groups()
        source, _, rel = locator.partition("/")
        revision = revisions.get(source)
        source_path = source_paths.get(source)
        content = (
            subprocess.run(
                ["git", "-C", str(source_path), "show", f"{revision['commit']}:{rel}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if source_path and revision
            else None
        )
        if content is None or content.returncode:
            bad_citations.append(f"{page.name}: unresolved {locator}")
            continue
        upper = int(hi or lo or 0)
        if upper and upper > len(content.stdout.splitlines()):
            bad_citations.append(f"{page.name}: L{upper} out of range")
    check(
        "sampled Revision Locators resolve",
        bool(citations) and not bad_citations,
        "; ".join(bad_citations)
        or f"{min(12, len(citations))}/{len(citations)} checked",
    )

    proposals = sorted((run_dir / "proposals").glob("agents-block-*.md"))
    proposal_ok = all(
        text.count("<!-- okf-wiki:begin") == 1
        and text.count("<!-- okf-wiki:end -->") == 1
        for text in (path.read_text(encoding="utf-8") for path in proposals)
    )
    check(
        "proposals are well-formed when present",
        proposal_ok,
        f"{len(proposals)} optional proposal files",
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
        for path in concept_pages
        if not all(
            token in path.read_text(encoding="utf-8")
            for token in ("generated:", "verified:", "status: stable", "stale_after:")
        )
    ]
    check(
        "published concepts carry Machine-confirmed lifecycle fields",
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
                "text": "run produced a readable Publication",
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
