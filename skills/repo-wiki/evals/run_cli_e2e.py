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
    if not all(key in packet for key in ("attempt", "artifact", "complete_command")):
        raise RuntimeError(f"incomplete dispatch packet for {target}: {sorted(packet)}")
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


def page(title: str, refs: list[tuple[str, str]], links: str) -> str:
    sources = "\n".join(
        f"  - id: {source_id}\n    resource: {resource}" for source_id, resource in refs
    )
    citations = " ".join(f"[^{source_id}]" for source_id, _ in refs)
    definitions = "\n".join(
        f"[^{source_id}]: revision-bound entry point" for source_id, _ in refs
    )
    return (
        "---\n"
        f"type: Architecture\ntitle: {title}\n"
        "description: Open before changing this boundary.\n"
        "tags: [architecture]\ncoverage: full\n"
        f"sources:\n{sources}\n---\n\n"
        f"## Responsibility\n\n{title} is routed by pinned entry points. {citations}\n\n"
        f"## Related concepts\n\n{links}\n\n{definitions}\n"
    )


def approve(cwd: pathlib.Path, target: str, page_path: str) -> None:
    packet = run(cwd, "task", "start", target)
    digest = packet.get("page_digest")
    if not isinstance(digest, str) or len(digest) != 64:
        raise RuntimeError(f"review packet has no page digest: {packet}")
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "page": page_path,
                "page_digest": digest,
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
    if ready_ids(started) != {"plan:workspace"}:
        raise RuntimeError(f"run must start with only the planner ready: {started}")

    stale = run(ws, "task", "start", "plan:workspace")
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
        "plan:workspace",
        "--attempt",
        stale["attempt"],
        json_output=True,
        check=False,
    )
    if stale_result.returncode == 0:
        raise RuntimeError("refresh must reject the stale planner attempt")

    plan = {
        "pages": [
            {
                "path": "data/api/architecture.md",
                "type": "Architecture",
                "owner": "API",
                "title": "API architecture",
                "description": "Open before API changes.",
                "tags": ["architecture"],
                "scopes": [{"source": "API", "paths": ["."]}],
                "depends_on": [],
            },
            {
                "path": "data/webui/architecture.md",
                "type": "Architecture",
                "owner": "WebUI",
                "title": "Web architecture",
                "description": "Open before web changes.",
                "tags": ["architecture"],
                "scopes": [{"source": "WebUI", "paths": ["."]}],
                "depends_on": [],
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
                "depends_on": [
                    "data/api/architecture.md",
                    "data/webui/architecture.md",
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
                "depends_on": ["architecture.md"],
            },
        ],
        "gaps": [],
    }
    complete(ws, "plan:workspace", json.dumps(plan))
    leaves = {
        "page:data/api/architecture.md",
        "page:data/webui/architecture.md",
    }
    status = run(ws, "run", "status")
    if ready_ids(status) != leaves:
        raise RuntimeError(f"only leaf pages may be ready after planning: {status}")

    api_ref = "API/src/main/java/example/App.java#L1-L2"
    web_ref = "WebUI/src/main/java/example/App.java#L1-L2"
    complete(
        ws,
        "page:data/api/architecture.md",
        page("API architecture", [("api", api_ref)], "[Workspace](/architecture.md)"),
    )
    complete(
        ws,
        "page:data/webui/architecture.md",
        page("Web architecture", [("web", web_ref)], "[Workspace](/architecture.md)"),
    )
    if "page:architecture.md" in ready_ids(run(ws, "run", "status")):
        raise RuntimeError("parent page became ready before child review")

    review = run(
        ws,
        "review",
        "start",
        "--actor",
        "repo-wiki/e2e-reviewer",
        "--session",
        "reviewer-2",
    )
    expected_reviews = {
        "review:data/api/architecture.md",
        "review:data/webui/architecture.md",
    }
    if ready_ids(run(ws, "run", "status")) != expected_reviews:
        raise RuntimeError(f"review session did not bind: {review}")
    approve(ws, "review:data/api/architecture.md", "data/api/architecture.md")
    approve(
        ws,
        "review:data/webui/architecture.md",
        "data/webui/architecture.md",
    )
    if ready_ids(run(ws, "run", "status")) != {"page:architecture.md"}:
        raise RuntimeError("Machine-confirmed children did not unlock architecture.md")

    complete(
        ws,
        "page:architecture.md",
        page(
            "Architecture",
            [("api", api_ref), ("web", web_ref)],
            "[API](/data/api/architecture.md) "
            "[Web](/data/webui/architecture.md) "
            "[Overview](/overview.md)",
        ),
    )
    if "page:overview.md" in ready_ids(run(ws, "run", "status")):
        raise RuntimeError("overview.md became ready before architecture review")
    approve(ws, "review:architecture.md", "architecture.md")
    if ready_ids(run(ws, "run", "status")) != {"page:overview.md"}:
        raise RuntimeError("architecture review did not unlock overview.md")

    complete(
        ws,
        "page:overview.md",
        page(
            "Overview",
            [("api", api_ref), ("web", web_ref)],
            "[Architecture](/architecture.md)",
        ),
    )
    approve(ws, "review:overview.md", "overview.md")

    published = run(ws, "publication", "publish")
    run(ws, "publication", "export", "--to", "wiki")
    validation = run(ws, "validate", "--published")
    if validation["errors"]:
        raise RuntimeError(f"published validation failed: {validation}")

    manifest = json.loads(
        (pathlib.Path(published["path"]) / ".okf-manifest.json").read_text()
    )
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
