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


def unit(
    unit_id: str, source_names: list[str], kind: str, concept_ids: list[str]
) -> dict:
    roles = (
        ["producer", "consumer", *(["contract"] * (len(source_names) - 2))]
        if kind == "integration"
        else ["owner"] * len(source_names)
    )
    return {
        "id": unit_id,
        "kind": kind,
        "question": f"How does {unit_id} work across the captured sources?",
        "domain_ids": ["workspace"],
        "concept_ids": concept_ids,
        "scopes": [
            {"source": name, "role": role, "paths": ["."]}
            for name, role in zip(source_names, roles, strict=True)
        ],
        "evidence_seeds": [
            f"{name}/src/main/java/example/App.java#L1-L2" for name in source_names
        ],
    }


def knowledge_plan(units: list[dict]) -> dict:
    api_ref = "API/src/main/java/example/App.java#L1-L2"
    web_ref = "WebUI/src/main/java/example/App.java#L1-L2"
    return {
        "kind": "knowledge-plan",
        "source_areas": [
            {
                "id": "api.workspace",
                "source": "API",
                "paths": ["."],
                "disposition": "domain",
                "domain_ids": ["workspace"],
                "evidence_seeds": [api_ref],
            },
            {
                "id": "web.workspace",
                "source": "WebUI",
                "paths": ["."],
                "disposition": "domain",
                "domain_ids": ["workspace"],
                "evidence_seeds": [web_ref],
            },
        ],
        "domains": [
            {
                "id": "workspace",
                "name": "Workspace routing",
                "definition": "Owns maintainer routing and the API-to-WebUI boundary.",
                "owner_unit_id": "workspace-routing",
                "evidence": [api_ref, web_ref],
            }
        ],
        "concepts": [
            {
                "id": "routing",
                "domain_id": "workspace",
                "kind": "process",
                "name": "Routing",
                "definition": "Selects one maintainer route for a workspace question.",
                "owner_unit_id": "workspace-routing",
                "model_unit_id": "workspace-model",
                "owner_evidence": [api_ref],
                "behavior_seeds": [api_ref],
                "model_basis": {
                    "basis": "code",
                    "coverage": "full",
                    "catalog_tables": [],
                    "structure_evidence": [api_ref],
                    "gap_ids": [],
                },
            },
            {
                "id": "source-boundary",
                "domain_id": "workspace",
                "kind": "service",
                "name": "Source boundary",
                "definition": "Coordinates the API and WebUI handoff without persistence.",
                "owner_unit_id": "workspace-routing",
                "model_unit_id": None,
                "owner_evidence": [api_ref, web_ref],
                "behavior_seeds": [api_ref, web_ref],
                "model_basis": {
                    "basis": "none",
                    "coverage": "full",
                    "catalog_tables": [],
                    "structure_evidence": [],
                    "gap_ids": [],
                },
            },
        ],
        "table_groups": [],
        "relationships": [
            {
                "id": "routing-selects-boundary",
                "from_concept_id": "routing",
                "to_concept_id": "source-boundary",
                "level": "observed",
                "cardinality": "one-to-one",
                "evidence": [api_ref, web_ref],
                "include_in_er": True,
            }
        ],
        "units": units,
        "gaps": [],
    }


