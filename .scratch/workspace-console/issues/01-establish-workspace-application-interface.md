# 01 — Establish the Workspace application interface and versioned state

**What to build:** A user can initialize, open, validate, and inspect one Workspace through the existing automation surface, with a shareable Workspace Definition, Local Workspace Settings, and versioned persisted state that later Console slices can reuse without duplicating business rules.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Initializing a Workspace creates one Producer Project identity and the minimum valid shared and local configuration.
- [ ] Opening a Workspace resolves the Workspace Definition and Local Workspace Settings into one typed, non-secret snapshot.
- [ ] Unknown, malformed, conflicting, and removed configuration fields fail with actionable, source-located errors rather than being ignored.
- [ ] Existing Producer Project configuration can be opened or migrated without losing Source, profile, publication, or Run information.
- [ ] Persisted Workspace and Production Run state uses explicit ordered schema versions and migrations rather than caller-specific ad hoc changes.
- [ ] A failed configuration update or migration leaves the previous valid configuration and state intact.
- [ ] The CLI invokes the same Workspace application interface intended for the future HTTP adapter.
- [ ] Machine-readable inspection reports project identity, resolved settings, configured Sources, publication target, and redacted model settings without exposing credentials.
- [ ] Existing Production Run, review, recovery, benchmark, and security behavior remains green.
- [ ] End-to-end tests exercise initialization, reopen, configuration layering, migration, invalid input, and rollback through the Workspace application seam.
