# 04 — Extract typed knowledge with a PydanticAI Worker Agent

**What to build:** A bounded Worker Agent can investigate one assigned Coverage Obligation through the enterprise OpenAI-compatible gateway and submit typed Claim, Concept, and Evidence proposals that the Deterministic Control Plane validates before accepting.

**Blocked by:** 03 — Derive Coverage Obligations from Markdown.

**Status:** ready-for-agent

- [ ] PydanticAI uses the configured enterprise OpenAI-compatible gateway without hard-coding a public provider.
- [ ] `pyproject.toml` constrains PydanticAI to the 2.8 series and `uv.lock` records the exact installed version.
- [ ] Framework behavior used by the Worker is verified against documentation, source, or tests from the official release tag matching the lockfile version, initially `v2.8.0`; rolling Web documentation is used only for discovery.
- [ ] Local contract tests prove that the configured enterprise gateway supports every required capability, including tool calling, structured output, retry/error behavior, usage reporting, and configured concurrency.
- [ ] A Worker Agent receives explicit Obligation IDs, source scope, allowed paths, tools, and budgets.
- [ ] Only read-only list, search, and read behavior is available to the Worker Agent.
- [ ] Worker output is validated as typed Claim, Concept, relation, disposition, and Evidence proposals.
- [ ] Evidence paths, revisions, spans, and digests are resolved against the assigned Source Snapshot before acceptance.
- [ ] Invalid, missing, or out-of-scope Evidence causes proposal rejection rather than authoritative mutation.
- [ ] Tool use, retry, token usage, latency, model, prompt, and schema versions are recorded.
- [ ] Development documentation lookup cannot grant the Worker Agent Web Enrichment or unrestricted network access.
- [ ] The Worker Agent cannot close Obligations, write Bundle files, or publish.
