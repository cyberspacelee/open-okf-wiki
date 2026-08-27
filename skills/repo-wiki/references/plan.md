# Plan

Convert findings and connections into the smallest useful page set for this
shard. `plan:<source>` owns pages whose owner is that source.
`plan:workspace` owns workspace pages and assigns every connection. The CLI
Compose Gate unions shards and checks global finding/connection coverage.

Write the artifact yourself to the packet's `artifact` path — never return
its content in your reply. Source shard:

    {
      "source": "API",
      "pages": [{
        "path": "api/architecture.md",
        "type": "Architecture",
        "owner": "API",
        "title": "API architecture",
        "description": "Open before API changes.",
        "tags": ["architecture"],
        "finding_ids": ["api-request-lifecycle"],
        "connection_ids": []
      }],
      "exclusions": []
    }

Workspace shard:

    {
      "source": null,
      "pages": [{
        "path": "overview.md",
        "type": "Overview",
        "owner": "workspace",
        "title": "Workspace overview",
        "description": "Open first to route a task.",
        "tags": ["overview"],
        "finding_ids": [],
        "connection_ids": []
      }, {
        "path": "architecture.md",
        "type": "Architecture",
        "owner": "workspace",
        "title": "Architecture",
        "description": "Open before cross-boundary changes.",
        "tags": ["architecture"],
        "finding_ids": [],
        "connection_ids": ["web-calls-api"]
      }],
      "exclusions": [{
        "finding_id": "cheap-inventory",
        "reason": "fails Grep Test"
      }]
    }

Paths are lowercase portable bundle-relative Markdown paths. Write titles,
descriptions and exclusion reasons in the packet's `language`; paths, tags
and ids stay ASCII. Include required database pages from contract.md; a
database shard reads the packet's `catalogs` index for selected table names,
page slugs and comments — not `state.json` or the full `catalog.json`. Do
not add tag indexes or speculative pages.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, page count, exclusion count.
