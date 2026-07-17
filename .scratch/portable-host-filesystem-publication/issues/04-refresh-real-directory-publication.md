# 04 — Refresh on real-directory publication

**What to build:** Refresh works against the new real-directory Published Wiki layout. Prior pages are staged as non-authoritative context; the Agent still re-evaluates the whole Wiki against the current Repository Snapshot Set; success replaces the complete Published Wiki. Tampered or non-producer publication trees are rejected before model work. No mechanical page-level incremental updater.

**Blocked by:** 02 — Directory-rename publication for Generate

**Status:** ready-for-agent

- [ ] Refresh requires an existing Host-owned real-directory Published Wiki (not a legacy symlink pointer layout).
- [ ] Prior pages are copied into empty Staging under existing Host ceilings and safety checks before model work.
- [ ] Successful Refresh exposes a complete validated tree at the Published Wiki path under the same rename publication rules as Generate.
- [ ] Refresh that fails after model/validation leaves the previous Published Wiki unchanged.
- [ ] Content/provenance noop behavior already specified for Refresh remains meaningful under the directory layout.
- [ ] Application-level Refresh tests are updated off symlink fixtures and stay green.
