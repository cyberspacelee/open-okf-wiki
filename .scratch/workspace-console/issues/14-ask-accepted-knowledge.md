# 14 — Ask the Accepted Knowledge Model

**What to build:** A knowledge consumer can ask a grounded question about the current Concept or complete Knowledge Bundle and receive an answer supported only by accepted Claims and exact Evidence References, or an explicit insufficient-support result.

**Blocked by:** 06 — Configure reusable Gateway Profiles; 11 — Render and navigate the Knowledge Bundle safely.

**Status:** ready-for-agent

- [ ] The Ask interface supports current Concept/page scope and complete accepted Bundle scope.
- [ ] A short-lived Query Agent uses the selected Gateway Profile, fixed Run identity, accepted Claims, Evidence References, and bounded read-only retrieval tools.
- [ ] Retrieval reuses deterministic Concept and Claim lookup and does not introduce embeddings or a vector database.
- [ ] Every factual answer segment cites accepted Claim IDs and exact Evidence References.
- [ ] Unsupported questions return an explicit insufficient-support response rather than filling gaps with model knowledge.
- [ ] Repository text, accepted prose, and user questions cannot override Query Agent policy or expand its scope.
- [ ] The UI shows the Run, Source Set digest, model assignment, scope, citations, and data-egress disclosure associated with the answer.
- [ ] Query sessions are ephemeral by default and never mutate the Accepted Knowledge Model, Coverage Obligations, review, or Bundle pages.
- [ ] Audit persists only approved non-content metadata such as model, usage, latency, outcome, and cited IDs unless the user explicitly exports content.
- [ ] Budgets, timeouts, gateway failures, and missing credentials produce controlled, actionable results.
- [ ] Query Agent Evaluation measures citation completeness, refusal quality, scope, prompt-injection resistance, cost, and latency.
- [ ] Browser and deterministic tests cover both scopes, citations, insufficient support, redaction, ephemeral behavior, reload, and no authoritative mutation.

