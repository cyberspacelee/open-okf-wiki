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

from semantic_eval import QUESTIONS, judge_prompt, reader_prompt, subject_digest

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


def host_command(
    adapter: str, model: str | None, ws: pathlib.Path, prompt: str
) -> list[str]:
    if adapter == "codex":
        return [
            "codex",
            "exec",
            "--json",
            *(["--model", model] if model else []),
            "--approve-for-me",
            "--skip-git-repo-check",
            "-C",
            str(ws),
            prompt,
        ]
    return [
        "claude",
        "-p",
        prompt,
        *(["--model", model] if model else []),
        "--allowedTools",
        "Bash,Read,Write,Edit,Glob,Grep",
        "--output-format",
        "stream-json",
        "--verbose",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=pathlib.Path)
    parser.add_argument(
        "host_adapter",
        choices=("claude", "codex"),
        nargs="?",
        default="codex",
        help="live-eval adapter; this does not restrict skill runtime hosts or models",
    )
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
    policy = json.loads((ws / "workspace.json").read_text(encoding="utf-8"))["policy"]
    requested_cap = policy["agents"]["max_active_children"]
    if args.host_adapter == "codex":
        codex_config = ws / ".codex/config.toml"
        codex_config.parent.mkdir()
        codex_config.write_text(
            f"[agents]\nmax_concurrent_threads_per_session = {requested_cap}\n",
            encoding="utf-8",
            newline="\n",
        )
        concurrency_enforcement = "host-native"
        host_cap = requested_cap
    else:
        concurrency_enforcement = "coordinator"
        host_cap = None
    effective_cap = requested_cap if host_cap is None else min(requested_cap, host_cap)
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
    command = host_command(args.host_adapter, args.model, ws, prompt)
    started = datetime.now(timezone.utc)
    before = time.monotonic()
    with log.open("w", encoding="utf-8", newline="\n") as handle:
        host_result = subprocess.run(
            command,
            stdout=handle,
            stderr=subprocess.STDOUT,
            env=host_env,
            cwd=ws,
            check=False,
        )
    semantic_exit_codes = {}
    pointer_path = ws / ".okf-wiki/publication/current.json"
    if host_result.returncode == 0 and pointer_path.is_file():
        generation = json.loads(pointer_path.read_text())["generation"]
        bundle = ws / ".okf-wiki/publication/generations" / generation
        manifest = json.loads((bundle / ".okf-manifest.json").read_text())
        source_paths = {
            source["name"]: str(
                ws.joinpath(*pathlib.PurePosixPath(source["path"]).parts)
            )
            for source in json.loads((ws / "workspace.json").read_text())["sources"]
            if source["kind"] == "git"
        }
        answers_path = ws / "semantic-answers.json"
        for role in ("reader", "judge"):
            if role == "reader":
                evaluation_prompt = reader_prompt(bundle, generation, answers_path)
            else:
                if not answers_path.is_file() or semantic_exit_codes["reader"]:
                    break
                try:
                    answers = json.loads(answers_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    semantic_exit_codes["reader"] = 2
                    break
                packet_path = ws / "semantic-review-packet.json"
                packet_path.write_text(
                    json.dumps(
                        {
                            "subject_digest": subject_digest(generation, answers),
                            "questions": QUESTIONS,
                            "sources": [
                                {
                                    "name": source["name"],
                                    "path": source_paths[source["name"]],
                                    "commit": source["commit"],
                                }
                                for source in manifest["revisions"]
                            ],
                            "answers": str(answers_path),
                            "bundle": str(bundle),
                            "output": str(ws / "semantic-review.json"),
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                )
                evaluation_prompt = judge_prompt(packet_path)
            with (ws / f"semantic-{role}.log").open("w", encoding="utf-8") as handle:
                result = subprocess.run(
                    host_command(args.host_adapter, args.model, ws, evaluation_prompt),
                    cwd=ws,
                    env=host_env,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            semantic_exit_codes[role] = result.returncode
    final_runtime_digest = runtime_digest(runtime_skill)
    metadata = {
        "started_at": started.isoformat(),
        "elapsed_seconds": round(time.monotonic() - before, 3),
        "scenario": args.scenario,
        "host_adapter": args.host_adapter,
        "model": args.model,
        "host_exit_code": host_result.returncode,
        "semantic_exit_codes": semantic_exit_codes,
        "runtime_skill": str(runtime_skill),
        "runtime_skill_digest": initial_runtime_digest,
        "runtime_skill_unchanged": initial_runtime_digest == final_runtime_digest,
        "run_policy": policy,
        "concurrency_enforcement": concurrency_enforcement,
        "host_max_active_children": host_cap,
        "effective_max_active_children": effective_cap,
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
