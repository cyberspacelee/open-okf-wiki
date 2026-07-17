# 02 — Directory-rename publication for Generate

**What to build:** A successful full Generate exposes a complete validated Wiki as a **real directory** at the Published Wiki path via same-volume release materialization + directory rename—not a producer-managed symlink. Failed validation, Needs Input, cancellation, and model failure leave any previous Published Wiki unchanged. Legacy symlink publications are rejected with an actionable error (no auto-migration). Operators who full-generate each attempt get the new layout end-to-end.

**Blocked by:** 01 — Portable prepare gate (fail-closed path policy)

**Status:** ready-for-agent

- [ ] Successful Generate leaves the Published Wiki path as a regular directory tree of pages plus publication metadata (not a symlink).
- [ ] Release is fully written and validated under the Host releases root before the stable path is switched.
- [ ] Incomplete or failed Wiki Runs do not leave a half-written tree as the Published Wiki and do not change the previous complete publication when one existed.
- [ ] Absent Published Wiki path works for greenfield Generate.
- [ ] Existing symlink layout at the Published Wiki path fails with operator guidance to clear and re-run; no automatic migration.
- [ ] Existing application-level publish/failure tests are updated for real-directory layout and stay green.
- [ ] Superseded release cleanup after success is allowed; long-term release history is not required.
