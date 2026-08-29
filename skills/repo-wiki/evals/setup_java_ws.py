#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Create a Java multi-source live-eval workspace."""

import argparse
import json
import pathlib
import subprocess
import time

EVALS = pathlib.Path(__file__).resolve().parent
OKF = EVALS.parent / "scripts" / "okf.py"
SCENARIOS = {
    "feign": {
        "feign": ("https://github.com/OpenFeign/feign.git", None),
        "spring-cloud-openfeign": (
            "https://github.com/spring-cloud/spring-cloud-openfeign.git",
            None,
        ),
    },
    "killbill": {
        "killbill": (
            "https://github.com/killbill/killbill.git",
            "cb60779c171391be558cd7aebb1eafea60ad2b82",
        ),
        "killbill-api": (
            "https://github.com/killbill/killbill-api.git",
            "7e0fe92ed1321554069877dd65850da8df9b828a",
        ),
        "killbill-commons": (
            "https://github.com/killbill/killbill-commons.git",
            "53ae7fbe7a427aba18a47ffc55bd5369e5f1ccb7",
        ),
        "killbill-platform": (
            "https://github.com/killbill/killbill-platform.git",
            "9d62015925ec1867405edb26fd70cb3cbc43350b",
        ),
    },
}


def call(cwd: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{' '.join(args)} failed ({result.returncode}): {detail}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=pathlib.Path)
    parser.add_argument("--scenario", choices=SCENARIOS, default="feign")
    args = parser.parse_args()
    base = args.base.resolve()
    base.mkdir(parents=True, exist_ok=True)
    sources = SCENARIOS[args.scenario]
    for name, (url, revision) in sources.items():
        target = base / name
        if revision:
            if not (target / ".git").is_dir():
                target.mkdir(parents=True)
                call(target, "git", "init", "-q")
                call(target, "git", "remote", "add", "origin", url)
            call(target, "git", "fetch", "-q", "--depth", "1", "origin", revision)
            call(target, "git", "checkout", "-q", "--detach", revision)
        elif not (target / ".git").is_dir():
            call(base, "git", "clone", "-q", "--depth", "1", url, str(target))
    ws = base / f"ws-{int(time.time())}"
    ws.mkdir()
    call(ws, "uv", "run", str(OKF), "workspace", "init", "--lang", "zh")
    for name in sources:
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
    expected = {f"plan:{name}" for name in sources}
    if ready != expected:
        raise RuntimeError(
            f"live fixture must start with one scout per Source: {status}"
        )
    indexes = sorted(
        pathlib.Path(status["run_dir"]).joinpath("drafts/index").glob("*.md")
    )
    if len(indexes) != len(sources):
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
