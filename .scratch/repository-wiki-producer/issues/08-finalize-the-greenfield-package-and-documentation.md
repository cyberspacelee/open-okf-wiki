# 08 — Finalize the greenfield package and documentation

**What to build:** A new user can install the package, generate or refresh a source-grounded Wiki through the greenfield interface, and read documentation that describes only the supported repository-to-Wiki product.

**Blocked by:** 07 — Retire the legacy semantic control plane.

**Status:** ready-for-agent

- [x] Remove remaining obsolete Workspace, Workspace Console, gateway-profile, legacy configuration, migration, bundled frontend, and unused adapter code.
- [x] The installed command-line surface exposes only supported greenfield operations and structured outcomes.
- [x] Package metadata describes Repository Snapshot to source-grounded Wiki generation rather than the retired Knowledge Bundle Producer.
- [x] Dependencies and the lockfile contain only libraries required by the greenfield runtime, validation, testing, and packaging paths.
- [x] PydanticAI and Pydantic AI Harness remain exactly pinned to the evaluated compatible versions.
- [x] User documentation explains Generate, Refresh, Producer Skill selection and forks, Wiki Templates, Source Citations, validation, security boundaries, and publication behavior.
- [x] Historical design documents are clearly marked as historical or removed when they no longer provide useful context.
- [x] Documentation does not promise Claim-level provenance, exhaustive coverage, Workspace Console, queries, web enrichment, SubAgents, DynamicWorkflow, durable resume, or backward compatibility.
- [x] A fresh-package test installs the built artifact and completes a deterministic Wiki Run through the public command-line seam.
- [x] Lockfile, test, lint, format, type, package-release, Markdown-link, and diff checks pass from a clean checkout.
