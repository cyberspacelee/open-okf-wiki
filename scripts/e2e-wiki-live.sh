#!/usr/bin/env bash
# Live Wiki generation against refs/tradingflow. Requires WIKI_E2E=1. Not in pnpm test.
set -euo pipefail

if [[ "${WIKI_E2E:-}" != "1" ]]; then
  echo "set WIKI_E2E=1 to run live generation" >&2
  exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO/extensions/wiki/index.ts"
SOURCE="${WIKI_E2E_SOURCE:-$REPO/refs/tradingflow}"
NAME="${WIKI_E2E_NAME:-tradingflow}"
WS="${WIKI_E2E_WS:-$(mktemp -d /tmp/okf-wiki-live-XXXXXX)}"
TIMEOUT="${WIKI_E2E_TIMEOUT:-1200}"

mkdir -p "$WS"
echo "workspace $WS"

PI=(pi --no-extensions -e "$EXT" -p --mode json --no-session -a --thinking low)

wiki_text() {
  ( cd "$WS" && "${PI[@]}" "/wiki $*" ) | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except json.JSONDecodeError:
        continue
    entry = o.get("entry") or {}
    if o.get("type") == "entry_appended" and entry.get("customType") == "wiki":
        print(entry.get("data", {}).get("text", ""))
'
}

fail() {
  echo "FAIL: $*" >&2
  echo "workspace: $WS" >&2
  if [[ -f "$WS/.okf-wiki/runs/"*/run.json ]]; then
    echo "--- run.json ---" >&2
    cat "$WS"/.okf-wiki/runs/*/run.json >&2 || true
  fi
  if [[ -f "$WS/host.jsonl" ]]; then
    echo "--- host.jsonl tail ---" >&2
    tail -n 30 "$WS/host.jsonl" >&2 || true
  fi
  echo "--- wiki/ ---" >&2
  ls -la "$WS/wiki" >&2 || true
  exit 1
}

wiki_text init --lang zh >/dev/null || fail "init"
wiki_text source add link "$SOURCE" --name "$NAME" >/dev/null || fail "source add"

echo "starting /wiki (timeout ${TIMEOUT}s)"
if ! ( cd "$WS" && timeout "$TIMEOUT" "${PI[@]}" "/wiki" > "$WS/host.jsonl" ); then
  fail "pi /wiki exited non-zero or timed out"
fi

python3 - "$WS" "$NAME" <<'PY' || fail "live assertions"
import json, glob, os, sys, re
ws, name = sys.argv[1], sys.argv[2]
host = open(os.path.join(ws, "host.jsonl"), encoding="utf-8").read()
texts = []
for line in host.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except json.JSONDecodeError:
        continue
    entry = o.get("entry") or {}
    if o.get("type") == "entry_appended" and entry.get("customType") == "wiki":
        texts.append(entry.get("data", {}).get("text", ""))
if not any("succeeded" in t for t in texts):
    raise SystemExit(f"host.jsonl missing succeeded, got {texts!r}")

runs = glob.glob(os.path.join(ws, ".okf-wiki", "runs", "*", "run.json"))
if len(runs) != 1:
    raise SystemExit(f"expected 1 run, got {runs}")
record = json.load(open(runs[0], encoding="utf-8"))
if record.get("status") != "succeeded":
    raise SystemExit(f"status {record.get('status')} error={record.get('error')}")
if record.get("language") != "zh":
    raise SystemExit(f"language {record.get('language')}")
if (record.get("pageCount") or 0) < 3:
    raise SystemExit(f"pageCount {record.get('pageCount')}")
if not record.get("sessionFile") or not os.path.isfile(record["sessionFile"]):
    raise SystemExit("missing sessionFile")
agents = record.get("agents") or []
if not any(a.get("agent") == "write" and a.get("status") == "complete" for a in agents):
    raise SystemExit(f"agents missing write complete: {agents!r}")

board = json.load(open(os.path.join(os.path.dirname(runs[0]), "board.json"), encoding="utf-8"))
by_id = {t["id"]: t for t in board.get("tasks") or []}
for task_id in ("survey", "write", "publish"):
    if by_id.get(task_id, {}).get("status") != "completed":
        raise SystemExit(f"board {task_id} {by_id.get(task_id)}")

wiki = os.path.join(ws, "wiki")
for rel in ("overview.md", f"{name}/source.md", "index.md"):
    path = os.path.join(wiki, rel)
    if not os.path.isfile(path):
        raise SystemExit(f"missing {rel}")
overview = open(os.path.join(wiki, "overview.md"), encoding="utf-8").read()
if not re.search(r"^type:\s*overview\s*$", overview, re.M):
    raise SystemExit("overview missing type: overview")
if "#L" not in overview:
    raise SystemExit("overview missing #L citation")
candidate = os.path.join(os.path.dirname(runs[0]), "candidate")
if os.path.isdir(candidate) and os.listdir(candidate):
    raise SystemExit(f"candidate leftover {os.listdir(candidate)}")
print(f"ok {record['id']} pages={record['pageCount']} {ws}")
PY
