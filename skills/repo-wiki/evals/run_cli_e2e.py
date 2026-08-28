#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Cross-platform deterministic CLI lifecycle evaluation."""

import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile

SKILL = pathlib.Path(__file__).resolve().parent.parent
OKF = SKILL / "scripts" / "okf.py"


def run(cwd: pathlib.Path, *args: str, json_output: bool = False) -> dict | str:
    command = ["uv", "run", str(OKF), *args]
    if json_output:
        command.append("--json")
    result = subprocess.run(
        command, cwd=cwd, capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise RuntimeError(
            f"{' '.join(command)} failed\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return json.loads(result.stdout) if json_output else result.stdout


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def source(path: pathlib.Path, name: str) -> pathlib.Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "E2E"], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "e2e@example.test"], check=True
    )
    write(path / "app.py", f"def {name}_entry():\n    return '{name}'\n")
    subprocess.run(["git", "-C", str(path), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "fixture"], check=True)
    return path


def complete(
    ws: pathlib.Path, target: str, artifact: pathlib.Path, content: str
) -> None:
    run(ws, "task", "start", target)
    write(artifact, content)
    run(ws, "task", "complete", target)


def page(title: str, refs: list[tuple[str, str]], links: str) -> str:
    sources = "\n".join(
        f"  - id: {source_name}\n    resource: {resource}"
        for source_name, resource in refs
    )
    citations = " ".join(f"[^{source_name}]" for source_name, _ in refs)
    definitions = "\n".join(
        f"[^{source_name}]: {source_name} entry point" for source_name, _ in refs
    )
    return (
        "---\n"
        f"type: Overview\ntitle: {title}\ndescription: Open before changing this boundary.\n"
        f"coverage: full\nsources:\n{sources}\n---\n\n"
        f"## Boundary\n\nThe revision-bound entry points define this boundary.{citations} {links}\n\n"
        f"{definitions}\n"
    )