def page(refs: list[tuple[str, str]], logical_link: str, page_type: str) -> str:
    sources = [{"id": source_id, "resource": resource} for source_id, resource in refs]
    citations = " ".join(f"[^{source_id}]" for source_id, _ in refs)
    definitions = "\n".join(
        f"[^{source_id}]: Frozen Source entry point." for source_id, _ in refs
    )
    if page_type == "Overview":
        body = (
            "## Scope and boundaries\n\n"
            f"Pinned entry points bound this Wiki. {citations}\n\n"
            "## Task entry points\n\n"
            "| Task | Start here |\n| --- | --- |\n"
            f"| Change a boundary | {logical_link} |\n\n{definitions}"
        )
    elif page_type == "DataModel":
        body = (
            "## Model basis\n\n"
            f"Routing uses code-derived structure from the pinned API entry. {citations}\n\n"
            "## Physical model\n\n"
            "<!-- okf-generated:model -->\n\n"
            "## Logical relationships\n\n"
            "```mermaid\n"
            "%% okf-id: routing-model\n"
            "erDiagram\n"
            "    accTitle: Routing model\n"
            "    accDescr: Routing selects the API-to-WebUI source boundary.\n"
            "    ROUTING ||--|| SOURCE_BOUNDARY : selects\n"
            "```\n\n"
            f"The code-derived relationship is anchored in both entry points. {citations}\n\n"
            "## Ownership and boundaries\n\nAPI owns routing; WebUI participates in the handoff.\n\n"
            f"## Reference model\n\nNo OpenGauss reference exists for this code-only fixture. {logical_link}\n\n"
            "## Code-to-data mapping\n\n"
            "| Concept | Code projection | Owner |\n"
            "| --- | --- | --- |\n"
            "| Routing | App entry | API |\n\n"
            f"{definitions}"
        )
    elif page_type == "Procedure":
        body = (
            "## Responsibility and boundaries\n\n"
            f"The workspace routing procedure owns ordered entry selection. {citations}\n\n"
            "## Inputs and outputs\n\n"
            "A maintenance question enters and one capability route is produced.\n\n"
            "## Execution and algorithm\n\n"
            f"Classify the question, select its capability, then follow {logical_link}\n\n"
            "## Rules and failure modes\n\n"
            "| Rule | Enforcement point | Observable failure |\n"
            "| --- | --- | --- |\n"
            "| Select one route. | Routing procedure | Ambiguous destination |\n\n"
            "## Change points\n\nChange the routing procedure and its tests.\n\n"
            f"{definitions}"
        )
    elif page_type == "Flow":
        body = (
            "## Trigger and outcome\n\n"
            f"An API boundary request reaches WebUI. {citations}\n\n"
            "## Operational flow\n\n"
            "```mermaid\n"
            "%% okf-id: source-handoff\n"
            "sequenceDiagram\n"
            "    accTitle: Source handoff\n"
            "    accDescr: API sends the boundary request to WebUI.\n"
            "    API->>WebUI: Boundary request\n"
            "```\n\n"
            f"The handoff requires both captured participants. {citations}\n\n"
            "## Alternatives and recovery\n\n"
            "| Failure | Recovery | Terminal outcome |\n"
            "| --- | --- | --- |\n"
            "| Participant missing | Restore the boundary | Request rejected |\n\n"
            "## Change points\n\nChange both participants and their contract tests.\n\n"
            f"{logical_link}\n\n{definitions}"
        )
    else:
        body = (
            "## Responsibility and public surface\n\n"
            f"Pinned entry points define this boundary. {citations}\n\n"
            "## Invariants and rules\n\n"
            "| Rule | Enforcement point | Observable failure |\n"
            "| --- | --- | --- |\n"
            "| Both sides remain explicit. | Source boundary | Missing handoff |\n\n"
            f"## Concepts\n\n{logical_link}\n\n"
            "## Change points\n\nChange both boundary participants and tests.\n\n"
            f"{definitions}"
        )
    return markdown({"coverage": "full", "sources": sources}, body)


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
    write(
        work / "evidence/API/api-entry.md", f"# API entry\n\nEvidence: `{locator}`.\n"
    )
    write(
        work / "plan.md",
        markdown(
            {
                **knowledge_plan(
                    [
                        unit(
                            "workspace-routing",
                            ["API", "WebUI"],
                            "capability",
                            ["routing", "source-boundary"],
                        ),
                        unit("workspace-algorithm", ["API"], "flow", ["routing"]),
                        unit(
                            "source-boundaries",
                            ["API", "WebUI"],
                            "integration",
                            ["source-boundary"],
                        ),
                        unit(
                            "workspace-model",
                            ["API", "WebUI"],
                            "data-model",
                            ["routing"],
                        ),
                    ]
                )
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
                "merge_probes": [
                    {
                        "unit_ids": ["workspace-routing", "source-boundaries"],
                        "decision": "keep-separate",
                        "rationale": "Workspace routing and boundary maintenance are independent questions.",
                    },
                    {
                        "unit_ids": ["workspace-routing", "workspace-algorithm"],
                        "decision": "keep-separate",
                        "rationale": "Entry navigation and the routing algorithm answer different maintenance questions.",
                    },
                    {
                        "unit_ids": ["workspace-algorithm", "workspace-model"],
                        "decision": "keep-separate",
                        "rationale": "Routing behavior and its code-derived model answer different questions.",
                    },
                ],
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
        plan_path.read_text(encoding="utf-8")
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
                "merge_probes": [
                    {
                        "unit_ids": ["workspace-routing", "source-boundaries"],
                        "decision": "keep-separate",
                        "rationale": "Workspace routing and boundary maintenance are independent questions.",
                    },
                    {
                        "unit_ids": ["workspace-routing", "workspace-algorithm"],
                        "decision": "keep-separate",
                        "rationale": "Entry navigation and the routing algorithm answer different maintenance questions.",
                    },
                    {
                        "unit_ids": ["workspace-algorithm", "workspace-model"],
                        "decision": "keep-separate",
                        "rationale": "Routing behavior and its code-derived model answer different questions.",
                    },
                ],
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
                "reference_roots": [],
                "pages": [
                    {
                        "id": "architecture",
                        "path": "system/architecture.md",
                        "type": "Flow",
                        "title": "Architecture",
                        "description": "Open before changing Source boundaries.",
                        "tags": ["architecture"],
                        "units": ["source-boundaries"],
                        "diagrams": [
                            {
                                "id": "source-handoff",
                                "kind": "sequence",
                                "question": "How does the boundary cross Sources?",
                                "sources": ["API", "WebUI"],
                            }
                        ],
                    },
                    {
                        "id": "overview",
                        "path": "routing/overview.md",
                        "type": "Domain",
                        "title": "Overview",
                        "description": "Open first to route work.",
                        "tags": ["overview"],
                        "units": ["workspace-routing"],
                        "diagrams": [],
                    },
                    {
                        "id": "data-model",
                        "path": "routing/data-model.md",
                        "type": "DataModel",
                        "title": "Routing model",
                        "description": "Open before changing routing structure.",
                        "tags": ["routing", "model"],
                        "units": ["workspace-model"],
                        "diagrams": [
                            {
                                "id": "routing-model",
                                "kind": "er",
                                "question": "How does routing select a source boundary?",
                                "sources": ["API", "WebUI"],
                            }
                        ],
                    },
                    {
                        "id": "procedure",
                        "path": "routing/workspace-procedure.md",
                        "type": "Procedure",
                        "title": "Workspace routing procedure",
                        "description": "Open before changing the routing algorithm.",
                        "tags": ["routing"],
                        "units": ["workspace-algorithm"],
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
                "merge_probes": [
                    {
                        "page_ids": ["architecture", "overview"],
                        "decision": "keep-separate",
                        "rationale": "The overview routes work while the architecture page owns boundary details.",
                    },
                    {
                        "page_ids": ["overview", "procedure"],
                        "decision": "keep-separate",
                        "rationale": "The overview routes readers while the procedure explains the routing algorithm.",
                    },
                    {
                        "page_ids": ["procedure", "data-model"],
                        "decision": "keep-separate",
                        "rationale": "The procedure explains behavior while the model explains structure.",
                    },
                ],
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
        composition_path.read_text(encoding="utf-8")
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
                "merge_probes": [
                    {
                        "page_ids": ["architecture", "overview"],
                        "decision": "keep-separate",
                        "rationale": "The overview routes work while the architecture page owns boundary details.",
                    },
                    {
                        "page_ids": ["overview", "procedure"],
                        "decision": "keep-separate",
                        "rationale": "The overview routes readers while the procedure explains the routing algorithm.",
                    },
                    {
                        "page_ids": ["procedure", "data-model"],
                        "decision": "keep-separate",
                        "rationale": "The procedure explains behavior while the model explains structure.",
                    },
                ],
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
        page(
            [("api", api_ref), ("web", web_ref)],
            "See [overview][overview].",
            "Flow",
        ),
    )
    write(
        work / "drafts/overview.md",
        page(
            [("api", api_ref), ("web", web_ref)],
            "See [architecture][architecture].",
            "Domain",
        ),
    )
    write(
        work / "drafts/procedure.md",
        page([("api", api_ref)], "[overview][overview].", "Procedure"),
    )
    write(
        work / "drafts/data-model.md",
        page(
            [("api", api_ref), ("web", web_ref)],
            "See [overview][overview].",
            "DataModel",
        ),
    )

    overview = work / "drafts/overview.md"
    full_page = overview.read_text(encoding="utf-8")
    write(overview, full_page + "\n## Gaps\n\nA scoped behavior remains unverified.\n")
    rejected = invoke(ws, "review", "prepare", check=False)
    rejected_data = json.loads(rejected.stdout)
    if rejected.returncode != 1 or [
        item["code"] for item in rejected_data.get("issues", [])
    ] != ["gaps-unexpected"]:
        raise RuntimeError("full coverage accepted a Gaps section")
    write(overview, full_page)

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
    candidate = pathlib.Path(packet["inputs"]["candidate"])
    if (
        not (candidate / "index.md").is_file()
        or not (candidate / "system/index.md").is_file()
        or not (candidate / "routing/index.md").is_file()
    ):
        raise RuntimeError("Candidate navigation indexes were not generated")
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
    write(
        overview,
        overview.read_text(encoding="utf-8") + "\nRouting starts here.[^api]\n",
    )

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
    bound = pathlib.Path(published["path"]) / "routing/overview.md"
    if "](/system/architecture.md)" not in bound.read_text(encoding="utf-8"):
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
