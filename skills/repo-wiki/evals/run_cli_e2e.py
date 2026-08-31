#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Deterministic end-to-end exercise of the artifact loop."""

import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile

OKF = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "okf.py"


def invoke(
    cwd: pathlib.Path, *args: str, check: bool = True
) -> subprocess.CompletedProcess:
    command = ["uv", "run", str(OKF), *args, "--json"]
    result = subprocess.run(
        command, cwd=cwd, capture_output=True, text=True, check=False
    )
    if check and result.returncode:
        raise RuntimeError(
            f"{' '.join(command)} failed ({result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result


def run(cwd: pathlib.Path, *args: str) -> dict:
    return json.loads(invoke(cwd, *args).stdout)


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def markdown(meta: dict, body: str) -> str:
    return f"---\n{json.dumps(meta, ensure_ascii=False)}\n---\n\n{body.rstrip()}\n"


def source(path: pathlib.Path, label: str) -> pathlib.Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "e2e@example.test"], check=True
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "E2E"], check=True)
    write(path / "pom.xml", "<project/>\n")
    write(
        path / "src/main/java/example/App.java",
        "package example;\n"
        f'public class App {{ public static String name = "{label}"; }}\n'
        "public interface Named {}\n",
    )
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)
    return path


def unit(unit_id: str, source_names: list[str], kind: str) -> dict:
    return {
        "id": unit_id,
        "kind": kind,
        "question": f"How does {unit_id} work across the captured sources?",
        "scopes": [{"source": name, "paths": ["."]} for name in source_names],
        "evidence_seeds": [
            f"{name}/src/main/java/example/App.java#L1-L2" for name in source_names
        ],
    }


def page(refs: list[tuple[str, str]], logical_link: str) -> str:
    sources = [{"id": source_id, "resource": resource} for source_id, resource in refs]
    citations = " ".join(f"[^{source_id}]" for source_id, _ in refs)
    definitions = "\n".join(
        f"[^{source_id}]: Frozen Source entry point." for source_id, _ in refs
    )
    return markdown(
        {"coverage": "full", "sources": sources},
        "## Responsibility\n\n"
        f"The boundary is anchored by pinned entry points. {citations}\n\n"
        f"## Related concepts\n\n{logical_link}\n\n{definitions}",
    )


