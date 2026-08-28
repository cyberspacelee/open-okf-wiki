# Plan

Read contract.md, then build one bounded Workspace Page Plan. Use the packet's
`outline`, `search` and `read` commands to navigate each Pin. Start at build
modules and source sets, descend into package clusters only when the parent
view cannot support a page decision. Structure is routing evidence, not
semantic importance.

Plan at most 64 concept pages, choosing the smallest set that passes the Grep
Test. Each entry in a page's `scopes` names one Source and the paths its worker
may investigate. A package cluster may support one page, several clusters may
support one page, and most packages should create no page. Do not enumerate
files, generate package documentation or reserve speculative pages.

Write one JSON Attempt Artifact at the packet's `artifact` path:

    {
      "pages": [{
        "path": "data/api/request-lifecycle.md",
        "type": "Domain",
        "owner": "API",
        "title": "Request lifecycle",
        "description": "Open before changing request state or retry behavior.",
        "tags": ["requests", "lifecycle"],
        "scopes": [{
          "source": "API",
          "paths": ["api-core/src/main/java/com/example/request"]
        }],
        "depends_on": []
      }, {
        "path": "architecture.md",
        "type": "Architecture",
        "owner": "workspace",
        "title": "Architecture",
        "description": "Open before changing system boundaries.",
        "tags": ["architecture"],
        "scopes": [
          {"source": "API", "paths": ["api-core"]},
          {"source": "web", "paths": ["src/client"]}
        ],
        "depends_on": ["data/api/request-lifecycle.md"]
      }, {
        "path": "overview.md",
        "type": "Overview",
        "owner": "workspace",
        "title": "Workspace overview",
        "description": "Open first to route a task.",
        "tags": ["overview"],
        "scopes": [
          {"source": "API", "paths": ["."]},
          {"source": "web", "paths": ["."]}
        ],
        "depends_on": ["architecture.md"]
      }],
      "gaps": []
    }

`depends_on` lists child pages. A page with children becomes ready only after
every listed child is Machine-confirmed. Every dependency names a planned
page, and the graph stays acyclic.

Paths are lowercase portable bundle-relative Markdown paths. Every page has an
`owner` and non-empty `scopes`. Scope paths are
normalized Source-relative POSIX paths; `.` selects the eligible Source root.
For a Catalog Source, paths are selected table page slugs from the packet's
catalog index. Every scope must resolve inside a registered Source.

Workspace root pages use `owner: "workspace"`. Every source-owned page uses
its declared Source name as owner and lives under
`data/<source-slug>/`; all its scopes name that owner. Every Page Plan includes
`overview.md` and `architecture.md`. Add source-owned or database pages only
when the concept passes the Grep Test. A Catalog page may group related
selected tables under one bounded concept scope; do not create one page per
table merely because the table was selected.

Write titles and descriptions in the packet's `language`; paths, tags and
machine-facing fields stay ASCII. Read only the packet's bounded Catalog
indexes, never `state.json` or a full `catalog.json`.

Run `complete_command` from `workdir`. The State Gate validates paths, scopes,
required pages, dependency references and cycles before promoting the plan and
creating page Targets. Repair the Attempt Artifact until the gate passes.

Handoff: Attempt Artifact path, gate verdict, page count, leaf count.
