#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Create a Java multi-repository hub for live evaluation.

The hub is a git repository holding only the wiki; each source is a pinned
clone in an ignored child directory. Prints the hub path.
"""

import argparse
import json
import pathlib
import subprocess
import time

EVALS = pathlib.Path(__file__).resolve().parent
OKF = EVALS.parent / "scripts" / "okf.py"
SCENARIOS = {
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
    parser.add_argument("--scenario", choices=SCENARIOS, default="killbill")
    args = parser.parse_args()
    base = args.base.resolve()
    base.mkdir(parents=True, exist_ok=True)
    sources = SCENARIOS[args.scenario]
    hub = base / f"hub-{int(time.time())}"
    hub.mkdir()
    call(hub, "git", "init", "-q", "-b", "main")
    for name, (url, revision) in sources.items():
        target = hub / name
        target.mkdir()
        call(target, "git", "init", "-q")
        call(target, "git", "remote", "add", "origin", url)
        try:
            call(target, "git", "fetch", "-q", "--depth", "1", "origin", revision)
        except RuntimeError:  # transient network failure: retry once
            time.sleep(5)
            call(target, "git", "fetch", "-q", "--depth", "1", "origin", revision)
        call(target, "git", "checkout", "-q", "--detach", revision)
    okf = ["uv", "run", str(OKF)]
    init = ["init", "--lang", "zh", "--hub"]
    for name in sources:
        init += ["--source", name]
    call(hub, *okf, *init)
    call(hub, "git", "add", "-A")
    call(hub, "git", "-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-q", "-m", "wiki stubs")
    status = json.loads(call(hub, *okf, "status", "--json").stdout)
    if status["phase"] != "discover":
        raise RuntimeError(f"live fixture must start in discover: {status}")
    scan = json.loads(call(hub, *okf, "scan", "--json").stdout)
    names = {module["source"] for module in scan["modules"]}
    if names != set(sources):
        raise RuntimeError(f"scan did not find modules in every source: {sorted(names)}")
    print(hub)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
