#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Outcome grader for a published knowledge-composition run."""

import argparse
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
                    {
                        "command": command,
                        "exit_code": item.get("exit_code", 0),
                        "aggregated_output": item.get("output", ""),
                    }
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
    targets = state["targets"]
    parsed_events, commands = trace_commands(ws / "host-run.log")

    check(
        "Run uses the breaking late-binding contract",
        state.get("contract") == "knowledge-composition-late-bind",
        str(state.get("contract")),
    )
    plan_targets = [target for target in targets.values() if target["kind"] == "plan"]
    check(
        "one long-lifecycle Workspace planner owns all Sources",
        len(plan_targets) == 1
        and plan_targets[0]["id"] == "plan:workspace"
        and plan_targets[0]["artifact"].endswith(".md")
        and not plan_targets[0]["depends_on"],
        f"plan_targets={[target['id'] for target in plan_targets]}",
    )
    plan = frontmatter(run_dir / targets["plan:workspace"]["artifact"])
    plan_checkpoint = (
        targets["plan:workspace"].get("last_attempt", {}).get("checkpoint")
    )
    check(
        "planner persisted a durable checkpoint",
        bool(plan_checkpoint)
        and (run_dir / plan_checkpoint).is_file()
        and bool(targets["plan:workspace"]["last_attempt"].get("checkpoint_digest")),
        str(plan_checkpoint),
    )
    check(
        "Knowledge Plan contains stable units without Wiki paths",
        plan.get("kind") == "knowledge-plan"
        and bool(plan.get("units"))
        and all("id" in unit and "path" not in unit for unit in plan["units"]),
        f"units={len(plan.get('units', []))}",
    )

    research = [
        target
        for target in targets.values()
        if target["kind"] == "page" and target.get("spec", {}).get("mode") == "research"
    ]
    active_units = {
        target["spec"]["unit_id"]
        for target in research
        if not target["spec"].get("superseded")
    }
    check(
        "research fan-out is unit-keyed and bounded",
        bool(research)
        and len(research) <= 96
        and all(
            target["id"] == f"page:research/{target['spec']['unit_id']}"
            for target in research
        ),
        f"research={len(research)}, active={len(active_units)}",
    )

    compose_target = targets.get("page:compose")
    compose_review = targets.get("review:composition")
    composition = (
        frontmatter(run_dir / compose_target["artifact"]) if compose_target else {}
    )
    composed_pages = {page["id"]: page for page in composition.get("pages", [])}
    mapped_units = [
        unit for page in composed_pages.values() for unit in page.get("units", [])
    ]
    check(
        "Composition Map assigns every active unit exactly once",
        composition.get("kind") == "composition-map"
        and set(mapped_units) == active_units
        and len(mapped_units) == len(set(mapped_units)),
        f"active={len(active_units)}, mapped={len(mapped_units)}",
    )
    check(
        "independent composition review completed before writing",
        bool(compose_review)
        and compose_review["status"] == "complete"
        and compose_review["spec"]["subject"] == "page:compose"
        and bool(compose_target.get("last_attempt", {}).get("checkpoint_digest")),
        f"review={compose_review and compose_review['status']}",
    )

    writes = {
        target["spec"]["id"]: target
        for target in targets.values()
        if target["kind"] == "page" and target.get("spec", {}).get("mode") == "write"
    }
    page_reviews = {
        target["spec"]["subject"].removeprefix("page:write/"): target
        for target in targets.values()
        if target["kind"] == "review"
        and target.get("spec", {}).get("subject", "").startswith("page:write/")
    }
    check(
        "write and review Targets use stable page IDs rather than paths",
        set(writes) == set(composed_pages) == set(page_reviews)
        and all(
            target["id"] == f"page:write/{page_id}"
            and target["artifact"] == f"drafts/pages/{page_id}.md"
            for page_id, target in writes.items()
        ),
        f"composed={len(composed_pages)}, writes={len(writes)}, reviews={len(page_reviews)}",
    )
    relation_errors = []
    for page_id, page in composed_pages.items():
        expected = {f"review:{item}" for item in page.get("depends_on", [])}
        actual = set(writes.get(page_id, {}).get("depends_on", [])) - {
            "review:composition"
        }
        if expected != actual:
            relation_errors.append(page_id)
    check(
        "page readiness follows stable-ID Machine-confirmed relations",
        not relation_errors,
        f"errors={relation_errors}",
    )

    indexes = sorted((run_dir / "drafts/index").glob("*.md"))
    bad_indexes = [
        path.name
        for path in indexes
        if path.stat().st_size > 64 * 1024
        or "inventory complete" not in path.read_text(encoding="utf-8")
        or "## Repository outline" not in path.read_text(encoding="utf-8")
    ]
    check(
        "each Revision has one bounded compact Source outline",
        len(indexes) == len(state["revisions"]) and not bad_indexes,
        f"indexes={len(indexes)}, bad={bad_indexes}",
    )

    manifest_pages = manifest.get("pages", {})
    expected_paths = {page["path"] for page in composed_pages.values()}
    digest_errors = [
        path
        for path, item in manifest_pages.items()
        if not item.get("output_digest") or not item.get("review_digest")
    ]
    check(
        "Publication binds Composition paths and review digests",
        set(manifest_pages) == expected_paths and not digest_errors,
        f"paths={len(expected_paths)}, manifest={len(manifest_pages)}, bad={digest_errors}",
    )

    concept_pages = sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )
    check(
        "published page set matches the reviewed Composition Map",
        len(concept_pages) == len(composed_pages) and bool(concept_pages),
        f"concepts={len(concept_pages)}, composed={len(composed_pages)}",
    )
    ids = [frontmatter(path).get("id") for path in concept_pages]
    check(
        "published pages retain unique stable IDs",
        len(ids) == len(set(ids)) and set(ids) == set(composed_pages),
        f"ids={ids}",
    )

    if "killbill" in {item["name"] for item in state["revisions"]}:
        routing = json.dumps(list(composed_pages.values()), ensure_ascii=False).lower()
        wiki = "\n".join(
            path.read_text(encoding="utf-8").lower() for path in concept_pages
        )
        domains = {
            "catalog-plan-phase": ("catalog", "plan", "phase"),
            "subscription-entitlement": ("subscription", "entitlement"),
            "usage-metering": ("usage",),
            "invoice-payment-overdue": ("invoice", "payment", "overdue"),
            "durable-queue": ("queue",),
            "service-lifecycle": ("lifecycle",),
            "plugins": ("plugin",),
        }
        missing = [
            name
            for name, terms in domains.items()
            if not all(term in routing for term in terms)
        ]
        check(
            "Kill Bill composition covers the billing rubric",
            not missing,
            f"missing={missing}",
        )
        check(
            "Kill Bill distinguishes public and internal APIs",
            ("public api" in wiki or "公开 api" in wiki)
            and ("internal api" in wiki or "内部 api" in wiki),
            "published pages inspected",
        )
        check(
            "Kill Bill composition stays concept-sized",
            len(composed_pages) <= 24,
            f"pages={len(composed_pages)}",
        )

    if state["language"] == "zh":
        cjk = re.compile(r"[\u3400-\u9fff]")
        descriptions = [page.get("description", "") for page in composed_pages.values()]
        questions = [
            diagram.get("question", "")
            for page in composed_pages.values()
            for diagram in page.get("diagrams", [])
        ]
        check(
            "Chinese composition localizes routing and diagram questions",
            all(cjk.search(text) for text in descriptions)
            and all(cjk.search(text) for text in questions),
            f"descriptions={len(descriptions)}, questions={len(questions)}",
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
        or " --help" in item.get("command", "")
    ]
    check(
        "host trace respects packets and avoids run internals",
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
        "reserved files and Machine-confirmed trust fields conform",
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
    except (
        OSError,
        TypeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
    ) as exc:
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
