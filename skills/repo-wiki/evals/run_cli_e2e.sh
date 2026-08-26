#!/usr/bin/env bash
# Tier-1 deterministic e2e: exercises the okf.py CLI contract without any LLM.
# Verifies every State Gate actually bites. Exit 0 = contract holds.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OKF="$SKILL_DIR/scripts/okf.py"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

cd "$SANDBOX"
git init -q repo-a && git init -q repo-b
touch repo-a/main.py repo-b/app.py
mkdir ws && cd ws

# --- workspace + sources
uv run "$OKF" init --lang zh >/dev/null
expect_fail uv run "$OKF" init --lang zh                      # re-init rejected
uv run "$OKF" source add ../repo-a --name api >/dev/null
uv run "$OKF" source add ../repo-b --name web >/dev/null
expect_fail uv run "$OKF" source add ../repo-a --name api     # duplicate rejected

# --- run lifecycle and gates
uv run "$OKF" state init >/dev/null
expect_fail uv run "$OKF" state init                          # double init rejected
uv run "$OKF" state start --phase inspect --target ws >/dev/null
uv run "$OKF" state complete --phase inspect --target ws >/dev/null
expect_fail uv run "$OKF" state start --phase synthesize --target x  # survey gate

uv run "$OKF" state start --phase survey --target api >/dev/null
mkdir -p .okf-wiki/drafts/survey
draft() { printf '## Area\n%s\n\n## Domains\n### core\n- Title: t\n\n## Leads\nnone\n\n## Remaining\n%s\n\n## Gaps\nnone\n' "$1" "$2"; }
draft api "not done yet" > .okf-wiki/drafts/survey/api.md
expect_fail uv run "$OKF" state complete --phase survey --target api  # Remaining gate
draft api none > .okf-wiki/drafts/survey/api.md
uv run "$OKF" state complete --phase survey --target api >/dev/null
uv run "$OKF" state start --phase survey --target web >/dev/null
draft web none > .okf-wiki/drafts/survey/web.md
uv run "$OKF" state complete --phase survey --target web >/dev/null

mkdir -p .okf-wiki/drafts/synthesize
printf '## Topology\nt\n\n## Connections\n### web -> api\n- REST\n\n## Unverified leads\nnone\n\n## Remaining\nnone\n\n## Gaps\nnone\n' > .okf-wiki/drafts/synthesize/workspace.md
uv run "$OKF" state start --phase synthesize --target workspace >/dev/null
uv run "$OKF" state complete --phase synthesize --target workspace >/dev/null

# --- write gates: footnote and coverage honesty
mkdir -p .okf-wiki/candidate
uv run "$OKF" state start --phase write --target overview.md >/dev/null
cat > .okf-wiki/candidate/overview.md <<'EOF'
---
type: Overview
title: t
description: d
coverage: full
sources:
  - id: m
    resource: api/main.py
---

## Scope and boundaries

api 核心[^m],但脚注无定义。

## Task entry points

- x
EOF
expect_fail uv run "$OKF" state complete --phase write --target overview.md  # footnote gate
printf '\n[^m]: api 主模块\n' >> .okf-wiki/candidate/overview.md
uv run "$OKF" state complete --phase write --target overview.md >/dev/null

# --- derive gate: managed block markers
uv run "$OKF" state start --phase derive --target proposals >/dev/null
mkdir -p .okf-wiki/proposals
printf 'no markers here\n' > .okf-wiki/proposals/agents-block-api.md
expect_fail uv run "$OKF" state complete --phase derive --target proposals
printf '<!-- okf-wiki:begin run=r-test -->\n- pointer\n<!-- okf-wiki:end -->\n' > .okf-wiki/proposals/agents-block-api.md
uv run "$OKF" state complete --phase derive --target proposals >/dev/null

# --- review gate: report + verdict required
uv run "$OKF" state start --phase review --target candidate >/dev/null
expect_fail uv run "$OKF" state complete --phase review --target candidate  # missing report
mkdir -p .okf-wiki/drafts/review
printf 'looks fine\n' > .okf-wiki/drafts/review/candidate.md
expect_fail uv run "$OKF" state complete --phase review --target candidate  # verdict gate
printf 'approved\n\nno issues\n' > .okf-wiki/drafts/review/candidate.md
uv run "$OKF" state complete --phase review --target candidate >/dev/null

# --- publish
uv run "$OKF" state start --phase publish --target wiki >/dev/null
uv run "$OKF" publish >/dev/null
uv run "$OKF" state complete --phase publish --target wiki >/dev/null
[ -f wiki/index.md ] || fail "wiki/index.md not published"
uv run "$OKF" publish >/dev/null                              # idempotent re-publish
[ -f .okf-wiki/publication/previous/index.md ] || fail "previous not retained"

echo "PASS: CLI contract e2e"