def evaluate(base: pathlib.Path) -> dict:
    ws = base / "workspace"
    ws.mkdir()
    api = source(base / "API", "api")
    web = source(base / "WebUI", "web")
    run(
        ws,
        "workspace",
        "init",
        "--lang",
        "en",
        "--freshness-days",
        "30",
        "--max-active-children",
        "4",
        "--search-max-results",
        "1",
        "--read-default-lines",
        "1",
        "--read-max-lines",
        "1",
    )
    run(ws, "source", "add", "link", str(api), "--name", "API")
    run(ws, "source", "add", "link", str(web), "--name", "WebUI")

    started = run(ws, "run", "start")
    if (
        started["phase"] != "plan"
        or started["language"] != "en"
        or started["policy"]["agents"]["max_active_children"] != 4
        or started["policy"]["evidence"]["search"]["max_results"] != 1
        or started["policy"]["evidence"]["read"]["max_lines"] != 1
        or started["sources"] != ["API", "WebUI"]
        or started["next_actions"] != ["repair work/plan.md"]
    ):
        raise RuntimeError(f"Run did not enter Plan: {started}")
    search = run(ws, "evidence", "search", "public", "--source", "API")
    locator = search.get("items", [{}])[0].get("locator")
    continued = run(
        ws,
        "evidence",
        "search",
        "public",
        "--source",
        "API",
        "--after",
        search.get("next_after", ""),
    )
    bounded_read = run(
        ws,
        "evidence",
        "read",
        "API/src/main/java/example/App.java#L1-L3",
    )
    if (
        not locator
        or search.get("limit_reached") is not True
        or continued.get("items", [{}])[0].get("locator") == locator
        or bounded_read.get("end") != 1
        or bounded_read.get("limit_reached") is not True
        or not bounded_read.get("next_locator")
    ):
        raise RuntimeError("bounded evidence search/read failed")

    work = pathlib.Path(started["run_dir"]) / "work"
    write(work / "progress.md", "# Progress\n\nPlan complete; pages remain.\n")
    write(work / "evidence/api-entry.md", f"# API entry\n\nEvidence: `{locator}`.\n")
    write(
        work / "plan.md",
        markdown(
            {
                "kind": "knowledge-plan",
                "units": [
                    unit("workspace-routing", ["API"], "capability"),
                    unit("source-boundaries", ["API", "WebUI"], "integration"),
                ],
                "gaps": [],
            },
            "# Knowledge Plan\n\nThe API and WebUI expose one cross-Source boundary.",
        ),
    )

    plan_packet = run(ws, "review", "plan")
    write(
        pathlib.Path(plan_packet["artifact"]),
        json.dumps(
            {
                "subject_digest": plan_packet["subject_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "id": "domain.failure-handling",
                        "status": "open",
                        "category": "domain-coverage",
                        "claim": "The Plan does not explain failure handling.",
                        "resolution": "Record the bounded fixture's lack of failure behavior.",
                    }
                ],
            }
        ),
    )
    if run(ws, "run", "status")["phase"] != "plan":
        raise RuntimeError("rejected Plan review did not return to planning")
    plan_path = work / "plan.md"
    write(
        plan_path,
        plan_path.read_text()
        + "\n\n## Gaps\n\nThe bounded fixture has no failure behavior to document.\n",
    )
    plan_packet = run(ws, "review", "plan")
    if plan_packet.get("previous_review", {}).get("issues", [{}])[0].get("id") != (
        "domain.failure-handling"
    ):
        raise RuntimeError("follow-up Plan review omitted the prior report")
    write(
        pathlib.Path(plan_packet["artifact"]),
        json.dumps(
            {
                "subject_digest": plan_packet["subject_digest"],
                "verdict": "approved",
                "issues": [
                    {
                        "id": "domain.failure-handling",
                        "status": "resolved",
                        "category": "domain-coverage",
                        "claim": "The Plan does not explain failure handling.",
                        "resolution": "Record the bounded fixture's lack of failure behavior.",
                    }
                ],
            }
        ),
    )
    write(
        work / "composition.md",
        markdown(
            {
                "kind": "composition-map",
                "pages": [
                    {
                        "id": "architecture",
                        "path": "architecture.md",
                        "type": "Domain",
                        "title": "Architecture",
                        "description": "Open before changing Source boundaries.",
                        "tags": ["architecture"],
                        "units": ["source-boundaries"],
                        "diagrams": [],
                    },
                    {
                        "id": "overview",
                        "path": "overview.md",
                        "type": "Overview",
                        "title": "Overview",
                        "description": "Open first to route work.",
                        "tags": ["overview"],
                        "units": ["workspace-routing"],
                        "diagrams": [],
                    },
                ],
                "gaps": [],
            },
            "# Composition\n\nStable page IDs are independent of publication paths.",
        ),
    )
    composition_packet = run(ws, "review", "composition")
    write(
        pathlib.Path(composition_packet["artifact"]),
        json.dumps(
            {
                "subject_digest": composition_packet["subject_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "id": "routing.page-routes",
                        "status": "open",
                        "category": "routing",
                        "claim": "The Composition does not explain its page routes.",
                        "resolution": "Record why each maintainer task lands on one page.",
                        "area": "composition",
                        "page_ids": [],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    if run(ws, "run", "status")["phase"] != "write":
        raise RuntimeError("rejected Composition review did not return to composition")
    composition_path = work / "composition.md"
    write(
        composition_path,
        composition_path.read_text()
        + "\nEach maintainer task has one explicit route.\n",
    )
    composition_packet = run(ws, "review", "composition")
    if (
        composition_packet.get("previous_review", {}).get("issues", [{}])[0].get("id")
        != "routing.page-routes"
    ):
        raise RuntimeError("follow-up Composition review omitted the prior report")
    write(
        pathlib.Path(composition_packet["artifact"]),
        json.dumps(
            {
                "subject_digest": composition_packet["subject_digest"],
                "verdict": "approved",
                "issues": [
                    {
                        "id": "routing.page-routes",
                        "status": "resolved",
                        "category": "routing",
                        "claim": "The Composition does not explain its page routes.",
                        "resolution": "Record why each maintainer task lands on one page.",
                        "area": "composition",
                        "page_ids": [],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    if run(ws, "run", "status")["phase"] != "write":
        raise RuntimeError("approved Composition review did not unlock page writing")

    api_ref = "API/src/main/java/example/App.java#L1-L2"
    web_ref = "WebUI/src/main/java/example/App.java#L1-L2"
    write(
        work / "drafts/architecture.md",
        page([("api", api_ref), ("web", web_ref)], "See [overview][overview]."),
    )
    write(
        work / "drafts/overview.md",
        page([("api", api_ref)], "See [architecture][architecture]."),
    )

    if run(ws, "run", "status")["next_actions"] != ["review prepare"]:
        raise RuntimeError("complete drafts did not advance to review")
    packet = run(ws, "review", "prepare")
    if "previous_review" in packet:
        raise RuntimeError("first review packet included prior review state")
    if "complete_command" in packet:
        raise RuntimeError("review packet leaked a coordinator-only command")
    if packet.get("inputs", {}).get("composition_review") != str(
        work / "composition-review.json"
    ):
        raise RuntimeError("bundle review packet omitted Composition approval")
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject_digest": packet["subject_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "id": "coverage.overview-routing",
                        "status": "open",
                        "category": "coverage",
                        "claim": "Overview needs an explicit routing statement.",
                        "resolution": "Add the routing statement with evidence.",
                        "area": "page",
                        "page_ids": ["overview"],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    changed = run(ws, "review", "complete")
    if changed["verdict"] != "changes_requested":
        raise RuntimeError("review repair loop did not remain active")
    overview = work / "drafts/overview.md"
    write(overview, overview.read_text() + "\nRouting starts here.[^api]\n")

    packet = run(ws, "review", "prepare")
    previous = packet.get("previous_review", {})
    if previous.get("issues", [{}])[0].get(
        "id"
    ) != "coverage.overview-routing" or not previous.get("artifact"):
        raise RuntimeError("follow-up review packet omitted the prior report")
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject_digest": packet["subject_digest"],
                "verdict": "approved",
                "issues": [
                    {
                        "id": "coverage.overview-routing",
                        "status": "resolved",
                        "category": "coverage",
                        "claim": "Overview needs an explicit routing statement.",
                        "resolution": "Add the routing statement with evidence.",
                        "area": "page",
                        "page_ids": ["overview"],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    approved = run(ws, "review", "complete")
    if approved["state"]["status"] != "approved":
        raise RuntimeError("approved review did not approve the Run")

    published = run(ws, "publication", "publish")
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published")
    if validation["errors"] or validation.get("complete") is not True:
        raise RuntimeError(f"published validation failed: {validation}")
    bound = pathlib.Path(published["path"]) / "overview.md"
    if "](/architecture.md)" not in bound.read_text(encoding="utf-8"):
        raise RuntimeError("logical page ID was not bound")

    configured = run(
        ws,
        "workspace",
        "configure",
        "--max-active-children",
        "2",
        "--search-max-results",
        "2",
    )
    if (
        configured["policy"]["agents"]["max_active_children"] != 2
        or configured["policy"]["evidence"]["search"]["max_results"] != 2
    ):
        raise RuntimeError("workspace policy configuration was not persisted")
    second = run(ws, "run", "start")
    if second["policy"] != configured["policy"]:
        raise RuntimeError("new Run did not snapshot the configured policy")
    return {
        "workspace": str(ws),
        "published_generation": published["generation"],
        "pages": published["pages"],
        "next_run_phase": second["phase"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    base = pathlib.Path(tempfile.mkdtemp(prefix="okf-e2e-"))
    try:
        result = evaluate(base)
        print(json.dumps({"passed": True, **result}, indent=2))
    except Exception:
        print(f"failed workspace retained at {base}")
        raise
    if not args.keep:
        shutil.rmtree(base)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
