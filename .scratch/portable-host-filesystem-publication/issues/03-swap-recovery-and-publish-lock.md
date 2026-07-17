# 03 — Swap recovery and exclusive publish lock

**What to build:** Publication swap is safe under interruption and concurrency. If rename swap fails after moving the previous tree aside, the Host best-effort restores the previous complete Published Wiki; if restore fails, recoverable paths remain and the operator gets a clear error—never a partial tree at the stable name. A second Wiki Run targeting the same Published Wiki path while publish is locked fails closed.

**Blocked by:** 02 — Directory-rename publication for Generate

**Status:** ready-for-agent

- [ ] Mid-swap failure attempts restore of the previous complete tree when it was moved aside.
- [ ] Unrecoverable mid-swap failure leaves diagnosable aside/release artifacts and does not leave a half-written directory as the Published Wiki.
- [ ] Concurrent or overlapping Wiki Runs against the same Published Wiki path fail closed under a Host exclusive publication lock.
- [ ] Lock contention error names the path and is actionable; clean process exit does not permanently wedge the path without a documented recovery story if stale locks are possible.
- [ ] Covered at the Wiki Run application seam where practical; a narrow internal Host publish helper may be used only for fault-injected swap recovery.
