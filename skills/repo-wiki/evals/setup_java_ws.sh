#!/usr/bin/env bash
# Fixture: two related Java repos (feign + spring-cloud-openfeign) in a fresh
# workspace, run opened, ready for a host agent. Prints the workspace path.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OKF="$SKILL_DIR/scripts/okf.py"
BASE="${1:?usage: setup_java_ws.sh <base-dir>}"
mkdir -p "$BASE"

clone() {  # cached shallow clone: re-runs reuse the checkout
  local url="$1" dir="$2"
  [ -d "$BASE/$dir/.git" ] || git clone -q --depth 1 "$url" "$BASE/$dir"
}
clone https://github.com/OpenFeign/feign.git feign
clone https://github.com/spring-cloud/spring-cloud-openfeign.git spring-cloud-openfeign

WS="$BASE/ws-$(date +%s)"
mkdir -p "$WS" && cd "$WS"
uv run "$OKF" init --lang zh >/dev/null
uv run "$OKF" source add "$BASE/feign" --name feign >/dev/null
uv run "$OKF" source add "$BASE/spring-cloud-openfeign" --name spring-cloud-openfeign >/dev/null
uv run "$OKF" state init >/dev/null
echo "$WS"
