# Source Plan

Read contract.md, then investigate exactly the Git/files Source named by the
packet. Read its `source_index`, use only the packet's single-Source scope and
bounded `outline`, `search` and `read` commands, and write one Source Brief.
The Brief routes the Workspace planner; it does not choose Wiki pages.

Account for this Source before writing:

1. Classify every role it actually serves: `business-domain-owner`,
   `public-contract`, `shared-infrastructure`, `extension-surface` or
   `evidence-only-dependency`.
2. Find domain nouns and their state transitions, then the commands,
   persistence, events, failure paths and extension points that change them.
   Admit only lifecycles or invariants that pass the Grep Test.
3. Find outward contracts: public interfaces, internal integration points,
   events, plugin SPIs and build dependencies. Record the local evidence and
   exact literal queries a later planner can run against named counterpart
   Sources.
4. Record unresolved important evidence in `gaps`. An empty concept list is
   correct for an evidence-only Source.

Every concept names bounded Source-relative `paths` and one to three Locators
the worker opened inside those paths. Every connection has local evidence,
one or more registered counterpart Sources and literal counterpart queries.
Do not inspect another Source, propose page paths or dependencies, copy source
text, or treat package/module names as domain concepts.

Write one JSON Attempt Artifact at the packet's `artifact` path:

    {
      "source": "API",
      "roles": ["public-contract"],
      "concepts": [{
        "name": "subscription-contracts",
        "description": "Public subscription states and transition commands.",
        "paths": ["src/main/java/org/example/subscription"],
        "evidence_seeds": [
          "API/src/main/java/org/example/subscription/Subscription.java#L20-L52"
        ]
      }],
      "connections": [{
        "name": "subscription-implementation",
        "description": "The public subscription contract is implemented by the core Source.",
        "evidence_seeds": [
          "API/src/main/java/org/example/subscription/SubscriptionApi.java#L15-L44"
        ],
        "counterpart_sources": ["core"],
        "counterpart_queries": ["SubscriptionApi"]
      }],
      "gaps": []
    }

`previous_output` is repair context, not evidence. Run `complete_command` from
`workdir`; repair schema, scope, counterpart or Locator issues until the State
Gate accepts the Brief.

Handoff: Attempt Artifact path, gate verdict, role count, concept count,
connection count and gap count.
