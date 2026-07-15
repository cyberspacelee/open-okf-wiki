# 01 — Establish the Wiki Run harness

**What to build:** A repository owner can run one exact Repository Snapshot through a single PydanticAI Agent and receive a typed Complete or Needs Input result with Markdown written to an isolated Staging Wiki. This is the new end-to-end application seam used by automation and later slices, while the legacy product remains untouched during the expand phase.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Resolve and exactly lock a mutually compatible released pair of PydanticAI and Pydantic AI Harness; do not emulate unavailable Harness capabilities.
- [ ] One Wiki Run accepts an exact Repository Snapshot, a trusted Producer Skill revision, model and provider configuration, usage limits, and a staging destination.
- [ ] One PydanticAI Agent run owns exploration, tool use, writing, review, and stopping without a custom Scheduler, role pipeline, graph, or host workflow loop.
- [ ] CodeMode receives separate read-only source and Producer Skill mounts plus one read-write Staging Wiki mount.
- [ ] The Agent reads the product-provided Producer Skill before investigating the Repository Snapshot.
- [ ] The terminal contract distinguishes Complete with a Wiki Manifest from Needs Input with bounded blocking questions; operational failures remain failures.
- [ ] Request, token, tool-call, retry, and timeout controls use official PydanticAI or provider facilities.
- [ ] A non-interactive application and command-line entry return structured terminal output without parsing model prose.
- [ ] A deterministic model fixture drives the full seam and produces at least one Markdown page in staging.
- [ ] Tests assert public results and filesystem effects rather than prompts, private Agent reasoning, or exact tool ordering.
