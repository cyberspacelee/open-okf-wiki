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
  if [[ -f "$WS/.okf-wiki/run/run.json" ]]; then
    echo "--- run.json ---" >&2
    cat "$WS/.okf-wiki/run/run.json" >&2 || true
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
import json, os, sys, re
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

run_dir = os.path.join(ws, ".okf-wiki", "run")
if os.path.exists(run_dir):
    raise SystemExit(f"successful Run state was not cleaned: {run_dir}")

wiki = os.path.join(ws, "wiki")
for rel in ("overview.md", "architecture.md", f"{name}/architecture.md", "index.md", "log.md"):
    path = os.path.join(wiki, rel)
    if not os.path.isfile(path):
        raise SystemExit(f"missing {rel}")
overview = open(os.path.join(wiki, "overview.md"), encoding="utf-8").read()
if not re.search(r"^type:\s*Overview\s*$", overview, re.M):
    raise SystemExit("overview missing type: Overview")
if "description:" not in overview:
    raise SystemExit("overview missing description")
if "sources:" not in overview:
    raise SystemExit("overview missing sources")
concept_pages = []
architecture_pages = []
mermaid_pages = []
for dirpath, _dirs, files in os.walk(wiki):
    for filename in files:
        if not filename.endswith(".md"):
            continue
        rel = os.path.relpath(os.path.join(dirpath, filename), wiki)
        if filename == "concept.md":
            concept_pages.append(rel)
        if filename == "architecture.md":
            architecture_pages.append(rel)
        body = open(os.path.join(dirpath, filename), encoding="utf-8").read()
        if "```mermaid" in body:
            mermaid_pages.append(rel)
if not concept_pages:
    raise SystemExit("missing concept.md")
if not architecture_pages:
    raise SystemExit("missing architecture.md")
if not mermaid_pages:
    raise SystemExit("missing mermaid diagram")
page_count = sum(
    1 for dirpath, _dirs, files in os.walk(wiki)
    for filename in files if filename.endswith(".md")
)
if page_count < 5:
    raise SystemExit(f"pageCount {page_count}")
print(f"ok pages={page_count} {ws}")
PY
