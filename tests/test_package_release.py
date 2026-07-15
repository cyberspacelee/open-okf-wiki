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
    "producer_skill/SKILL.md",
    "producer_skill/references/generate.md",
    "producer_skill/references/refresh.md",
    "producer_skill/references/review.md",
    "producer_skill/templates/architecture.md",
    "producer_skill/templates/concept.md",
    "producer_skill/templates/flow.md",
    "producer_skill/templates/module.md",
    "producer_skill/templates/overview.md",
    "security.py",
    "wiki_evaluation.py",
    "wiki_evaluation_corpus.json",
    "wiki_evaluation_fixture.py",
    "wiki_evaluation_repositories.json",
    "wiki_run.py",
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
        "Summary: Generate source-grounded Markdown Wikis from one pinned Repository Snapshot."
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
    assert "{wiki-run,wiki-eval,skill-fork,skill-inspect}" in help_result.stdout

    source = tmp_path / "source"
    source.mkdir()
    (source / "README.md").write_text("# Package fixture\n", encoding="utf-8")
    run([git, "init", "-q"], cwd=source)
    run([git, "config", "user.name", "Package Fixture"], cwd=source)
    run([git, "config", "user.email", "package@example.com"], cwd=source)
    run([git, "add", "README.md"], cwd=source)
    run([git, "commit", "-qm", "fixture"], cwd=source)
    revision = run([git, "rev-parse", "HEAD"], cwd=source).stdout.strip()

    requests: list[dict[str, object]] = []
    request_paths: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            request_paths.append(self.path)
            tool_names = [tool["function"]["name"] for tool in payload["tools"]]
            if len(requests) == 1:
                tool_name = "run_code"
                arguments = {
                    "code": """from pathlib import Path
Path('/skill/SKILL.md').read_text()
Path('/source/README.md').read_text()
Path('/wiki/index.md').write_text('---\\ntitle: Package Wiki\\n---\\n# Package Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')
"""
                }
            else:
                tool_name = next(name for name in tool_names if name.endswith("Complete"))
                arguments = {"status": "complete", "manifest": {"pages": ["index.md"]}}
            response = json.dumps(
                {
                    "id": f"chatcmpl-{len(requests)}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "package-fixture",
                    "choices": [
                        {
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
                                            "arguments": json.dumps(arguments),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
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
                source,
                "--source-revision",
                revision,
                "--staging",
                tmp_path / "staging",
                "--publication",
                publication,
                "--model",
                "openai-chat:package-fixture",
                "--request-limit",
                "3",
                "--tool-calls-limit",
                "2",
                "--retries",
                "0",
                "--request-timeout-seconds",
                "5",
                "--tool-timeout-seconds",
                "5",
                "--wall-clock-timeout-seconds",
                "30",
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
    assert len(requests) == 2
    assert request_paths == ["/v1/chat/completions", "/v1/chat/completions"]
    assert json.loads(result.stdout) == {
        "ok": True,
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
    metadata = json.loads((publication / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["source_revision"] == revision
    assert metadata["model"] == "package-fixture"