def evaluate(base: pathlib.Path) -> dict:
    ws = base / "workspace"
    ws.mkdir()
    api = source(base / "API", "api")  # outside the workspace: exercises link mount
    web = source(base / "web", "web")
    source_names = {"api": "API", "webui": "WebUI"}
    run(ws, "workspace", "init", "--lang", "en", "--freshness-days", "30")
    run(ws, "source", "add", "link", str(api), "--name", "API")
    run(ws, "source", "add", "clone", web.as_uri(), "--name", "WebUI")
    status = run(
        ws,
        "run",
        "start",
        "--producer",
        "repo-wiki/e2e",
        "--session",
        "writer-1",
        json_output=True,
    )
    run_dir = pathlib.Path(status["run_dir"])
    for slug, name in source_names.items():
        target = f"triage:{slug}"
        packet = run(ws, "task", "start", target, json_output=True)
        listing = run(ws, "task", "ls", target, ".", json_output=True)
        if (
            "ls_command" not in packet
            or not listing["items"]
            or len(packet["inputs"]) != 1
            or not packet["inputs"][0].endswith(".md")
            or not pathlib.Path(packet["inputs"][0]).is_file()
        ):
            raise RuntimeError("triage dispatch must provide bounded source browsing")
        write(
            run_dir / f"drafts/triage/{slug}.json",
            json.dumps(
                {
                    "source": name,
                    "scopes": [
                        {
                            "paths": ["."],
                            "tier": "deep",
                            "orientation": f"{name} entry",
                            "themes": ["core"],
                        }
                    ],
                }
            ),
        )
        run(ws, "task", "complete", target)

    for slug, name in source_names.items():
        target = f"survey:{slug}"
        packet = run(ws, "task", "start", target, json_output=True)
        listing = run(ws, "task", "ls", target, ".", json_output=True)
        if "index" in packet or "ls_command" not in packet or not listing["items"]:
            raise RuntimeError("survey dispatch must use task-scoped browsing")
        write(
            run_dir / f"drafts/survey/{slug}.json",
            json.dumps(
                {
                    "source": name,
                    "target": slug,
                    "findings": [
                        {
                            "id": f"{slug}-entry",
                            "claim": f"{name} entry point",
                            "evidence": [f"{name}/app.py#L1-L2"],
                            "domain": "core",
                        }
                    ],
                    "gaps": [],
                }
            ),
        )
        run(ws, "task", "complete", target)
    complete(
        ws,
        "connect:api",
        run_dir / "drafts/connect/api.json",
        json.dumps(
            {
                "source": "API",
                "connections": [
                    {
                        "id": "web-api",
                        "participants": [
                            {
                                "source": "API",
                                "evidence": ["API/app.py#L1-L2"],
                            },
                            {
                                "source": "WebUI",
                                "evidence": ["WebUI/app.py#L1-L2"],
                            },
                        ],
                        "contract": "fixture boundary",
                        "failure_propagation": "web receives API failure",
                    }
                ],
                "gaps": [],
            }
        ),
    )
    complete(
        ws,
        "connect:webui",
        run_dir / "drafts/connect/webui.json",
        json.dumps({"source": "WebUI", "connections": [], "gaps": []}),
    )
    complete(
        ws,
        "plan:api",
        run_dir / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "API",
                "pages": [
                    {
                        "path": "api/architecture.md",
                        "type": "Architecture",
                        "owner": "API",
                        "title": "API architecture",
                        "description": "Open before API changes.",
                        "tags": ["architecture"],
                        "finding_ids": ["api-entry"],
                    }
                ],
                "exclusions": [],
            }
        ),
    )
    complete(
        ws,
        "plan:webui",
        run_dir / "drafts/plan/webui.json",
        json.dumps(
            {
                "source": "WebUI",
                "pages": [
                    {
                        "path": "webui/architecture.md",
                        "type": "Architecture",
                        "owner": "WebUI",
                        "title": "Web architecture",
                        "description": "Open before web changes.",
                        "tags": ["architecture"],
                        "finding_ids": ["webui-entry"],
                    }
                ],
                "exclusions": [],
            }
        ),
    )
    complete(
        ws,
        "plan:workspace",
        run_dir / "drafts/plan/workspace.json",
        json.dumps(
            {
                "source": None,
                "pages": [
                    {
                        "path": "overview.md",
                        "type": "Overview",
                        "owner": "workspace",
                        "title": "Overview",
                        "description": "Open first to route work.",
                        "tags": ["overview"],
                    },
                    {
                        "path": "architecture.md",
                        "type": "Architecture",
                        "owner": "workspace",
                        "title": "Architecture",
                        "description": "Open before cross-source changes.",
                        "tags": ["architecture"],
                        "connection_ids": ["web-api"],
                    },
                ],
                "exclusions": [],
            }
        ),
    )

    resources = {
        slug: f"{name}/app.py#L1-L2" for slug, name in source_names.items()
    }
    pages = {
        "overview.md": page(
            "Overview", [("api", resources["api"])], "[Architecture](/architecture.md)"
        ),
        "architecture.md": page(
            "Architecture",
            [("api", resources["api"]), ("webui", resources["webui"])],
            "[API](/api/architecture.md) [Web](/webui/architecture.md)",
        ),
        "api/architecture.md": page(
            "API architecture",
            [("api", resources["api"])],
            "[Workspace](/architecture.md)",
        ),
        "webui/architecture.md": page(
            "Web architecture",
            [("webui", resources["webui"])],
            "[Workspace](/architecture.md)",
        ),
    }
    for relative, content in pages.items():
        complete(ws, f"write:{relative}", run_dir / "candidate" / relative, content)
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    write_tasks = [task for task in state["tasks"].values() if task["phase"] == "write"]
    if len(write_tasks) != len(pages) or any("pages" in task["spec"] for task in write_tasks):
        raise RuntimeError("write targets must map one-to-one to planned pages")
    if not all((run_dir / f"drafts/evidence/{slug}.json").is_file() for slug in source_names):
        raise RuntimeError("survey completion did not materialize evidence caches")
    packet = run(
        ws,
        "review",
        "start",
        "--actor",
        "repo-wiki/e2e-reviewer",
        "--session",
        "reviewer-2",
        json_output=True,
    )
    for batch in packet["batches"]:
        complete(
            ws,
            batch["id"],
            run_dir / "drafts" / "review" / f"{batch['id'].split(':', 1)[1]}.json",
            json.dumps(
                {
                    "batch": batch["owner"],
                    "candidate_digest": packet["candidate_digest"],
                    "verdict": "approved",
                    "issues": [],
                }
            ),
        )
    published = run(ws, "publication", "publish", json_output=True)
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published", json_output=True)
    if validation["errors"]:
        raise RuntimeError(f"published validation failed: {validation}")
    verified = run(
        ws,
        "publication",
        "verify",
        "--actor",
        "human:e2e@example.test",
        "--page",
        "overview.md",
        json_output=True,
    )
    rolled_back = run(ws, "publication", "rollback", json_output=True)
    if rolled_back["generation"] != published["generation"]:
        raise RuntimeError("rollback did not select the previous generation")
    restored = run(ws, "publication", "rollback", json_output=True)
    if restored["generation"] != verified["generation"]:
        raise RuntimeError("second rollback did not restore the verified generation")
    second = run(
        ws,
        "run",
        "start",
        "--producer",
        "repo-wiki/e2e",
        "--session",
        "writer-3",
        json_output=True,
    )
    if second["status"] != "awaiting_review":
        raise RuntimeError(f"incremental reuse stopped at {second['status']}")
    second_run = pathlib.Path(second["run_dir"])
    if not all(
        (second_run / f"drafts/evidence/{slug}.json").is_file()
        for slug in source_names
    ):
        raise RuntimeError("incremental survey reuse did not rebuild evidence caches")
    return {
        "workspace": str(ws),
        "published_generation": published["generation"],
        "verified_generation": verified["generation"],
        "pages": published["pages"],
        "incremental_phase": second["current_phase"],
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
