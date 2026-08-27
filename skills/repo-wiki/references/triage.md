# Triage

Read contract.md and the one `drafts/index/<source>.json` listed in the
dispatch packet. It is a bounded hierarchy of file, line and byte counts,
extensions, test proximity, generated markers, representative files and
entry points. Read at most three deterministic source samples when deciding
whether a non-generated scope is inventory. Assign every non-excluded file
of this Source to exactly one scope.

Write the artifact yourself to the packet's `artifact` path — never return
its content in your reply:

    {
      "source": "api",
      "scopes": [{
        "paths": ["src/core"],
        "tier": "deep",
        "orientation": "request lifecycle and retry live here",
        "themes": ["lifecycle", "retry"]
      }, {
        "paths": ["src/dto", "src/vo"],
        "tier": "inventory",
        "reason": "passive DTO shapes with no decision-relevant behaviour",
        "samples": ["api/src/dto/UserDTO.java#L1-L40"]
      }]
    }

Tiers: `inventory` records coverage only and creates no Finding or survey
Target; `standard` covers ordinary packages; `deep` covers entry points,
lifecycle and enforced rules. Generated scopes need a reason but no sample.
Other inventory scopes need one to three sample locators. Entrypoints,
manifests, auth, security, migrations and public contracts cannot be
inventory. When uncertain, choose `standard`.

Write orientation and themes in the packet's `language`; paths and tiers
stay ASCII. Never emit exclusions. `workspace.json` `survey.split` /
`survey.exclude` bind the gate: forced splits must be independent scopes and
excluded directories stay out. Cover every remaining file with no overlap.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, scope count by tier.
