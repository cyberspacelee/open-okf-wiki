# 02 — Build a multi-repository Source Set

**What to build:** A Producer Project can pin multiple named repositories with different source roles into one Source Set and produce one combined, reproducible run whose source identities and evidence locators remain unambiguous.

**Blocked by:** 01 — Build the minimal Production Run walking skeleton.

**Status:** ready-for-agent

- [ ] A Producer Project accepts multiple named Git sources, roles, and exact revisions.
- [ ] Each Source Snapshot is immutable and records a reproducible revision and digest.
- [ ] Git tracked files define each Source Snapshot; dirty and untracked content is excluded by default.
- [ ] Tracked files remain visible even if a later ignore pattern matches them.
- [ ] The Source Universe is the union of all named Source Snapshots.
- [ ] Evidence identity includes source ID, revision, path, Source Unit, and span.
- [ ] Status and coverage output identify every participating source and revision.
- [ ] A combined minimal Bundle can be reviewed and published from at least two repositories.
