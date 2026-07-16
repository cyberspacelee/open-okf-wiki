# 05 — Optional post-publish viz and TUI path report

**What to build:** After a successful Wiki Run publication, visualization may be generated optionally; failure must not unpublish, and operators see where visualization was written—while `wiki-run` JSON and the TUI remain the run operator surface.

**Blocked by:** 04 — Wiki Visualization generator and CLI

**Status:** resolved

## Comments

- 2026-07-17: Implemented in source-scope-and-wiki-visualization work.

- [x] Optional post-publish visualization can be enabled without making visualization required for a Complete result.
- [x] Visualization failure after successful publication is reported and does not roll back or unpublish the Published Wiki.
- [x] `wiki-run` JSON contract remains stable for CI (no breaking dependency on HTML artifacts).
- [x] TUI and/or CLI success output report the visualization path when artifacts were written.
- [x] No browser SPA run dashboard and no replacement of the line-oriented TUI.
- [x] Tests cover optional on/off, non-rollback on viz failure, and path reporting without breaking JSON CLI consumers.
