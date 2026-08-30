#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Run the opt-in live host eval, then grade its filesystem outcome."""

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

EVALS = pathlib.Path(__file__).resolve().parent
SKILL = EVALS.parent


def runtime_digest(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(path.rglob("*")):
        if not item.is_file() or "__pycache__" in item.parts or item.suffix == ".pyc":
            continue
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b"\0")
        digest.update(item.read_bytes())
    return digest.hexdigest()


def copy_runtime(base: pathlib.Path) -> pathlib.Path:
    target = base / f"runtime-skill-{int(time.time())}" / "repo-wiki"
    target.mkdir(parents=True)
    shutil.copy2(SKILL / "SKILL.md", target / "SKILL.md")
    for name in ("assets", "references", "scripts"):
        shutil.copytree(
            SKILL / name,
            target / name,
            ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"),
        )
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=pathlib.Path)
    parser.add_argument("host", choices=("claude", "codex"), nargs="?", default="codex")
    parser.add_argument("--scenario", choices=("killbill",), default="killbill")
    parser.add_argument("--model")
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
    runtime_skill = copy_runtime(args.base.resolve())
    initial_runtime_digest = runtime_digest(runtime_skill)
    uv_cache = ws / ".eval-uv-cache"
    uv_cache.mkdir()
    host_env = {**os.environ, "UV_CACHE_DIR": str(uv_cache)}
    prewarm = subprocess.run(
        ["uv", "run", str(runtime_skill / "scripts/okf.py"), "--help"],
        cwd=ws,
        env=host_env,
        capture_output=True,
        text=True,
        check=False,
    )
    if prewarm.returncode:
        sys.stderr.write(prewarm.stderr or prewarm.stdout)
        return prewarm.returncode
    prompt = (
        f"Workspace: {ws}. Skill: {runtime_skill}. Read only SKILL.md first, then make "
        "the skill's run status command your first Workspace inspection. Follow its "
        "bounded evidence and phase-disclosure rules. Generate and publish the Wiki for "
        "every registered Source, then export it to wiki/. Do not modify the skill."
    )
    log = ws / "host-run.log"
    if args.host == "codex":
        command = [
            "codex",
            "exec",
            "--json",
            *(["--model", args.model] if args.model else []),
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
    started = datetime.now(timezone.utc)
    before = time.monotonic()
    with log.open("w", encoding="utf-8", newline="\n") as handle:
        host_result = subprocess.run(
            command,
            stdout=handle,
            stderr=subprocess.STDOUT,
            env=host_env,
            check=False,
        )
    final_runtime_digest = runtime_digest(runtime_skill)
    metadata = {
        "started_at": started.isoformat(),
        "elapsed_seconds": round(time.monotonic() - before, 3),
        "scenario": args.scenario,
        "host": args.host,
        "model": args.model,
        "host_exit_code": host_result.returncode,
        "runtime_skill": str(runtime_skill),
        "runtime_skill_digest": initial_runtime_digest,
        "runtime_skill_unchanged": initial_runtime_digest == final_runtime_digest,
        "uv_cache": str(uv_cache),
    }
    (ws / "live-eval.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if not metadata["runtime_skill_unchanged"]:
        sys.stderr.write("runtime skill changed during eval\n")
        return 2
    return subprocess.run(
        [
            "uv",
            "run",
            str(EVALS / "grade_run.py"),
            str(ws),
            "--scenario",
            args.scenario,
        ],
        check=False,
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
