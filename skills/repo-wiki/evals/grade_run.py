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
    run_id = manifest["producer_run_id"]
    run_dir = ws / ".okf-wiki/runs" / run_id
    state = load(run_dir / "state.json")
    trace_events, commands = trace_commands(ws / "host-run.log")
    command_text = [str(item.get("command", "")) for item in commands]
    direct_state = [
        command
        for command in command_text
        if re.search(r"(?:find|rg|ls)\b[^\n]*\.okf-wiki", command)
        or re.search(
            r"(?:cat|sed|head|tail|less|jq)\b[^\n]*"
            r"(?:state\.json|current-run\.json)",
            command,
        )
    ]
    failed_reads = [
        item
        for item in commands
        if "task read" in str(item.get("command", "")) and item.get("exit_code")
    ]
    help_probes = [command for command in command_text if "--help" in command]
    check(
        "host emitted a structured command trace",
        trace_events > 0 and bool(commands),
        f"events={trace_events}, commands={len(commands)}",
    )
    check(
        "workers used packets instead of inspecting run internals",
        not direct_state,
        f"direct_state_commands={len(direct_state)}",
    )
    check(
        "locator reads required no recovery probes",
        not failed_reads and not help_probes,
        f"failed_reads={len(failed_reads)}, help={len(help_probes)}",
    )
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
    workspace_plan = targets.get("plan:workspace")
    if workspace_plan and workspace_plan.get("spec", {}).get("mode") != "workspace":
        workspace_plan = None
    source_plans = [
        target for target in plans if target.get("spec", {}).get("mode") == "source"
    ]
    pages = [target for target in targets.values() if target["kind"] == "page"]
    reviews = [target for target in targets.values() if target["kind"] == "review"]
    plan_reviews = [
        target
        for target in reviews
        if target.get("spec", {}).get("subject") == "plan:workspace"
    ]
    page_reviews = [target for target in reviews if target not in plan_reviews]
    revision_names = {item["name"] for item in state["revisions"]}
    plan = None
    if workspace_plan:
        try:
            plan_path = run_dir / workspace_plan["artifact"]
            plan = load(plan_path)
        except (OSError, json.JSONDecodeError):
            plan = None
    bad_briefs = []
    for target in source_plans:
        try:
            brief = load(run_dir / target["artifact"])
        except (OSError, json.JSONDecodeError):
            bad_briefs.append(target["id"])
            continue
        if brief.get("source") != target.get("spec", {}).get("source"):
            bad_briefs.append(target["id"])
    expected_source_plans = {f"plan:{name}" for name in revision_names}
    actual_source_plans = {target["id"] for target in source_plans}
    source_dependencies = set(workspace_plan["depends_on"]) if workspace_plan else set()
    check(
        "each code Source produced one persistent Source Brief before synthesis",
        actual_source_plans == expected_source_plans
        and source_dependencies == expected_source_plans
        and not bad_briefs,
        f"expected={sorted(expected_source_plans)}, actual={sorted(actual_source_plans)}, "
        f"bad={bad_briefs}",
    )
    planned = {item["path"]: item for item in (plan or {}).get("pages", [])}
    check(
        "page and review target counts come from the Page Plan",
        bool(planned)
        and {target["name"] for target in pages} == set(planned)
        and {target["name"] for target in page_reviews} == set(planned),
        f"planned={len(planned)}, pages={len(pages)}, reviews={len(page_reviews)}",
    )
    check(
        "one independent Plan review completed before page fan-out",
        len(plan_reviews) == 1
        and plan_reviews[0]["status"] == "complete"
        and set(plan_reviews[0]["depends_on"])
        == {"plan:workspace", *expected_source_plans}
        and all("review:plan" in target["depends_on"] for target in pages),
        f"plan_reviews={len(plan_reviews)}",
    )
    source_owned = [
        entry for entry in planned.values() if entry.get("owner") != "workspace"
    ]
    missing_seeds = [
        entry.get("path", "<unknown>")
        for entry in source_owned
        if not entry.get("evidence_seeds")
    ]
    check(
        "source-owned concepts are evidence-seeded",
        bool(source_owned) and not missing_seeds,
        f"source_owned={len(source_owned)}, missing={missing_seeds[:5]}",
    )
    dependency_errors = []
    review_by_page = {target["name"]: target for target in page_reviews}
    for path, entry in planned.items():
        for child in entry.get("depends_on", []):
            if review_by_page.get(child, {}).get("status") != "complete":
                dependency_errors.append(f"{path}: child {child} not Machine-confirmed")
    check(
        "parent pages depend on Machine-confirmed children",
        not dependency_errors,
        "; ".join(dependency_errors[:5]) or "all dependency reviews complete",
    )

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
    if "killbill" in revision_names:
        routing_text = json.dumps(
            [
                {
                    key: entry.get(key)
                    for key in ("path", "title", "description", "tags")
                }
                for entry in planned.values()
            ],
            ensure_ascii=False,
        ).lower()
        wiki_text = "\n".join(
            [json.dumps(plan, ensure_ascii=False)]
            + [path.read_text(encoding="utf-8") for path in concept_pages]
        ).lower()
        domain_terms = {
            "catalog-plan-phase": ("catalog", "plan", "phase"),
            "subscription-entitlement": ("subscription", "entitlement"),
            "usage-metering": ("usage",),
            "invoice-payment-overdue": ("invoice", "payment", "overdue"),
            "durable-queue": ("queue",),
            "service-lifecycle": ("lifecycle",),
            "plugins": ("plugin",),
        }
        missing_domains = [
            name
            for name, terms in domain_terms.items()
            if not all(term in routing_text for term in terms)
        ]
        check(
            "Kill Bill plan covers the billing domain rubric",
            not missing_domains,
            f"missing={missing_domains}",
        )
        public_internal = ("public api" in wiki_text or "公开 api" in wiki_text) and (
            "internal api" in wiki_text or "内部 api" in wiki_text
        )
        check(
            "Kill Bill distinguishes public and internal APIs",
            public_internal,
            f"distinguished={public_internal}",
        )
        root_text = "\n".join(
            (bundle / name).read_text(encoding="utf-8").lower()
            for name in ("architecture.md", "overview.md")
        )
        disconnected = [
            name for name in revision_names if name.lower() not in root_text
        ]
        check(
            "Kill Bill roots connect every registered repository",
            not disconnected,
            f"disconnected={disconnected}",
        )
        check(
            "Kill Bill plan stays concept-sized rather than module-sized",
            len(planned) <= 24,
            f"planned_pages={len(planned)}",
        )
        output_chars = sum(
            len(str(item.get("aggregated_output", item.get("output", ""))))
            for item in commands
        )
        check(
            "Kill Bill command and tool output stay below half the QA baseline",
            len(commands) <= 444 and output_chars <= 1_202_346,
            f"commands={len(commands)}, output_chars={output_chars}",
        )
    if state["language"] == "zh":
        cjk = re.compile(r"[\u3400-\u9fff]")
        titles = [entry.get("title", "") for entry in planned.values()]
        descriptions = [entry.get("description", "") for entry in planned.values()]
        check(
            "Chinese plans use Chinese routing metadata",
            all(cjk.search(text) for text in descriptions)
            and sum(bool(cjk.search(text)) for text in titles)
            >= max(1, len(titles) * 4 // 5),
            f"titles={len(titles)}, descriptions={len(descriptions)}",
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
