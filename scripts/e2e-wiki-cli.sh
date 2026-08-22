#!/usr/bin/env bash
# CLI contract for /wiki (no LLM). Not part of pnpm test.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO/extensions/wiki/index.ts"
SOURCE="$REPO/refs/tradingflow"
WS="$(mktemp -d /tmp/okf-wiki-cli-XXXXXX)"
KEEP="${KEEP:-}"

cleanup() {
  if [[ -n "$KEEP" ]]; then
    echo "kept $WS"
    return
  fi
  rm -rf "$WS"
}
trap cleanup EXIT

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
  KEEP=1
  exit 1
}

text="$(wiki_text init --lang zh)" || fail "init failed"
[[ "$text" == *"Initialized Wiki workspace: $WS"* ]] || fail "init text: $text"
grep -q "language: zh" "$WS/workspace.yaml" || fail "workspace.yaml language"
grep -q "sources: \[\]" "$WS/workspace.yaml" || fail "workspace.yaml sources"

bad_out="$(cd "$WS" && timeout 8 pi extensions/wiki init --lang zh 2>&1 || true)"
[[ "$bad_out" == *"Unknown option"* ]] || fail "expected Unknown option, got: $bad_out"

text="$(wiki_text source add link "$SOURCE" --name tradingflow)" || fail "source add failed"
[[ "$text" == *"Added Wiki source"* ]] || fail "source add text: $text"
[[ -L "$WS/tradingflow" ]] || fail "tradingflow is not a symlink"
[[ "$(readlink "$WS/tradingflow")" == "$SOURCE" ]] || fail "symlink target"
grep -q "path: tradingflow" "$WS/workspace.yaml" || fail "yaml missing tradingflow"

text="$(wiki_text status)" || fail "status failed"
[[ "$text" == *"Wiki: no run."* ]] || fail "status empty: $text"

text="$(wiki_text runs)" || fail "removed runs command failed"
[[ "$text" == *"was removed"* ]] || fail "runs removal text: $text"

text="$(wiki_text resume stale-run-id)" || fail "resume argument validation failed"
[[ "$text" == *"does not accept arguments"* ]] || fail "resume argument text: $text"

echo "ok $WS"
