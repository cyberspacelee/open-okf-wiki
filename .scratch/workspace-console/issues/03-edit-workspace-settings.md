# 03 — Edit Workspace settings through the Console

**What to build:** A Workspace owner can configure the Producer Project, Producer Profile, publication intent, and machine-specific preferences through one coherent Settings experience while shared and local authority remain correctly separated.

**Blocked by:** 02 — Launch a secure Workspace Console.

**Status:** ready-for-agent

- [ ] Settings presents project identity, Bundle naming, publication target, Producer Profile, and local preferences with their shared or local scope clearly indicated.
- [ ] Shared fields update only the Workspace Definition; machine-specific fields update only Local Workspace Settings.
- [ ] Form controls use shadcn Base UI composition, semantic validation states, accessible labels, descriptions, and error messages.
- [ ] Invalid edits are rejected before persistence and cannot partially update either configuration layer.
- [ ] Concurrent or stale edits are detected rather than silently overwriting newer settings.
- [ ] Removed or deprecated fields produce a migration explanation instead of becoming silent no-ops.
- [ ] Saving new settings does not alter the resolved configuration snapshot of an existing Production Run.
- [ ] The page can reload and reproduce the same resolved settings without losing unknown-but-forward-compatible data allowed by the schema.
- [ ] Equivalent CLI and HTTP updates produce the same normalized configuration and errors.
- [ ] End-to-end tests cover valid edits, invalid edits, shared/local separation, stale updates, migration guidance, persistence, and keyboard-only form use.
