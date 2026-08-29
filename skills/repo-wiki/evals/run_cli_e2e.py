#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Deterministic end-to-end exercise of the late-binding lifecycle."""

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
        f'package example;\npublic class App {{ static String name = "{label}"; }}\n',
    )
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)
    return path


def ready(status: dict) -> set[str]:
    return set(status.get("ready_targets", []))


CHECKPOINT = """# Progress

## Completed

Indexes and relevant evidence were read.

## Findings

Findings are recorded in the artifact.

## Hypotheses

None.

## Gaps

None.

## Next actions

Submit the current artifact.
"""


def finish(
    cwd: pathlib.Path, target: str, packet: dict, content: str, checkpoint=False
) -> dict:
    replay = run(cwd, "task", "packet", target, "--attempt", packet["attempt"])
    if replay != packet:
        raise RuntimeError(f"persisted packet changed for {target}")
    write(pathlib.Path(packet["artifact"]), content)
    if checkpoint:
        write(pathlib.Path(packet["checkpoint"]), CHECKPOINT)
        run(cwd, "task", "checkpoint", target, "--attempt", packet["attempt"])
    result = run(cwd, "task", "complete", target, "--attempt", packet["attempt"])
    if not result.get("ok"):
        raise RuntimeError(f"target gate rejected {target}: {result}")
    return result


def complete(cwd: pathlib.Path, target: str, content: str, checkpoint=False) -> dict:
    return finish(cwd, target, run(cwd, "task", "start", target), content, checkpoint)


def approve(cwd: pathlib.Path, target: str) -> None:
    packet = run(cwd, "task", "start", target)
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject": packet["subject"],
                "subject_digest": packet["subject_digest"],
                "verdict": "approved",
                "issues": [],
            }
        ),
    )
    result = run(cwd, "task", "complete", target, "--attempt", packet["attempt"])
    if not result.get("ok"):
        raise RuntimeError(f"review gate rejected {target}: {result}")


def unit(
    unit_id: str, source_name: str, kind: str, sources: list[str] | None = None
) -> dict:
    names = sources or [source_name]
    return {
        "id": unit_id,
        "kind": kind,
        "owner": "workspace" if len(names) > 1 else source_name,
        "question": f"How does {unit_id} work across the captured sources?",
        "scopes": [{"source": name, "paths": ["."]} for name in names],
        "evidence_seeds": [
            f"{name}/src/main/java/example/App.java#L1-L2" for name in names
        ],
    }


def dossier(unit_id: str) -> str:
    return markdown(
        {
            "kind": "knowledge-dossier",
            "unit_id": unit_id,
            "disposition": "ready",
            "children": [],
        },
        f"# {unit_id}\n\nThe captured entry points support this knowledge boundary.",
    )


def page(
    page_id: str, refs: list[tuple[str, str]], logical_link: str, diagram=True
) -> str:
    sources = [{"id": source_id, "resource": resource} for source_id, resource in refs]
    citations = " ".join(f"[^{source_id}]" for source_id, _ in refs)
    definitions = "\n".join(
        f"[^{source_id}]: revision-bound entry point" for source_id, _ in refs
    )
    visual = (
        "```mermaid\n"
        "%% okf-id: boundaries\n"
        "flowchart LR\n"
        "    accTitle: Source boundary map\n"
        "    accDescr: API entry points connect to the web entry point.\n"
        "    API --> WebUI\n"
        "```\n\n"
        f"The dependency direction is explicit.[^{refs[0][0]}]\n\n"
        if diagram
        else ""
    )
    return markdown(
        {"type": "Overview", "coverage": "full", "sources": sources},
        f"## Responsibility\n\n{visual}The page is anchored by pinned entry points. {citations}\n\n"
        f"## Related concepts\n\n{logical_link}\n\n{definitions}",
    )


