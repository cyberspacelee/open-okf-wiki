# 08 — Verify semantic proposals from multiple perspectives

**What to build:** Independent Verifier Agents assess accepted-candidate knowledge for evidence entailment, coverage, contradiction, Concept boundaries, and risk, while a deterministic Acceptance Policy controls authoritative outcomes.

**Blocked by:** 05 — Persist the Accepted Knowledge Model; 07 — Schedule stateless planning and parallel Workers.

**Status:** ready-for-agent

- [ ] Evidence-entailment verification rereads original Evidence References and detects overstatement, missing conditions, and unsupported Claims.
- [ ] Coverage verification can reopen an Obligation that was superficially but inadequately covered.
- [ ] Contradiction verification represents disagreement among implementation, requirements, tests, and decisions as disputed knowledge.
- [ ] Concept-boundary verification can flag incorrect symbol promotion, aliasing, merge, and split proposals.
- [ ] Risk verification applies stronger scrutiny to security, permissions, privacy, persistence, and critical failure semantics.
- [ ] Every Verifier emits typed Verification Findings with target, perspective, verdict, severity, evidence, and rationale.
- [ ] Verifiers cannot mutate Claims, Concepts, Obligations, or publication state.
- [ ] Acceptance Policy produces accepted, rejected, revision-required, or Review Required outcomes without model majority voting.
