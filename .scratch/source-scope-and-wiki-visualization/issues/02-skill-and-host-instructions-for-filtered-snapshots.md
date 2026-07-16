# 02 — Skill and Host Instructions for filtered Snapshots

**What to build:** After Effective Source Ignores are live, Host Instructions stay a short non-forkable run shell, and the Producer Skill teaches investigation against an already-filtered Snapshot without owning ignore catalogs or budgets.

**Blocked by:** 01 — Effective Source Ignores through Wiki Run

**Status:** resolved

## Comments

- 2026-07-17: Implemented in source-scope-and-wiki-visualization work.

- [x] Host Instructions continue to cover mount/trust boundaries, Producer Skill activation, and Host role limits only—not Default Source Ignores as Skill content.
- [x] Producer Skill (and relevant references) state that `/source` is already filtered, tests may be behavioral evidence, shell/ripgrep must not be used, and ignore policy is not Skill-owned.
- [x] Skill content digest and product docs stay consistent with the new guidance; Skill Fork still cannot weaken Host filters.
- [x] No platform filter catalog or materialization logic is moved into the Skill.
