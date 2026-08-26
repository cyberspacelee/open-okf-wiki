# Thin Wiki gated by the Grep Test

The Wiki is a semantic routing layer, not a source mirror: it carries only
knowledge that is expensive for an agent to rebuild by search — cross-module
architecture, invariants, failure propagation, task entry points. Admission is
the Grep Test: if grep plus reading a few files rebuilds the fact in about a
minute, the Wiki must not carry it. Consequently the per-directory page
machinery of v1 (concept/states/data singletons, cardinality contracts) is
dropped; page count scales with domains, not directories. Industry practice
(Anthropic just-in-time retrieval, agentic search replacing RAG indexes)
backs this: pre-computed artifacts survive only as lightweight identifier
layers, and everything else goes stale.

Consequences: best-effort coverage is explicit — a page may declare
`coverage: partial` with recorded gaps, but fabricated rationale and
unverifiable citations remain publish blockers.
