#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Create the two-source Java live-eval workspace."""

import argparse
import json
import pathlib
import subprocess
import time

EVALS = pathlib.Path(__file__).resolve().parent
OKF = EVALS.parent / "scripts" / "okf.py"
SOURCES = {
    "feign": "https://github.com/OpenFeign/feign.git",
    "spring-cloud-openfeign": "https://github.com/spring-cloud/spring-cloud-openfeign.git",
}


def call(cwd: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=pathlib.Path)
    args = parser.parse_args()
    base = args.base.resolve()
    base.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        target = base / name
        if not (target / ".git").is_dir():
            call(base, "git", "clone", "-q", "--depth", "1", url, str(target))
    ws = base / f"ws-{int(time.time())}"
    ws.mkdir()
    call(ws, "uv", "run", str(OKF), "workspace", "init", "--lang", "zh")
    for name in SOURCES:
        call(
            ws,
            "uv",
            "run",
            str(OKF),
            "source",
            "add",
            "clone",
            (base / name).as_uri(),
            "--name",
            name,
            "--ref",
            "HEAD",
        )
    started = call(
        ws,
        "uv",
        "run",
        str(OKF),
        "run",
        "start",
        "--producer",
        "repo-wiki/live-eval",
        "--session",
        "live-writer",
        "--json",
    )
    status = json.loads(started.stdout)
    ready = {
        item["id"] if isinstance(item, dict) else item
        for item in status.get("ready_targets", [])
    }
    if ready != {"plan:workspace"}:
        raise RuntimeError(f"live fixture must start with one planner: {status}")
    indexes = sorted(
        pathlib.Path(status["run_dir"]).joinpath("drafts/index").glob("*.md")
    )
    if len(indexes) != len(SOURCES):
        raise RuntimeError(
            "live fixture did not create one Source outline per Revision"
        )
    for index in indexes:
        text = index.read_text(encoding="utf-8")
        if (
            index.stat().st_size > 64 * 1024
            or "inventory complete" not in text
            or "[build-module]" not in text
            or "[source-set:" not in text
        ):
            raise RuntimeError(f"unbounded or non-navigable Source outline: {index}")
    print(ws)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