def evaluate(base: pathlib.Path) -> dict:
    ws = base / "workspace"
    ws.mkdir()
    api = source(base / "API", "api")
    web = source(base / "WebUI", "web")
    run(ws, "workspace", "init", "--lang", "en", "--freshness-days", "30")
    run(ws, "source", "add", "link", str(api), "--name", "API")
    run(ws, "source", "add", "link", str(web), "--name", "WebUI")

    started = run(
        ws, "run", "start", "--producer", "repo-wiki/e2e", "--session", "writer-1"
    )
    if ready(started) != {"plan:workspace"}:
        raise RuntimeError(f"multi-source Run must have one planner: {started}")

    first = run(ws, "task", "start", "plan:workspace")
    search = run(
        ws, "task", "search", "plan:workspace", "public class", "--source", "API"
    )
    locator = search.get("results", [{}])[0].get("locator")
    if not locator or not run(ws, "task", "read", "plan:workspace", locator).get(
        "text"
    ):
        raise RuntimeError("bounded search/read handoff failed")
    write(pathlib.Path(first["checkpoint"]), CHECKPOINT)
    run(ws, "task", "checkpoint", "plan:workspace", "--attempt", first["attempt"])
    run(ws, "task", "fail", "plan:workspace", "--reason", "exercise retry")
    retry = run(ws, "task", "start", "plan:workspace")
    if not any(item["role"] == "previous_checkpoint" for item in retry["inputs"]):
        raise RuntimeError("retry omitted durable checkpoint")

    write(
        api / "src/main/java/example/App.java",
        'package example;\npublic class App { static String name = "api-v2"; }\n',
    )
    subprocess.run(["git", "-C", str(api), "add", "."], check=True)
    subprocess.run(["git", "-C", str(api), "commit", "-qm", "refresh"], check=True)
    run(ws, "source", "refresh", "--name", "API")
    stale = invoke(
        ws,
        "task",
        "complete",
        "plan:workspace",
        "--attempt",
        retry["attempt"],
        check=False,
    )
    if stale.returncode == 0:
        raise RuntimeError("refresh accepted a stale planner attempt")

    plan = markdown(
        {
            "kind": "knowledge-plan",
            "units": [
                unit("workspace-routing", "API", "capability"),
                unit("source-boundaries", "API", "integration", ["API", "WebUI"]),
            ],
            "gaps": [],
        },
        "# Knowledge Plan\n\nThe API and WebUI expose a cross-Source boundary.",
    )
    complete(ws, "plan:workspace", plan, checkpoint=True)
    review = run(
        ws,
        "review",
        "start",
        "--actor",
        "repo-wiki/e2e-reviewer",
        "--session",
        "reviewer-2",
    )
    if ready(review) != {"review:plan"}:
        raise RuntimeError("Plan review did not become ready")
    approve(ws, "review:plan")

    for unit_id in ("workspace-routing", "source-boundaries"):
        complete(ws, f"page:research/{unit_id}", dossier(unit_id))
    if ready(run(ws, "run", "status")) != {"page:compose"}:
        raise RuntimeError("composition became ready before all dossiers")

    composition = markdown(
        {
            "kind": "composition-map",
            "pages": [
                {
                    "id": "architecture",
                    "path": "architecture.md",
                    "type": "Architecture",
                    "owner": "workspace",
                    "title": "Architecture",
                    "description": "Open before changing Source boundaries.",
                    "tags": ["architecture"],
                    "units": ["source-boundaries"],
                    "scopes": [
                        {"source": "API", "paths": ["."]},
                        {"source": "WebUI", "paths": ["."]},
                    ],
                    "evidence_seeds": [
                        "API/src/main/java/example/App.java#L1-L2",
                        "WebUI/src/main/java/example/App.java#L1-L2",
                    ],
                    "parent": None,
                    "depends_on": [],
                    "diagrams": [
                        {
                            "id": "boundaries",
                            "kind": "flowchart",
                            "question": "How do the Sources depend on each other?",
                        }
                    ],
                },
                {
                    "id": "overview",
                    "path": "overview.md",
                    "type": "Overview",
                    "owner": "workspace",
                    "title": "Overview",
                    "description": "Open first to route work.",
                    "tags": ["overview"],
                    "units": ["workspace-routing"],
                    "scopes": [{"source": "API", "paths": ["."]}],
                    "evidence_seeds": ["API/src/main/java/example/App.java#L1-L2"],
                    "parent": None,
                    "depends_on": ["architecture"],
                    "diagrams": [],
                },
            ],
            "gaps": [],
        },
        "# Composition\n\nStable page IDs are independent of publication paths.",
    )
    complete(ws, "page:compose", composition, checkpoint=True)
    approve(ws, "review:composition")

    api_ref = "API/src/main/java/example/App.java#L1-L2"
    web_ref = "WebUI/src/main/java/example/App.java#L1-L2"
    complete(
        ws,
        "page:write/architecture",
        page(
            "architecture",
            [("api", api_ref), ("web", web_ref)],
            "See [overview][overview].",
        ),
    )
    approve(ws, "review:architecture")
    complete(
        ws,
        "page:write/overview",
        page(
            "overview",
            [("api", api_ref)],
            "See [architecture][architecture].",
            diagram=False,
        ),
    )
    approve(ws, "review:overview")

    published = run(ws, "publication", "publish")
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published")
    if validation["errors"]:
        raise RuntimeError(f"published validation failed: {validation}")
    overview = pathlib.Path(published["path"]) / "overview.md"
    if "](/architecture.md)" not in overview.read_text(encoding="utf-8"):
        raise RuntimeError("logical page ID was not bound to the final path")

    second = run(
        ws, "run", "start", "--producer", "repo-wiki/e2e", "--session", "writer-3"
    )
    return {
        "workspace": str(ws),
        "published_generation": published["generation"],
        "pages": published["pages"],
        "incremental_ready_targets": sorted(ready(second)),
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
