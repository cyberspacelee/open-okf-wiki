# 05 — Harden untrusted source and side-effect boundaries

**What to build:** A security-conscious repository owner can run the Wiki producer knowing that the target repository is treated only as untrusted read-only data and that model side effects cannot escape the Staging Wiki or leak credentials.

**Blocked by:** 01 — Establish the Wiki Run harness; 02 — Validate and atomically publish a Wiki.

**Status:** ready-for-agent

- [x] Source and Producer Skill mounts remain read-only for the complete Wiki Run; only the Staging Wiki is writable.
- [x] Absolute paths, parent traversal, normalization tricks, symlink escapes, and publication-root escapes fail closed.
- [x] Repository builds, tests, package managers, scripts, plugins, arbitrary host shell, and package installation are unavailable.
- [x] Repository analysis receives no external network tool beyond the configured model connection.
- [x] Repository-provided AGENTS, CLAUDE, Skill, prompt-like, and plugin files cannot change system policy or gain capabilities.
- [x] Model credentials and secret headers never enter source, Producer Skill content, prompts supplied by the product, traces, staging files, terminal output, or publication metadata.
- [x] Invalid citations to binary, missing, oversized, escaped, or out-of-range source content fail validation.
- [x] Usage and sandbox resource ceilings stop unbounded repository traversal or output generation with explicit errors.
- [x] Adversarial tests exercise source writes, Skill writes, path traversal, symlink races supported by the platform, shell and network attempts, repository-instruction injection, and secret exposure.
- [x] Security checks run through the Wiki Run seam where possible; focused lower-level tests are limited to trust-boundary cases that cannot be localized safely end to end.
