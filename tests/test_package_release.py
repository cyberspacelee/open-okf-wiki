import os
import shutil
import subprocess
import sys
import tarfile
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
RETIRED_MODULES = {
    "accepted_knowledge",
    "agent_evals",
    "benchmark",
    "bundle",
    "console",
    "coverage",
    "gateway_profiles",
    "knowledge",
    "planner",
    "query_agent",
    "refresh",
    "review",
    "scheduler",
    "verifier",
    "worker",
    "workspace",
}


def run(command: list[str | Path], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(item) for item in command],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.mark.package_release
def test_source_and_wheel_ship_only_the_wiki_run_product(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    assert uv is not None
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

    source_package = {
        name.split("/src/okf_wiki/", 1)[1] for name in source_names if "/src/okf_wiki/" in name
    }
    wheel_package = {
        name.removeprefix("okf_wiki/") for name in wheel_names if name.startswith("okf_wiki/")
    }
    assert source_package == PACKAGE_FILES
    assert wheel_package == PACKAGE_FILES
    assert not any("/console/" in name for name in source_names)

    imported = run(
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import importlib.util,sys;"
                "sys.path.insert(0,sys.argv[1]);"
                "import okf_wiki.cli;"
                "retired=set(sys.argv[2:]);"
                "assert not {name for name in sys.modules if name.removeprefix('okf_wiki.') in retired};"
                "assert all(importlib.util.find_spec('okf_wiki.'+name) is None for name in retired)"
            ),
            wheel,
            *sorted(RETIRED_MODULES),
        ],
        cwd=tmp_path,
    )
    assert imported.stdout == ""

    help_result = run(
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import runpy,sys;"
                "sys.path.insert(0,sys.argv[1]);"
                "sys.argv=['okf-wiki','--help'];"
                "runpy.run_module('okf_wiki',run_name='__main__')"
            ),
            wheel,
        ],
        cwd=tmp_path,
    )
    assert "{wiki-run,wiki-eval,skill-fork,skill-inspect}" in help_result.stdout
