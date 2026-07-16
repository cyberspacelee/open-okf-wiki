# 09 — Configure multi-repository Wiki Runs

**What to build:** A repository owner can keep provider secrets in the process environment and use one non-secret YAML file to generate or refresh a Wiki from multiple named local repositories, branches, exact revisions, and explicit ignore patterns.

**Blocked by:** 08 — Finalize the greenfield package and documentation.

**Status:** ready-for-agent

- [x] Ship an ignored `.env` convention and tracked `.env.example`; local CLI runs load it without overriding externally supplied environment variables.
- [x] Reject credentials, tokens, passwords, and provider headers from Wiki Run YAML without echoing their values.
- [x] `wiki-run --config` accepts relative output paths, model selection, limits, an optional Skill Version, and one or more uniquely named repositories.
- [x] Each repository selects exactly one local branch or exact revision; branches freeze to complete commits before model work.
- [x] Explicit standard-library `fnmatch` patterns remove repository-relative tracked POSIX paths before source quotas and materialization.
- [x] Multiple Repository Snapshots remain read-only below `/source/<repository-id>` while only the Staging Wiki is writable.
- [x] Multi-repository Source Citations include the repository ID and fail validation when the ID is missing or unknown.
- [x] Publication metadata records every repository ID, exact revision, and ignore set.
- [x] Direct single-repository CLI usage remains available as the shortest path.
- [x] A fresh-wheel test completes a multi-repository YAML Wiki Run through the installed public CLI.

## Comments

- Implemented in `6d6b54e` and hardened after review: YAML secret-key detection now covers snake_case and camelCase forms without echoing values; ignored Git tree entries are filtered before non-file rejection.
- Verification: 118 non-package tests passed, fresh-wheel package E2E passed, Ruff, ty, lock, Markdown-link, and diff checks passed.
- Follow-up: local `.env` loading now prefers the Wiki Run YAML directory, falls back to the current directory, and preserves process/secret-manager precedence.
