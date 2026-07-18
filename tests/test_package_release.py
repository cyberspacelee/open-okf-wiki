import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zipfile import ZipFile

import pytest


ROOT = Path(__file__).parents[1]
PACKAGE_FILES = {
    "__init__.py",
    "__main__.py",
    "cli.py",
    "diagnostics/__init__.py",
    "diagnostics/doctor.py",
    "diagnostics/preflight.py",
    "evaluation/__init__.py",
    "evaluation/wiki_evaluation.py",
    "evaluation/wiki_evaluation_corpus.json",
    "evaluation/wiki_evaluation_fixture.py",
    "evaluation/wiki_evaluation_repositories.json",
    "host/__init__.py",
    "host/adaptive/__init__.py",
    "host/adaptive/agents.py",
    "host/adaptive/deps.py",
    "host/adaptive/orchestration.py",
    "host/adaptive/policy.py",
    "host/adaptive/receipts.py",
    "host/adaptive/reviewer.py",
    "host/analysis/__init__.py",
    "host/analysis/workspace.py",
    "host/config.py",
    "host/context.py",
    "host/errors.py",
    "host/init_config.py",
    "host/lifecycle.py",
    "host/models.py",
    "host/mounts.py",
    "host/prepare.py",
    "host/provider/__init__.py",
    "host/provider/env.py",
    "host/provider/retry.py",
    "host/publication/__init__.py",
    "host/publication/finalize.py",
    "host/publication/fs.py",
    "host/publication/gate.py",
    "host/publication/status.py",
    "host/records.py",
    "host/security.py",
    "host/skill.py",
    "host/snapshots.py",
    "host/validation.py",
    "producer_skill/SKILL.md",
    "producer_skill/references/domain-research.md",
    "producer_skill/references/generate.md",
    "producer_skill/references/leaf-research.md",
    "producer_skill/references/refresh.md",
    "producer_skill/references/review.md",
    "producer_skill/templates/architecture.md",
    "producer_skill/templates/concept.md",
    "producer_skill/templates/flow.md",
    "producer_skill/templates/module.md",
    "producer_skill/templates/overview.md",
    "session/__init__.py",
    "session/app.py",
    "session/cards.py",
    "session/interactive.py",
    "session/runtime.py",
    "session/store.py",
    "session/stream.py",
    "session/tty.py",
    "viz/__init__.py",
    "viz/generate.py",
}


def run(
    command: list[str | Path],
    *,
    cwd: Path,
    check: bool = True,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(item) for item in command],
        cwd=cwd,
        check=check,
        capture_output=True,
        env=env,
        text=True,
        timeout=timeout,
    )


def make_repository(path: Path, branch: str, files: dict[str, str], git: str) -> str:
    path.mkdir()
    run([git, "init", "-q", "-b", branch], cwd=path)
    run([git, "config", "user.name", "Package Fixture"], cwd=path)
    run([git, "config", "user.email", "package@example.com"], cwd=path)
    for relative, content in files.items():
        destination = path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
    run([git, "add", "."], cwd=path)
    run([git, "commit", "-qm", "fixture"], cwd=path)
    return run([git, "rev-parse", "HEAD"], cwd=path).stdout.strip()


