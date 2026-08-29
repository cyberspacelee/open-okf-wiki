#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Deterministic end-to-end exercise of the ready-page DAG contract."""

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile

OKF = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "okf.py"


def invoke(
    cwd: pathlib.Path, *args: str, json_output: bool = False, check: bool = True
) -> subprocess.CompletedProcess:
    command = ["uv", "run", str(OKF), *args]
    if json_output:
        command.append("--json")
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
    result = invoke(cwd, *args, json_output=True)
    return json.loads(result.stdout)


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def source(path: pathlib.Path, label: str) -> pathlib.Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "e2e@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "E2E"], check=True)
    write(path / "pom.xml", "<project/>\n")
    write(
        path / "src/main/java/example/App.java",
        f'package example;\npublic class App {{ static String name = "{label}"; }}\n',
    )
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)
    return path


def ready_ids(status: dict) -> set[str]:
    result = set()
    for target in status.get("ready_targets", []):
        result.add(target["id"] if isinstance(target, dict) else target)
    return result


def complete(cwd: pathlib.Path, target: str, content: str) -> dict:
    packet = run(cwd, "task", "start", target)
    return finish(cwd, target, packet, content)


def finish(cwd: pathlib.Path, target: str, packet: dict, content: str) -> dict:
    if not all(key in packet for key in ("attempt", "artifact", "complete_command")):
        raise RuntimeError(f"incomplete dispatch packet for {target}: {sorted(packet)}")
    if "contract" not in packet or (
        target.startswith("page:") and "template" not in packet
    ):
        raise RuntimeError(f"dispatch packet omitted contract assets for {target}")
    replayed = run(cwd, "task", "packet", target, "--attempt", packet["attempt"])
    if replayed != packet:
        raise RuntimeError(f"persisted packet changed for {target}")
    write(pathlib.Path(packet["artifact"]), content)
    result = run(
        cwd,
        "task",
        "complete",
        target,
        "--attempt",
        packet["attempt"],
    )
    if not result.get("ok"):
        raise RuntimeError(f"target gate rejected {target}: {result}")
    return result


def brief(source_name: str, counterpart: str) -> str:
    return json.dumps(
        {
            "source": source_name,
            "roles": ["public-contract"],
            "concepts": [
                {
                    "name": "application-entry-point",
                    "description": "The application exposes its source-owned entry point.",
                    "paths": ["src/main/java/example/App.java"],
                    "evidence_seeds": [
                        f"{source_name}/src/main/java/example/App.java#L1-L2"
                    ],
                }
            ],
            "connections": [
                {
                    "name": "application-contract",
                    "description": "The application contract crosses Source boundaries.",
                    "evidence_seeds": [
                        f"{source_name}/src/main/java/example/App.java#L1-L2"
                    ],
                    "counterpart_sources": [counterpart],
                    "counterpart_queries": ["class App"],
                }
            ],
            "gaps": [],
        }
    )


def page(
    title: str,
    refs: list[tuple[str, str]],
    links: str,
    *,
    diagram: tuple[str, str] | None = (
        "component-map",
        "flowchart LR\n    Entry --> Implementation",
    ),
) -> str:
    sources = "\n".join(
        f"  - id: {source_id}\n    resource: {resource}" for source_id, resource in refs
    )
    citations = " ".join(f"[^{source_id}]" for source_id, _ in refs)
    definitions = "\n".join(
        f"[^{source_id}]: revision-bound entry point" for source_id, _ in refs
    )
    visual = (
        "```mermaid\n"
        f"%% okf-id: {diagram[0]}\n"
        f"{diagram[1]}\n"
        f"    accTitle: {title} representation\n"
        "    accDescr: The diagram answers its planned relationship question.\n"
        "```\n\n"
        f"The diagram summarizes the planned relationship.[^{refs[0][0]}]\n\n"
        if diagram
        else ""
    )
    return (
        "---\n"
        f"type: Architecture\ntitle: {title}\n"
        "description: Open before changing this boundary.\n"
        "tags: [architecture]\ncoverage: full\n"
        f"sources:\n{sources}\n---\n\n"
        f"## Responsibility\n\n{visual}"
        f"{title} is routed by pinned entry points. {citations}\n\n"
        f"## Related concepts\n\n{links}\n\n{definitions}\n"
    )


def approve(cwd: pathlib.Path, target: str) -> None:
    packet = run(cwd, "task", "start", target)
    digest = packet.get("subject_digest")
    if not isinstance(digest, str) or len(digest) != 64:
        raise RuntimeError(f"review packet has no subject digest: {packet}")
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject": packet["subject"],
                "subject_digest": digest,
                "verdict": "approved",
                "issues": [],
            }
        ),
    )
    result = run(
        cwd,
        "task",
        "complete",
        target,
        "--attempt",
        packet["attempt"],
    )
    if not result.get("ok"):
        raise RuntimeError(f"review gate rejected {target}: {result}")


