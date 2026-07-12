# 05 — Pull safely and resolve Source Revision Policies

**What to build:** A repository maintainer can safely update clean Source Checkouts, choose follow-branch or pinned-commit behavior, and preview the exact immutable Source Set that the next Production Run will use.

**Blocked by:** 04 — Manage managed and linked Source Checkouts.

**Status:** ready-for-agent

- [ ] Pull is available for managed and linked Source Checkouts through the user's configured Git authentication.
- [ ] Pull is blocked when tracked changes, staged changes, untracked files, conflicts, or another unsafe working-tree condition is present.
- [ ] The Producer never automatically stashes, resets, cleans, rebases, force-checks out, or overwrites local work.
- [ ] Follow Branch lets the user select a valid named branch and reports its resolved local and remote commit.
- [ ] Pinned Commit requires a complete valid commit ID and remains unchanged by later Pull operations.
- [ ] Missing branches, deleted remotes, unreachable commits, detached states, and non-fast-forward Pull failures produce actionable errors without corrupting configuration.
- [ ] Run preflight displays every Source ID, role, revision policy, exact resolved commit, and tree digest before creation.
- [ ] Production Run creation records exact Source Snapshot revisions, and later branch movement or Pull cannot alter an existing Run.
- [ ] Dirty and untracked working-tree content never enters the authoritative Source Set.
- [ ] End-to-end Git fixtures cover clean Pull, each dirty state, follow-branch advancement, pinned stability, failure recovery, exact revision resolution, and immutable Run inputs.

