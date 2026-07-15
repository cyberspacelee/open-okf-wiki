# 03 — Version and fork the Producer Skill

**What to build:** A repository owner can use the product's immutable default Producer Skill or an explicitly owned Skill Fork, and can change workflow guidance or Wiki Templates without changing Python.

**Blocked by:** 01 — Establish the Wiki Run harness.

**Status:** ready-for-agent

- [x] Ship a trusted default Producer Skill with root workflow guidance, focused generate, refresh, and review guidance, and adaptable Wiki Templates.
- [x] The default Skill may provide overview, architecture, module, flow, and concept templates without imposing a mandatory page taxonomy or page count.
- [x] Validate required Skill components before starting model work and report missing, unreadable, malformed, or ambiguous components clearly.
- [x] Compute and freeze the exact resolved Producer Skill content digest for every Wiki Run.
- [x] Allow explicit selection of an immutable Skill Version.
- [x] Allow creation and use of a Skill Fork whose changes are owned separately and never overwritten by product upgrades.
- [x] The Producer Skill owns investigation method, semantic branching, page selection, page split and merge decisions, cross-linking, citation placement, style, diagrams, self-review, and completion criteria.
- [x] Python does not duplicate template sections, repository classification rules, page planning, or semantic workflow branches.
- [x] Target-repository Skills and instruction files remain source data and are never auto-loaded as product capabilities.
- [x] No Skill script execution, Runtime Authoring, dynamic Skill registry, or Markdown template engine is introduced.
- [x] End-to-end tests prove that changing a Skill Fork's guidance or Wiki Template changes the generated Wiki while the Python harness remains unchanged.
