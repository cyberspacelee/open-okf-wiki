# 01 — Portable prepare gate (fail-closed path policy)

**What to build:** Wiki Run prepare accepts Host-controlled paths under a portable policy (absolute roots, non-overlapping staging/skill/snapshot/publication, reject symlink and detectable reparse components) and fails closed on cross-volume publication/releases layouts. Operators are no longer hard-rejected solely for running on Windows or lacking `/proc/self/fd`. Invalid layouts fail before expensive model work when detectable at prepare.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Linux-only runtime gate (`dir_fd` / `/proc/self/fd` as hard Wiki Run entry reject) is removed or replaced with portable capability checks.
- [ ] Overlapping configured roots still fail closed with a clear operator error.
- [ ] Symlink (and detectable reparse where testable) path components on Host-controlled roots fail closed.
- [ ] Cross-volume Published Wiki path vs releases root fails closed at prepare (no copy fallback).
- [ ] Application-seam tests cover prepare failures without requiring Linux-only APIs for the happy prepare path on portable hosts.
- [ ] Behavior remains consistent with ADR 0017 path policy and the portable-host-filesystem-publication spec.
