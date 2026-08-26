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
        f"## Boundary\n\nThe frozen entry points define this boundary.{citations} {links}\n\n"
        f"{definitions}\n"
    )


def evaluate(base: pathlib.Path) -> dict:
    api = source(base / "api", "api")
    web = source(base / "web", "web")
    ws = base / "workspace"
    ws.mkdir()
    run(ws, "workspace", "init", "--lang", "en", "--freshness-days", "30")
    run(ws, "source", "add", "--kind", "git", "--name", "api", str(api))
    run(ws, "source", "add", "--kind", "git", "--name", "web", str(web))
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
    snapshots = {item["name"]: item for item in status["snapshots"]}

    for name in ("api", "web"):
        complete(
            ws,
            f"inspect:{name}",
            run_dir / f"drafts/inspect/{name}.json",
            json.dumps(
                {
                    "source": name,
                    "survey_targets": [
                        {"id": f"{name}-core", "source": name, "scope": ["app.py"]}
                    ],
                }
            ),
        )
    for name in ("api", "web"):
        complete(
            ws,
            f"survey:{name}-core",
            run_dir / f"drafts/survey/{name}-core.json",
            json.dumps(
                {
                    "source": name,
                    "target": f"{name}-core",
                    "snapshot": snapshots[name]["content_hash"],
                    "findings": [
                        {
                            "id": f"{name}-entry",
                            "claim": f"{name} entry point",
                            "evidence": [f"{name}/app.py#L1-L2"],
                            "domain": "core",
                        }
                    ],
                    "gaps": [],
                    "remaining": [],
                }
            ),
        )
    complete(
        ws,
        "synthesize:workspace",
        run_dir / "drafts/synthesize.json",
        json.dumps(
            {
                "connections": [
                    {
                        "id": "web-api",
                        "source_a": "web",
                        "source_b": "api",
                        "evidence_a": ["web/app.py#L1-L2"],
                        "evidence_b": ["api/app.py#L1-L2"],
                        "contract": "fixture boundary",
                        "failure_propagation": "web receives API failure",
                    }
                ],
                "gaps": [],
            }
        ),
    )
    plan = {
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
            {
                "path": "api/architecture.md",
                "type": "Architecture",
                "owner": "api",
                "title": "API architecture",
                "description": "Open before API changes.",
                "tags": ["architecture"],
                "finding_ids": ["api-entry"],
            },
            {
                "path": "web/architecture.md",
                "type": "Architecture",
                "owner": "web",
                "title": "Web architecture",
                "description": "Open before web changes.",
                "tags": ["architecture"],
                "finding_ids": ["web-entry"],
            },
        ],
        "exclusions": [],
    }
    complete(ws, "plan:wiki", run_dir / "drafts/plan.json", json.dumps(plan))

    resources = {
        name: f"okf-source://{name}/{snapshots[name]['commit']}/app.py#L1-L2"
        for name in ("api", "web")
    }
    pages = {
        "overview.md": page(
            "Overview", [("api", resources["api"])], "[Architecture](/architecture.md)"
        ),
        "architecture.md": page(
            "Architecture",
            [("api", resources["api"]), ("web", resources["web"])],
            "[API](/api/architecture.md) [Web](/web/architecture.md)",
        ),
        "api/architecture.md": page(
            "API architecture",
            [("api", resources["api"])],
            "[Workspace](/architecture.md)",
        ),
        "web/architecture.md": page(
            "Web architecture",
            [("web", resources["web"])],
            "[Workspace](/architecture.md)",
        ),
    }
    for relative, content in pages.items():
        complete(ws, f"write:{relative}", run_dir / "candidate" / relative, content)
    for name in ("api", "web"):
        write(
            run_dir / f"proposals/agents-block-{name}.md",
            "<!-- okf-wiki:begin run=e2e -->\n- Read the Wiki first.\n<!-- okf-wiki:end -->\n",
        )
    run(ws, "task", "start", "derive:proposals")
    run(ws, "task", "complete", "derive:proposals")

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
    report = run_dir / "review.json"
    write(
        report,
        json.dumps(
            {
                "candidate_digest": packet["candidate_digest"],
                "verdict": "approved",
                "issues": [],
            }
        ),
    )
    run(ws, "review", "submit", "--report", str(report))
    published = run(ws, "publication", "publish", json_output=True)
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published", json_output=True)
    if validation["errors"]:
        raise RuntimeError(f"published validation failed: {validation}")
    verified = run(
        ws,
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
    if second["current_phase"] != "derive":
        raise RuntimeError(f"incremental reuse stopped at {second['current_phase']}")
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
