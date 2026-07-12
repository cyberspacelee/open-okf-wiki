# 06 — Configure reusable Gateway Profiles

**What to build:** An operator can create, test, select, and safely reuse an enterprise LLM Gateway Profile from the Console, including model, concurrency, and budget settings, without leaking credentials into shared or auditable content.

**Blocked by:** 02 — Launch a secure Workspace Console.

**Status:** ready-for-agent

- [ ] Connections lists machine-local Gateway Profiles without exposing stored secret values.
- [ ] A user can configure a profile name, gateway identifier, OpenAI-compatible base URL, optional headers, and credential.
- [ ] Credentials use the operating-system credential store when available and a permission-restricted local fallback otherwise.
- [ ] Shared Workspace configuration stores no API key, bearer token, credential value, or secret-bearing header.
- [ ] Capability testing verifies the exact required behaviors, including authentication, structured output, tool calling, usage reporting, concurrency, and representative error mapping.
- [ ] Capability failures are reported without echoing credentials, secret headers, or provider response bodies that may contain sensitive data.
- [ ] A Workspace can select a Gateway Profile, default model, concurrency, and budgets from Local Workspace Settings.
- [ ] Optional per-Agent-Role model overrides are available as advanced settings while one default model remains the normal path.
- [ ] Production Run snapshots record profile identity, actual model assignments, capabilities, and non-secret resolved settings but no credentials.
- [ ] Tests cover secure-store success, restricted fallback, unavailable credentials, invalid endpoints, timeouts, headers, capability failures, redaction, reuse across Workspaces, and resolved Run snapshots.

