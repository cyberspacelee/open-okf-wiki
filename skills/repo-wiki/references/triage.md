# Triage

Read contract.md and the one compact `drafts/index/<source>.json` listed in
the dispatch packet. Every directory entry is disjoint: its file, line and
byte counts, extensions, test proximity, generated markers, representative
files and entry points describe only the files that directory holds
directly, so counts are additive and sum to `file_count`. `subtree_files`
is the one derived subtree total. Empty single-child directory chains are
collapsed. Under the byte budget the index coarsens instead of dropping:
a truncated entry absorbs its pruned subdirectories and reports how many in
`collapsed_dirs` — no file is ever missing from the index. When
`collapsed_dirs` is non-zero or a branch remains unclear, run
`<ls_command> <relative-directory> --json` from the packet's `workdir` on
that directory only; continue with `--after <next_after>` when returned.
Do not recursively list the Source. Read at most three deterministic source
samples when deciding whether a non-generated scope is inventory. Assign
every non-excluded file of this Source to exactly one scope.

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
