#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Create the two-source Java live-eval workspace."""

import argparse
import pathlib
import subprocess
import time

EVALS = pathlib.Path(__file__).resolve().parent
OKF = EVALS.parent / "scripts" / "okf.py"
SOURCES = {
    "feign": "https://github.com/OpenFeign/feign.git",
    "spring-cloud-openfeign": "https://github.com/spring-cloud/spring-cloud-openfeign.git",
}


def call(cwd: pathlib.Path, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True)


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
            "--kind",
            "git",
            "--name",
            name,
            str(base / name),
        )
    call(
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
    )
    print(ws)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