@pytest.mark.package_release
def test_fresh_wheel_completes_a_wiki_run_through_the_installed_cli(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    git = shutil.which("git")
    assert uv is not None and git is not None
    dist = Path(os.environ.get("OKF_WIKI_RELEASE_DIST", tmp_path / "dist"))
    dist.mkdir(parents=True, exist_ok=True)

    run(
        [uv, "build", "--sdist", "--clear", "--no-create-gitignore", "--out-dir", dist, ROOT],
        cwd=ROOT,
    )
    sdist = next(dist.glob("okf_wiki-*.tar.gz"))
    run(
        [uv, "build", "--wheel", "--no-create-gitignore", "--out-dir", dist, sdist],
        cwd=ROOT,
    )
    wheel = next(dist.glob("okf_wiki-*.whl"))

    with tarfile.open(sdist, "r:gz") as archive:
        source_names = {member.name for member in archive.getmembers() if member.isfile()}
    with ZipFile(wheel) as archive:
        wheel_names = {member.filename for member in archive.infolist() if not member.is_dir()}
        metadata_name = next(name for name in wheel_names if name.endswith(".dist-info/METADATA"))
        wheel_metadata = archive.read(metadata_name).decode()

    source_package = {
        name.split("/src/okf_wiki/", 1)[1] for name in source_names if "/src/okf_wiki/" in name
    }
    wheel_package = {
        name.removeprefix("okf_wiki/") for name in wheel_names if name.startswith("okf_wiki/")
    }
    assert source_package == PACKAGE_FILES
    assert wheel_package == PACKAGE_FILES
    assert not any("/console/" in name for name in source_names)
    assert (
        "Summary: Generate source-grounded Markdown Wikis from a pinned Repository Snapshot Set."
        in wheel_metadata
    )
    assert "Requires-Dist: pydantic-monty==0.0.18" in wheel_metadata

    venv = tmp_path / "venv"
    run([uv, "venv", "--python", sys.executable, venv], cwd=tmp_path)
    python = venv / "bin/python"
    executable = venv / "bin/okf-wiki"
    run(
        [uv, "pip", "install", "--python", python, "--strict", "--no-sources", wheel],
        cwd=tmp_path,
    )

    help_result = run([executable, "--help"], cwd=tmp_path)
    assert (
        "{init,wiki-run,wiki-retry,tui,wiki-eval,skill-fork,skill-inspect,viz,doctor}"
        in help_result.stdout
    )

    application = tmp_path / "application"
    application_revision = make_repository(
        application,
        "main",
        {"README.md": "# Application\n", "ignored.txt": "do not expose\n"},
        git,
    )
    documentation = tmp_path / "documentation"
    documentation_revision = make_repository(
        documentation,
        "stable",
        {"README.md": "# Documentation\n", "drafts/private.md": "ignore this draft\n"},
        git,
    )
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        """version: 1
operation: generate
model: openai-chat:package-fixture
staging: ./staging
publication: ./published
limits:
  request_limit: 3
  tool_calls_limit: 2
  retries: 0
  request_timeout_seconds: 5
  tool_timeout_seconds: 5
  wall_clock_timeout_seconds: 30
  source_files_limit: 2
repositories:
  - id: app
    path: ./application
    branch: main
    ignore:
      - ignored.txt
  - id: docs
    path: ./documentation
    branch: stable
    ignore:
      - drafts/**
""",
        encoding="utf-8",
    )

    requests: list[dict[str, object]] = []
    request_paths: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            request_paths.append(self.path)
            tool_names = [tool["function"]["name"] for tool in payload.get("tools") or []]
            messages = payload.get("messages") or []
            system_text = " ".join(
                str(message.get("content") or "")
                for message in messages
                if message.get("role") == "system"
            )
            has_tool_return = any(message.get("role") == "tool" for message in messages)
            complete_tools = [name for name in tool_names if name.endswith("Complete")]
            # Host Wiki Reviewer has CodeMode only (no Complete output tool).
            if "You are a Wiki Reviewer." in system_text or (
                not complete_tools and "run_code" in tool_names
            ):
                if has_tool_return:
                    # Return Handoff Ref text printed by sandbox publish_receipt.
                    last_tool = next(
                        (
                            message.get("content")
                            for message in reversed(messages)
                            if message.get("role") == "tool"
                        ),
                        "{}",
                    )
                    choice = {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": str(last_tool).strip() or "{}",
                        },
                        "finish_reason": "stop",
                    }
                else:
                    # Extract Host assignment from system/instructions text.
                    import re

                    assignment = re.search(
                        r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), "
                        r"parent_id=([^,]+), attempt=(\d+)",
                        system_text
                        + " ".join(
                            str(message.get("content") or "")
                            for message in messages
                            if message.get("role") == "user"
                        ),
                    )
                    if assignment is None:
                        # Fall back: still attempt a no-op receipt if assignment is elsewhere.
                        for message in messages:
                            text = str(message.get("content") or "")
                            assignment = re.search(
                                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), "
                                r"parent_id=([^,]+), attempt=(\d+)",
                                text,
                            )
                            if assignment is not None:
                                break
                    assert assignment is not None, "reviewer Host assignment missing from prompt"
                    run_id, task_id, node_id, parent_id, attempt = assignment.groups()
                    code = (
                        "handoff = publish_receipt("
                        f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                        f"attempt={int(attempt)}, status='complete', "
                        f"scope='review:{task_id}', summary='package review ok', findings=[])\n"
                        "print(handoff)"
                    )
                    choice = {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": f"call-{len(requests)}",
                                    "type": "function",
                                    "function": {
                                        "name": "run_code",
                                        "arguments": json.dumps({"code": code}),
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
            elif not has_tool_return:
                choice = {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"call-{len(requests)}",
                                "type": "function",
                                "function": {
                                    "name": "run_code",
                                    "arguments": json.dumps(
                                        {
                                            "code": """from pathlib import Path
Path('/skill/SKILL.md').read_text()
Path('/source/app/README.md').read_text()
Path('/source/docs/README.md').read_text()
assert not Path('/source/app/ignored.txt').exists()
assert not Path('/source/docs/drafts/private.md').exists()
Path('/wiki/index.md').write_text('---\\ntitle: Package Wiki\\n---\\n# Package Wiki\\n\\n[Application](repo:app/README.md#L1-L1) [Documentation](repo:docs/README.md#L1-L1)\\n')
"""
                                        }
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            else:
                tool_name = complete_tools[0]
                choice = {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"call-{len(requests)}",
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": json.dumps(
                                        {
                                            "status": "complete",
                                            "manifest": {"pages": ["index.md"]},
                                        }
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            response = json.dumps(
                {
                    "id": f"chatcmpl-{len(requests)}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "package-fixture",
                    "choices": [choice],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    environment = os.environ.copy()
    environment.update(
        {
            "NO_PROXY": "127.0.0.1,localhost",
            "OPENAI_API_KEY": "package-fixture-key",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
        }
    )
    publication = tmp_path / "published"
    try:
        result = run(
            [
                executable,
                "wiki-run",
                "--config",
                config,
                # Non-interactive package fixture: auto-approve deferred publication.
                "--yes",
            ],
            cwd=tmp_path,
            check=False,
            env=environment,
            timeout=60,
        )
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    assert result.returncode == 0, result.stderr or result.stdout
    # Producer (run_code + Complete) plus Host Wiki Reviewer (run_code + handoff).
    assert len(requests) >= 2
    assert all(path == "/v1/chat/completions" for path in request_paths)
    assert json.loads(result.stdout) == {
        "ok": True,
        "run_status": "complete",
        "result": {
            "manifest": {"pages": ["index.md"]},
            "status": "complete",
            "summary": {
                "added": ["index.md"],
                "changed": [],
                "content_changed": True,
                "publication_changed": True,
                "removed": [],
                "unchanged": [],
            },
        },
    }
    assert (
        (publication / "index.md")
        .read_text(encoding="utf-8")
        .startswith("---\ntitle: Package Wiki\n---")
    )
    from okf_wiki.host import resolve_effective_source_ignores

    metadata = json.loads((publication / ".okf-wiki.json").read_text(encoding="utf-8"))

    def expected_repo(repo_id: str, revision: str, ignore: list[str]) -> dict[str, object]:
        return {
            "id": repo_id,
            "ignore": ignore,
            "revision": revision,
            "apply_default_source_ignores": True,
            "effective_ignore": list(
                resolve_effective_source_ignores(
                    apply_default_source_ignores=True,
                    user_ignore=tuple(ignore),
                )
            ),
        }

    assert metadata["repositories"] == [
        expected_repo("app", application_revision, ["ignored.txt"]),
        expected_repo("docs", documentation_revision, ["drafts/**"]),
    ]
    assert metadata["model"] == "package-fixture"
