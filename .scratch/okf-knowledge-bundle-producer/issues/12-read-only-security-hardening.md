# 12 — Enforce the read-only security boundary

**What to build:** Untrusted repositories can be analyzed without allowing source content or model output to execute code, escape assigned scope, modify source, write formal Bundle files, or obtain credentials.

**Blocked by:** 07 — Schedule stateless planning and parallel Workers; 09 — Render the full OKF Producer Profile and review it.

**Status:** ready-for-agent

- [ ] Source Snapshots are immutable and exposed only through allowlisted read-only tools.
- [ ] Canonicalized paths cannot escape the assigned source, path scope, or Source Set.
- [ ] Shell, build, test, compiler, annotation processor, package-manager, and repository-script execution are unavailable.
- [ ] Worker, Planner, Verifier, and Renderer Agents cannot write source or formal Bundle files.
- [ ] Repository instructions, comments, and documentation are treated as data and cannot override system policy.
- [ ] Model and publication credentials are absent from prompts, tool results, source workspaces, and content-bearing traces.
- [ ] Analysis and publication use separate capabilities, with publication available only after accepted review and checks.
- [ ] Adversarial end-to-end tests cover prompt injection, traversal, symlinks, oversized files, scope confusion, write attempts, and credential requests.
