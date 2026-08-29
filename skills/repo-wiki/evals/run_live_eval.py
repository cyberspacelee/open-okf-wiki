#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Run the opt-in live host eval, then grade its filesystem outcome."""

import argparse
import os
import pathlib
import subprocess
import sys

EVALS = pathlib.Path(__file__).resolve().parent
SKILL = EVALS.parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=pathlib.Path)
    parser.add_argument("host", choices=("claude", "codex"), nargs="?", default="codex")
    parser.add_argument("--scenario", choices=("feign", "killbill"), default="feign")
    args = parser.parse_args()
    if os.environ.get("WIKI_EVAL") != "1":
        parser.error("set WIKI_EVAL=1; this eval spends real model tokens")
    setup = subprocess.run(
        [
            "uv",
            "run",
            str(EVALS / "setup_java_ws.py"),
            str(args.base),
            "--scenario",
            args.scenario,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if setup.returncode:
        sys.stderr.write(setup.stderr or setup.stdout)
        return setup.returncode
    ws = pathlib.Path(setup.stdout.strip().splitlines()[-1])
    prompt = (
        f"Workspace: {ws}. Scenario: {args.scenario}. Skill: {SKILL}. "
        "Read SKILL.md and follow it strictly. "
        "Keep one long-lived planner responsible for the cross-Source model; use focused "
        "evidence workers only for independent bounded questions. Maintain the fixed Plan "
        "and progress Artifacts, dispatch independent page writers in parallel, and keep "
        "running the status loop through every validation or review repair. Use bounded "
        "evidence commands instead of inspecting run internals. Dispatch the prepared Wiki "
        "bundle to one fresh independent reviewer, publish the approved generation and "
        "export wiki/. Do not "
        "modify the skill."
    )
    log = ws / "host-run.log"
    if args.host == "codex":
        command = [
            "codex",
            "exec",
            "--json",
            "--approve-for-me",
            "--skip-git-repo-check",
            "-C",
            str(ws),
            prompt,
        ]
    else:
        command = [
            "claude",
            "-p",
            prompt,
            "--allowedTools",
            "Bash,Read,Write,Edit,Glob,Grep",
            "--output-format",
            "stream-json",
            "--verbose",
        ]
    with log.open("w", encoding="utf-8", newline="\n") as handle:
        subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT, check=False)
    return subprocess.run(
        ["uv", "run", str(EVALS / "grade_run.py"), str(ws)], check=False
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
