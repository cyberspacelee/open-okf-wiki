# 03 — Host source inventory (accelerator only)

**What to build:** After a Repository Snapshot is materialized under Effective Source Ignores, the Host may write a deterministic source inventory Agents can read to scope large trees—without making inventory membership a second citation gate.

**Blocked by:** 01 — Effective Source Ignores through Wiki Run

**Status:** resolved

## Comments

- 2026-07-17: Implemented in source-scope-and-wiki-visualization work.

- [x] Inventory is generated only from the materialized Snapshot (already filtered); no host shell and no ripgrep.
- [x] Inventory is available to Agents in a run-local read path agreed with the Host mounts/workspace design.
- [x] Inventory generation failure is non-fatal and does not change Snapshot membership or abort a run solely for missing inventory.
- [x] Source Citation validation remains Snapshot-authoritative: a path present in the Snapshot but absent from inventory still cites successfully when otherwise valid.
- [x] Producer Skill (or a short addition) states inventory is an optional accelerator, not a membership boundary.
- [x] Deterministic tests cover inventory presence, non-fatal failure behavior, and citation independence from inventory membership.
