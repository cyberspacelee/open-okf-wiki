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
    args = parser.parse_args()
    if os.environ.get("WIKI_EVAL") != "1":
        parser.error("set WIKI_EVAL=1; this eval spends real model tokens")
    setup = subprocess.run(
        ["uv", "run", str(EVALS / "setup_java_ws.py"), str(args.base)],
        check=True,
        capture_output=True,
        text=True,
    )
    ws = pathlib.Path(setup.stdout.strip().splitlines()[-1])
    prompt = (
        f"Workspace: {ws}. Skill: {SKILL}. Read SKILL.md and follow it strictly. "
        "The two-source run is open at inspect. Stay coordinator-only: delegate every "
        "content target to a worker using the task-start dispatch packet, consume only its "
        "path handoff, repair every rejected target, use a distinct review worker, publish "
        "the generation and export wiki/. Do not modify the skill."
    )
    log = ws / "host-run.log"
    if args.host == "codex":
        command = [
            "codex",
            "exec",
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
