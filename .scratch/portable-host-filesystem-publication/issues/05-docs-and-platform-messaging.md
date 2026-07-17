# 05 — Docs and platform messaging

**What to build:** Operator-facing documentation and error messaging match shipped portable Host filesystem behavior: Wiki Run is not inherently Linux-only once implementation is in; publication is a real directory via same-volume rename; legacy symlink trees must be cleared and full-generated; full Generate is the default operating mode and failures are re-run as separate Wiki Runs. Messaging stops prescribing WSL as the only Windows path when portable support is real.

**Blocked by:** 02 — Directory-rename publication for Generate; 03 — Swap recovery and exclusive publish lock; 04 — Refresh on real-directory publication

**Status:** ready-for-agent

- [ ] README Host OS / Wiki Run requirements reflect portable policy and real-directory publication (no stale “Linux only forever” as product law once code has landed).
- [ ] Refresh / publish operator docs describe real-directory layout and how to clear a rejected legacy symlink publication.
- [ ] User-visible prepare/publish errors for platform, cross-volume, lock, and legacy layout are actionable.
- [ ] Docs stay aligned with ADR 0007 (semantic atomicity), ADR 0012 (Manual Retry as new run), and ADR 0017 (portable mechanism).
- [ ] No claim of mechanical incremental wiki generation or automatic symlink migration.
