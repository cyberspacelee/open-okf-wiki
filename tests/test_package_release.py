import json
import os
import re
import selectors
import shutil
import subprocess
import sys
import tarfile
import time
from email.message import Message
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from zipfile import ZipFile

import pytest


ROOT = Path(__file__).parents[1]


def run(
    command: list[str | Path],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(item) for item in command],
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def cli(
    executable: Path,
    arguments: list[str | Path],
    *,
    cwd: Path,
    env: dict[str, str],
) -> dict:
    return json.loads(run([executable, *arguments], cwd=cwd, env=env).stdout)


def distribution_assets(names: set[str], marker: str) -> set[str]:
    return {name.split(marker, 1)[1] for name in names if marker in name}


def get(url: str, token: str | None = None) -> tuple[bytes, Message]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = Request(url, headers=headers)
    opener = build_opener(ProxyHandler({}))
    error: Exception | None = None
    for _ in range(50):
        try:
            with opener.open(request, timeout=2) as response:
                return response.read(), response.headers
        except URLError as caught:
            error = caught
            time.sleep(0.05)
    raise AssertionError(f"Packaged Console did not answer {url}: {error}")


@pytest.mark.package_release
def test_fresh_sdist_wheel_runs_console_without_a_javascript_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    uv = shutil.which("uv")
    git = shutil.which("git")
    assert uv and git
    dist = Path(os.environ.get("OKF_WIKI_RELEASE_DIST", tmp_path / "dist"))
    dist.mkdir(parents=True, exist_ok=True)

    run(
        [
            uv,
            "build",
            "--sdist",
            "--clear",
            "--no-create-gitignore",
            "--out-dir",
            dist,
            ROOT,
        ],
        cwd=ROOT,
    )
    sdist = next(dist.glob("okf_wiki-*.tar.gz"))
    run(
        [
            uv,
            "build",
            "--wheel",
            "--no-create-gitignore",
            "--out-dir",
            dist,
            sdist,
        ],
        cwd=ROOT,
    )
    wheel = next(dist.glob("okf_wiki-*.whl"))

    with tarfile.open(sdist, "r:gz") as archive:
        sdist_names = {member.name for member in archive.getmembers() if member.isfile()}
    with ZipFile(wheel) as archive:
        wheel_names = {item.filename for item in archive.infolist() if not item.is_dir()}
        index = archive.read("okf_wiki/console_assets/index.html").decode()

    sdist_assets = distribution_assets(sdist_names, "/src/okf_wiki/console_assets/")
    wheel_assets = distribution_assets(wheel_names, "okf_wiki/console_assets/")
    assert wheel_assets == sdist_assets
    assert "index.html" in wheel_assets
    assert any(
        name.startswith("assets/knowledge-page-") and name.endswith(".js") for name in wheel_assets
    )
    references = set(re.findall(r'(?:src|href)="([^"]+)"', index))
    assert references
    assert all(reference.startswith("/assets/") for reference in references)
    assert not {"http://", "https://"} & set(re.findall(r"https?://", index))
    assert {f"okf_wiki/console_assets{reference}" for reference in references} <= wheel_names

    runtime = tmp_path / "runtime"
    runtime.mkdir()
    venv = runtime / "venv"
    run([uv, "venv", "--python", sys.executable, venv], cwd=runtime)
    venv_bin = venv / ("Scripts" if os.name == "nt" else "bin")
    python = venv_bin / ("python.exe" if os.name == "nt" else "python")
    executable = venv_bin / ("okf-wiki.exe" if os.name == "nt" else "okf-wiki")
    run(
        [uv, "pip", "install", "--python", python, "--strict", "--no-sources", wheel],
        cwd=runtime,
    )

    tools = runtime / "tools"
    tools.mkdir()
    git_tool = tools / ("git.exe" if os.name == "nt" else "git")
    if os.name == "nt":
        shutil.copy2(git, git_tool)
    else:
        git_tool.symlink_to(git)
    runtime_path = os.pathsep.join((str(venv_bin), str(tools)))
    assert shutil.which("node", path=runtime_path) is None
    assert shutil.which("bun", path=runtime_path) is None

    home = runtime / "home"
    home.mkdir()
    environment = os.environ.copy()
    for name in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        environment.pop(name, None)
    environment.update(
        {
            "HOME": str(home),
            "OKF_WIKI_CONFIG_HOME": str(runtime / "machine-config"),
            "PATH": runtime_path,
            "PYTHONSAFEPATH": "1",
        }
    )
    monkeypatch.chdir(runtime)
    location = Path(
        run(
            [python, "-c", "import okf_wiki; print(okf_wiki.__file__)"],
            cwd=runtime,
            env=environment,
        ).stdout.strip()
    ).resolve()
    assert not location.is_relative_to(ROOT)

    source = runtime / "source"
    source.mkdir()
    run([git, "init", "-q"], cwd=source)
    run([git, "config", "user.name", "Package Smoke"], cwd=source)
    run([git, "config", "user.email", "package@example.com"], cwd=source)
    (source / "README.md").write_text(
        "# Package smoke\n\nThe accepted reader is served by Python.\n",
        encoding="utf-8",
    )
    run([git, "add", "README.md"], cwd=source)
    run([git, "commit", "-qm", "source"], cwd=source)

    workspace = runtime / "workspace"
    cli(
        executable,
        ["workspace", "init", "package-smoke", "--root", workspace],
        cwd=runtime,
        env=environment,
    )
    cli(
        executable,
        [
            "workspace",
            "link-source",
            "docs",
            "documentation",
            source,
            workspace,
        ],
        cwd=runtime,
        env=environment,
    )
    preflight = cli(
        executable,
        ["workspace", "preflight", workspace],
        cwd=runtime,
        env=environment,
    )
    started = cli(
        executable,
        [
            "workspace",
            "start-run",
            workspace,
            "--configuration-digest",
            preflight["configuration_digest"],
            "--source-set-digest",
            preflight["source_set_digest"],
            "--fixture",
            "success",
        ],
        cwd=runtime,
        env=environment,
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        status = cli(
            executable,
            ["workspace", "run-status", started["run_id"], workspace],
            cwd=runtime,
            env=environment,
        )
        if status["state"] == "review_required":
            break
        time.sleep(0.1)
    else:
        raise AssertionError(f"Packaged Production Run stopped in {status['state']}")
    review = cli(
        executable,
        ["workspace", "review-snapshot", started["run_id"], workspace],
        cwd=runtime,
        env=environment,
    )
    published = cli(
        executable,
        [
            "workspace",
            "review",
            started["run_id"],
            "approve",
            workspace,
            "--expected-digest",
            review["authoritative_digest"],
        ],
        cwd=runtime,
        env=environment,
    )
    assert published["state"] == "published"

    process = subprocess.Popen(
        [str(executable), "workspace", "console", str(workspace), "--no-open"],
        cwd=runtime,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        assert selector.select(10), "Packaged Console did not print its session URL"
        launch = json.loads(process.stdout.readline())
        session = urlsplit(launch["session_url"])
        origin = f"{session.scheme}://{session.netloc}"
        token = parse_qs(session.fragment)["token"][0]

        shell, headers = get(origin + "/")
        assert b"Workspace Console" in shell
        content_security_policy = headers.get("Content-Security-Policy")
        assert content_security_policy is not None
        assert content_security_policy.startswith("default-src 'none'")
        shell_references = set(re.findall(rb'(?:src|href)="([^"]+)"', shell))
        assert shell_references
        for reference in shell_references:
            assert reference.startswith(b"/assets/")
            get(origin + reference.decode())

        knowledge_asset = next(
            name.removeprefix("assets/")
            for name in wheel_assets
            if name.startswith("assets/knowledge-page-") and name.endswith(".js")
        )
        get(f"{origin}/assets/{knowledge_asset}")
        reader, _ = get(origin + "/api/v1/knowledge?bundle=published", token)
        payload = json.loads(reader)
        assert payload["selected"]["kind"] == "published"
        assert any(page["path"] == "overview.md" for page in payload["pages"])
    finally:
        process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)
