# 01 — Effective Source Ignores through Wiki Run

**What to build:** A Wiki Run materializes each Repository Snapshot with product Default Source Ignores on by default, unions them with that repository’s configured `ignore` patterns into frozen Effective Source Ignores, and records the switch plus expanded patterns so Manual Retry and publication provenance reproduce the same Snapshot membership.

**Blocked by:** None — can start immediately

**Status:** resolved

## Comments

- 2026-07-17: Implemented in source-scope-and-wiki-visualization work.

- [x] Per-repository `apply_default_source_ignores` defaults to true when omitted (YAML and single-repository CLI paths).
- [x] Host-owned Default Source Ignores catalog excludes common noise (at least dependency, venv, build, cache, coverage, and similar trees); tests are not excluded by default.
- [x] User `ignore` is always additive; a non-empty user list never turns defaults off.
- [x] Disabling defaults for a repository uses only that repository’s configured ignore list (no `!` re-include, no gitignore import).
- [x] Materialization applies Effective Source Ignores with existing repository-relative `fnmatch` semantics on tracked paths.
- [x] Wiki Run Record and publication metadata store per repository: switch, user ignore, and expanded effective ignore list.
- [x] Manual Retry rebuilds membership from the frozen effective list, not a later product default catalog; missing frozen filter data fails closed.
- [x] A change in effective ignores counts as publication provenance change even when page bytes are unchanged.
- [x] Deterministic tests cover defaults on, additive user ignore, defaults off, tests retained, noise excluded, provenance, and Manual Retry freeze.