def evaluate(base: pathlib.Path) -> dict:
    ws = base / "workspace"
    ws.mkdir()
    api = source(base / "API", "api")
    web = source(base / "WebUI", "web")
    run(ws, "workspace", "init", "--lang", "en", "--freshness-days", "30")
    run(ws, "source", "add", "link", str(api), "--name", "API")
    run(ws, "source", "add", "link", str(web), "--name", "WebUI")

    started = run(
        ws,
        "run",
        "start",
        "--producer",
        "repo-wiki/e2e",
        "--session",
        "writer-1",
    )
    if ready_ids(started) != {"plan:API", "plan:WebUI"}:
        raise RuntimeError(f"run must start with Source scouts ready: {started}")

    stale = run(ws, "task", "start", "plan:API")
    search = run(
        ws,
        "task",
        "search",
        "plan:API",
        "public class",
        "--source",
        "API",
    )
    locator = search.get("results", [{}])[0].get("locator")
    if not locator or run(ws, "task", "read", "plan:API", locator)[
        "locator"
    ] != locator.replace("#L2", "#L2-L2"):
        raise RuntimeError(f"search/read locator handoff failed: {search}")
    write(
        api / "src/main/java/example/App.java",
        'package example;\npublic class App { static String name = "api-v2"; }\n',
    )
    subprocess.run(["git", "-C", str(api), "add", "."], check=True)
    subprocess.run(["git", "-C", str(api), "commit", "-qm", "refresh"], check=True)
    run(ws, "source", "refresh", "--name", "API")
    stale_result = invoke(
        ws,
        "task",
        "complete",
        "plan:API",
        "--attempt",
        stale["attempt"],
        json_output=True,
        check=False,
    )
    if stale_result.returncode == 0:
        raise RuntimeError("refresh must reject the stale Source scout attempt")

    complete(ws, "plan:API", brief("API", "WebUI"))
    complete(ws, "plan:WebUI", brief("WebUI", "API"))
    if ready_ids(run(ws, "run", "status")) != {"plan:workspace"}:
        raise RuntimeError("workspace planner became ready before all Source Briefs")

    plan = {
        "pages": [
            {
                "path": "data/api/request-flow.md",
                "type": "Flow",
                "owner": "API",
                "title": "API request flow",
                "description": "Open before changing request interactions.",
                "tags": ["flow"],
                "scopes": [{"source": "API", "paths": ["."]}],
                "evidence_seeds": ["API/src/main/java/example/App.java#L1-L2"],
                "depends_on": [],
                "diagrams": [
                    {
                        "id": "request-flow",
                        "kind": "sequence",
                        "question": "How does a request cross participants?",
                    }
                ],
            },
            {
                "path": "data/webui/app-lifecycle.md",
                "type": "Lifecycle",
                "owner": "WebUI",
                "title": "Web application lifecycle",
                "description": "Open before changing application state.",
                "tags": ["lifecycle"],
                "scopes": [{"source": "WebUI", "paths": ["."]}],
                "evidence_seeds": ["WebUI/src/main/java/example/App.java#L1-L2"],
                "depends_on": [],
                "diagrams": [
                    {
                        "id": "app-state",
                        "kind": "state",
                        "question": "How does the application change state?",
                    }
                ],
            },
            {
                "path": "data/api/data-model.md",
                "type": "DataModel",
                "owner": "API",
                "title": "API data model",
                "description": "Open before changing stored request relationships.",
                "tags": ["data-model"],
                "scopes": [{"source": "API", "paths": ["."]}],
                "evidence_seeds": ["API/src/main/java/example/App.java#L1-L2"],
                "depends_on": [],
                "diagrams": [
                    {
                        "id": "request-records",
                        "kind": "er",
                        "question": "How do application and request records relate?",
                    }
                ],
            },
            {
                "path": "architecture.md",
                "type": "Architecture",
                "owner": "workspace",
                "title": "Architecture",
                "description": "Open before cross-source changes.",
                "tags": ["architecture"],
                "scopes": [
                    {"source": "API", "paths": ["."]},
                    {"source": "WebUI", "paths": ["."]},
                ],
                "evidence_seeds": [],
                "depends_on": [
                    "data/api/request-flow.md",
                    "data/webui/app-lifecycle.md",
                    "data/api/data-model.md",
                ],
                "diagrams": [
                    {
                        "id": "component-map",
                        "kind": "flowchart",
                        "question": "How do the Sources depend on each other?",
                    }
                ],
            },
            {
                "path": "overview.md",
                "type": "Overview",
                "owner": "workspace",
                "title": "Overview",
                "description": "Open first to route work.",
                "tags": ["overview"],
                "scopes": [
                    {"source": "API", "paths": ["."]},
                    {"source": "WebUI", "paths": ["."]},
                ],
                "evidence_seeds": [],
                "depends_on": ["architecture.md"],
                "diagrams": [],
            },
        ],
        "gaps": [],
    }
    workspace_packet = run(ws, "task", "start", "plan:workspace")
    brief_inputs = {
        (item.get("target"), item.get("source"))
        for item in workspace_packet["inputs"]
        if item["role"] == "source_brief"
    }
    if brief_inputs != {("plan:API", "API"), ("plan:WebUI", "WebUI")}:
        raise RuntimeError(
            f"workspace planner did not receive both briefs: {brief_inputs}"
        )
    if workspace_packet["navigation_budget"] != {"calls": 32, "bytes": 128 * 1024}:
        raise RuntimeError("workspace synthesis budget changed")
    finish(ws, "plan:workspace", workspace_packet, json.dumps(plan))
    review = run(
        ws,
        "review",
        "start",
        "--actor",
        "repo-wiki/e2e-reviewer",
        "--session",
        "reviewer-2",
    )
    if ready_ids(review) != {"review:plan"}:
        raise RuntimeError(f"plan review did not bind: {review}")
    approve(ws, "review:plan")
    leaves = {
        "page:data/api/request-flow.md",
        "page:data/webui/app-lifecycle.md",
        "page:data/api/data-model.md",
    }
    status = run(ws, "run", "status")
    if ready_ids(status) != leaves:
        raise RuntimeError(f"only leaf pages may be ready after planning: {status}")

    api_ref = "API/src/main/java/example/App.java#L1-L2"
    web_ref = "WebUI/src/main/java/example/App.java#L1-L2"
    complete(
        ws,
        "page:data/api/request-flow.md",
        page(
            "API request flow",
            [("api", api_ref)],
            "[Workspace](/architecture.md)",
            diagram=("request-flow", "sequenceDiagram\n    API->>WebUI: Request"),
        ),
    )
    complete(
        ws,
        "page:data/webui/app-lifecycle.md",
        page(
            "Web application lifecycle",
            [("web", web_ref)],
            "[Workspace](/architecture.md)",
            diagram=("app-state", "stateDiagram-v2\n    [*] --> Ready"),
        ),
    )
    complete(
        ws,
        "page:data/api/data-model.md",
        page(
            "API data model",
            [("api", api_ref)],
            "[Workspace](/architecture.md)",
            diagram=(
                "request-records",
                "erDiagram\n    APPLICATION ||--o{ REQUEST : handles",
            ),
        ),
    )
    if "page:architecture.md" in ready_ids(run(ws, "run", "status")):
        raise RuntimeError("parent page became ready before child review")

    expected_reviews = {
        "review:data/api/request-flow.md",
        "review:data/webui/app-lifecycle.md",
        "review:data/api/data-model.md",
    }
    if ready_ids(run(ws, "run", "status")) != expected_reviews:
        raise RuntimeError(f"review session did not bind: {review}")
    approve(ws, "review:data/api/request-flow.md")
    approve(ws, "review:data/webui/app-lifecycle.md")
    approve(ws, "review:data/api/data-model.md")
    if ready_ids(run(ws, "run", "status")) != {"page:architecture.md"}:
        raise RuntimeError("Machine-confirmed children did not unlock architecture.md")

    complete(
        ws,
        "page:architecture.md",
        page(
            "Architecture",
            [("api", api_ref), ("web", web_ref)],
            "[API flow](/data/api/request-flow.md) "
            "[Web lifecycle](/data/webui/app-lifecycle.md) "
            "[Data model](/data/api/data-model.md) "
            "[Overview](/overview.md)",
        ),
    )
    if "page:overview.md" in ready_ids(run(ws, "run", "status")):
        raise RuntimeError("overview.md became ready before architecture review")
    approve(ws, "review:architecture.md")
    if ready_ids(run(ws, "run", "status")) != {"page:overview.md"}:
        raise RuntimeError("architecture review did not unlock overview.md")

    complete(
        ws,
        "page:overview.md",
        page(
            "Overview",
            [("api", api_ref), ("web", web_ref)],
            "[Architecture](/architecture.md)",
            diagram=None,
        ),
    )
    approve(ws, "review:overview.md")

    published = run(ws, "publication", "publish")
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published")
    if validation["errors"]:
        raise RuntimeError(f"published validation failed: {validation}")

    published_path = pathlib.Path(published["path"])
    manifest = json.loads((published_path / ".okf-manifest.json").read_text())
    page_digests = {
        path: entry.get("output_digest") for path, entry in manifest["pages"].items()
    }
    if not all(page_digests.values()):
        raise RuntimeError("publication manifest omitted page output digests")

    second = run(
        ws,
        "run",
        "start",
        "--producer",
        "repo-wiki/e2e",
        "--session",
        "writer-3",
    )
    return {
        "workspace": str(ws),
        "published_generation": published["generation"],
        "pages": published["pages"],
        "plan_digest": hashlib.sha256(
            json.dumps(plan, sort_keys=True).encode()
        ).hexdigest(),
        "incremental_ready_targets": sorted(ready_ids(second)),
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
