# 16 — Package and release-gate the Workspace Console

**What to build:** The complete Workspace Console ships with the Python Producer and passes an end-to-end release journey from Workspace setup through Sources, Gateway, Run, review, publication, reading, grounded question, and provisional Source Investigation.

**Blocked by:** 03 — Edit Workspace settings through the Console; 09 — Cancel, recover, and diagnose Production Runs; 10 — Review and publish from the Workspace Console; 11 — Render and navigate the Knowledge Bundle safely; 13 — Replay Concept formation and incremental impact; 15 — Investigate a Source Snapshot provisionally.

**Status:** ready-for-agent

- [ ] Production packaging includes built Console assets and requires no Node, Bun, Next.js, TanStack Start, CDN, or separate JavaScript server at runtime.
- [ ] A fresh installed Producer can initialize a Workspace, launch the Console, and load the shell and accepted Bundle reader without external UI network requests.
- [ ] The primary release journey configures multiple Source roles, safely resolves revisions, selects a Gateway Profile, completes a Run, reviews, publishes, reads, asks, and investigates provisionally.
- [ ] CLI and HTTP adapter contract tests prove equivalent validation, state transitions, publication outcomes, and authoritative errors.
- [ ] Browser tests cover supported desktop viewport ranges, keyboard-only operation, focus restoration, accessible names, status announcements, contrast, and reduced motion.
- [ ] Security tests cover loopback binding, session tokens, origins, CSP, external asset attempts, Markdown/Mermaid injection, source traversal, arbitrary file reads, destructive actions, and secret leakage.
- [ ] Failure journeys cover invalid configuration, clone/pull errors, gateway outage, task failure, cancellation, recovery, stale review, final-check failure, malformed Bundle content, Query failure, and investigation policy rejection.
- [ ] The shadcn Base UI composition rules are checked across navigation, forms, dialogs, destructive confirmation, feedback, loading, and empty states.
- [ ] Existing deterministic, security, benchmark, Mutation Case, gateway, and Agent Evaluation suites remain green.
- [ ] Query Agent and Source Investigation evaluation results are included in the release report and can block release.
- [ ] User-facing help explains Workspace configuration scope, Git ownership, Gateway credential handling, authority boundaries, provisional investigation, and how to use the CLI without the Console.
- [ ] The packaged feature either passes all required gates or reports the first blocking metric without publishing an incomplete release.

