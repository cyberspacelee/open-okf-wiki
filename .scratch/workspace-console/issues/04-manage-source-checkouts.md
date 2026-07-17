# 04 — Manage managed and linked Source Checkouts

**What to build:** A repository maintainer can clone a managed Source, link an existing checkout, assign its role, inspect its Git state, and remove it without the Workspace taking unsafe ownership of user repositories.

**Blocked by:** 03 — Edit Workspace settings through the Console.

**Status:** ready-for-agent

- [ ] The Sources page lists stable Source IDs, roles, ownership mode, checkout location, remote, branch, commit, dirty state, and ahead/behind status.
- [ ] A managed Source can be cloned beneath the Workspace using the user's existing Git, SSH agent, and credential helpers.
- [ ] An existing local repository can be registered as a linked Source without moving, copying, or rewriting it.
- [ ] Source IDs are unique and remain stable across reopen, status refresh, and later Production Runs.
- [ ] Source roles include the existing implementation, requirements, and contract semantics and reject unsupported or empty values.
- [ ] Clone and link operations validate that the target is a usable Git repository without executing repository-controlled code.
- [ ] Removing a Source from configuration never deletes a linked checkout.
- [ ] Removing a managed Source from configuration leaves its checkout intact until a separate explicit delete action is confirmed.
- [ ] Managed checkout deletion refuses ambiguous, escaped, symlinked, or externally owned paths.
- [ ] Tests cover successful and failed clone, linked checkout registration, credential delegation, duplicate IDs, invalid repositories, status inspection, safe removal, destructive confirmation, and traversal attempts.
