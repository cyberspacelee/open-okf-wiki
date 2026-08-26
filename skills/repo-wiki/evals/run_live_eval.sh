#!/usr/bin/env bash
# Tier-2 live eval: a real host agent runs the skill end-to-end on the Java
# fixture, then the deterministic grader checks the outcome.
#
#   ./run_live_eval.sh <base-dir> [claude|codex]
#
# Requires WIKI_EVAL=1 (spends real tokens, ~20-30 min per trial).
set -euo pipefail

[ "${WIKI_EVAL:-}" = "1" ] || { echo "set WIKI_EVAL=1 to run (spends tokens)"; exit 2; }

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$EVALS_DIR")"
BASE="${1:?usage: run_live_eval.sh <base-dir> [claude|codex]}"
HOST="${2:-claude}"

WS="$("$EVALS_DIR/setup_java_ws.sh" "$BASE")"
echo "workspace: $WS"

PROMPT="You are the host agent for the repo-wiki skill.
Workspace: $WS (already initialized: two sources, run opened, phase=inspect).
Skill directory: $SKILL_DIR
First read $SKILL_DIR/SKILL.md, then follow it strictly. Run every okf.py
command from inside the workspace directory. You have no subagents: take the
serial 'Without subagents' path, one target at a time. Before each phase read
its references/<phase>.md; before writing pages read references/contract.md.
Keep the wiki thin (<=10 content pages). Cite only files you actually opened.
Never bypass a rejected 'state complete': read the issues, fix, retry.
Do not modify anything under $SKILL_DIR. Finish by publishing."

LOG="$WS/host-run.log"
case "$HOST" in
  claude)
    claude -p "$PROMPT" \
      --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
      --output-format stream-json --verbose > "$LOG" 2>&1 || true
    ;;
  codex)
    codex exec --full-auto -C "$WS" "$PROMPT" > "$LOG" 2>&1 || true
    ;;
  *) echo "unknown host: $HOST"; exit 2 ;;
esac
echo "host log: $LOG ($(wc -l < "$LOG") lines)"

echo "--- grading (deterministic, outcome-based) ---"
uv run "$EVALS_DIR/grade_run.py" "$WS"
