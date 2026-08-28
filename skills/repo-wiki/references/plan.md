# Plan

Convert findings and connections into the smallest useful page set for this
shard. Each shard is the single writer of its own namespace, and the gate
enforces the partition:

- `plan:<source>` pages live under `<source-slug>/` (a database shard's
  under `data/<source-slug>/`); `plan:workspace` pages live at the root or
  in directories no source owns. Page paths therefore never collide across
  shards.
- Each finding is assigned to a page or excluded exactly once across all
  shards; the gate rejects a finding already claimed by a completed sibling
  shard. Source-owned pages cite only their owner's findings; workspace
  pages may compose findings from any source.
- Only `plan:workspace` assigns connections, each to exactly one workspace
  page, and it must assign all of them.
- Required pages are gated on the shard that owns them: workspace owns
  `overview.md`, `architecture.md` and (with a database) `data-model.md`;
  a multi-source run's `plan:<source>` owns `<source-slug>/architecture.md`;
  a database shard owns one Table page per selected table.

The CLI Compose Gate re-checks the same partition when the last shard
completes; a failure names the shard artifact at fault and reopens it.

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
