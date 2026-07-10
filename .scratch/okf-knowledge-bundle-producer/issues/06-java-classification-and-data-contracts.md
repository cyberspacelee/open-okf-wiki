# 06 — Classify Java source and aggregate Data Contracts

**What to build:** A Java repository can participate in a Producer Project without allowing DTO/VO volume to dominate the generated knowledge, while meaningful validation, serialization, security, and behavioral semantics remain visible.

**Blocked by:** 02 — Build a multi-repository Source Set; 03 — Derive Coverage Obligations from Markdown; 05 — Persist the Accepted Knowledge Model.

**Status:** ready-for-agent

- [ ] Java manifests, modules, packages, types, methods, annotations, and relevant structural declarations become Source Units.
- [ ] Controllers, handlers, services, domain types, state machines, security, configuration, and load-bearing persistence behavior receive Major priority where appropriate.
- [ ] DTO, VO, request, response, and field-oriented record types are classified as Data Carriers by default.
- [ ] Related Data Carriers are aggregated into Data Contracts at meaningful interface or persistence seams.
- [ ] Data Carriers with validation, serialization, security, domain-interface, state, or non-trivial behavior are promoted for deeper analysis.
- [ ] Generated and vendor Java source can be explicitly excluded with an auditable reason.
- [ ] A DTO-heavy repository produces substantially fewer Major Obligations than raw class count without losing declared constraints.
- [ ] An end-to-end Java and Markdown Source Set produces useful accepted knowledge and pages.
