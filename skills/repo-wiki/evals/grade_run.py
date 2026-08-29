#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Outcome grader for a published artifact-loop run."""

import argparse
import hashlib
import json
import pathlib
import random
import re
import subprocess
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL / "scripts"))

from _frontmatter import parse_file

CITE = re.compile(
    r"^\s*resource:\s*\"?([A-Za-z0-9][A-Za-z0-9-]*/[^\s#\"]+)"
    r"(?:#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?)?\"?\s*$",
    re.MULTILINE,
)


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def frontmatter(path: pathlib.Path) -> dict:
    parsed = parse_file(path)
    if parsed.errors:
        raise ValueError(f"invalid frontmatter in {path}: {'; '.join(parsed.errors)}")
    return parsed.meta


def trace_commands(path: pathlib.Path) -> tuple[int, list[dict]]:
    parsed = 0
    commands = []
    if not path.is_file():
        return parsed, commands
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed += 1
        item = event.get("item", event)
        if (
            item.get("type") == "command_execution"
            and item.get("exit_code") is not None
        ):
            commands.append(item)
        elif item.get("type") == "tool_use" and item.get("name") == "Bash":
            command = item.get("input", {}).get("command")
            if command:
                commands.append(
                    {"command": command, "exit_code": item.get("exit_code", 0)}
                )
    return parsed, commands


def grade(ws: pathlib.Path) -> list[dict]:
    results = []

    def check(name: str, passed: bool, evidence: str) -> None:
        results.append({"text": name, "passed": bool(passed), "evidence": evidence})

    pointer = load(ws / ".okf-wiki/publication/current.json")
    bundle = ws / ".okf-wiki/publication/generations" / pointer["generation"]
    manifest = load(bundle / ".okf-manifest.json")
    run_dir = ws / ".okf-wiki/runs" / manifest["run_id"]
    state = load(run_dir / "state.json")
    work = run_dir / "work"
    parsed_events, commands = trace_commands(ws / "host-run.log")

    check(
        "Run uses the artifact-loop contract without scheduler state",
        state.get("contract") == "artifact-loop-late-bind"
        and not any(
            key in state
            for key in ("targets", "tasks", "producer_session", "review_rounds")
        ),
        f"contract={state.get('contract')}, keys={sorted(state)}",
    )

    plan = frontmatter(work / "plan.md")
    units = plan.get("units", [])
    check(
        "one living Knowledge Plan owns semantic units without page bindings",
        plan.get("kind") == "knowledge-plan"
        and isinstance(units, list)
        and (bool(units) or bool(plan.get("gaps")))
        and all(
            "id" in unit and "path" not in unit and "owner" not in unit
            for unit in units
        ),
        f"units={len(units)}",
    )
    check(
        "long-run progress is one fixed living file",
        (work / "progress.md").is_file()
        and not list(run_dir.rglob("*.checkpoint.md"))
        and not (run_dir / "attempts").exists(),
        str(work / "progress.md"),
    )

    composition = frontmatter(work / "composition.md")
    pages = {page["id"]: page for page in composition.get("pages", [])}
    mapped = [unit for page in pages.values() for unit in page.get("units", [])]
    unit_ids = {unit["id"] for unit in units}
    removed_fields = {"owner", "scopes", "evidence_seeds", "parent", "depends_on"}
    check(
        "Composition late-binds every unit exactly once without duplicate graphs",
        composition.get("kind") == "composition-map"
        and set(mapped) == unit_ids
        and len(mapped) == len(set(mapped))
        and all(not (removed_fields & set(page)) for page in pages.values()),
        f"units={len(unit_ids)}, pages={len(pages)}",
    )

    drafts = {path.stem for path in (work / "drafts").glob("*.md")}
    check(
        "fixed page drafts match stable Composition page IDs",
        drafts == set(pages),
        f"drafts={sorted(drafts)}, pages={sorted(pages)}",
    )

    review = load(work / "review.json")
    review_digest = hashlib.sha256((work / "review.json").read_bytes()).hexdigest()
    check(
        "one final Wiki review approved the exact bundle",
        review.get("verdict") == "approved"
        and review.get("subject_digest") == state.get("review_subject_digest")
        and review_digest == state.get("approved_review_digest"),
        f"verdict={review.get('verdict')}",
    )

    manifest_pages = manifest.get("pages", {})
    expected_paths = {page["path"] for page in pages.values()}
    check(
        "Publication paths and page IDs come from Composition",
        set(manifest_pages) == expected_paths
        and {item.get("page_id") for item in manifest_pages.values()} == set(pages)
        and all(
            item.get("review_digest") == review_digest
            for item in manifest_pages.values()
        ),
        f"manifest={len(manifest_pages)}, expected={len(expected_paths)}",
    )

    indexes = sorted((run_dir / "index").glob("*.md"))
    check(
        "each Revision has one bounded compact Source outline",
        len(indexes) == len(state["revisions"])
        and all(path.stat().st_size <= 64 * 1024 for path in indexes),
        f"indexes={len(indexes)}, revisions={len(state['revisions'])}",
    )

    concept_pages = sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )
    ids = [frontmatter(path).get("id") for path in concept_pages]
    check(
        "published pages exactly match stable IDs and paths",
        len(concept_pages) == len(pages)
        and set(ids) == set(pages)
        and len(ids) == len(set(ids)),
        f"ids={ids}",
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
    citations = [
        (page, match)
        for page in concept_pages
        for match in CITE.finditer(page.read_text(encoding="utf-8"))
    ]
    random.Random(0).shuffle(citations)
    bad_citations = []
    for page, match in citations[:12]:
        locator, lo, hi = match.groups()
        source_name, _, rel = locator.partition("/")
        revision = revisions.get(source_name)
        source_path = source_paths.get(source_name)
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
        upper = int(hi or lo or 0)
        if (
            content is None
            or content.returncode
            or (upper and upper > len(content.stdout.splitlines()))
        ):
            bad_citations.append(f"{page.name}: {locator}")
    check(
        "sampled Revision Locators resolve",
        bool(citations) and not bad_citations,
        f"checked={min(12, len(citations))}, bad={bad_citations}",
    )

    bad_commands = [
        item.get("command", "")
        for item in commands
        if "state.json" in item.get("command", "")
        or re.search(
            r"\btask\s+(?:start|packet|checkpoint|complete)\b", item.get("command", "")
        )
        or "--session" in item.get("command", "")
    ]
    check(
        "host trace uses the artifact loop without execution IDs",
        not bad_commands,
        f"events={parsed_events}, bad={bad_commands[:3]}",
    )

    root_index = (bundle / "index.md").read_text(encoding="utf-8")
    log = (bundle / "log.md").read_text(encoding="utf-8")
    trust_missing = [
        path.name
        for path in concept_pages
        if not all(
            token in path.read_text(encoding="utf-8")
            for token in ("generated:", "verified:", "status: stable", "stale_after:")
        )
    ]
    check(
        "reserved files and review trust fields conform",
        root_index.startswith('---\nokf_version: "0.2"\n---\n')
        and re.search(r"^## \d{4}-\d{2}-\d{2}$", log, re.MULTILINE)
        and not trust_missing,
        f"trust_missing={trust_missing}",
    )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=pathlib.Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        results = grade(args.workspace.resolve())
    except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
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
