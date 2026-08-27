# Plan

Convert findings and connections into the smallest useful page set. Every
finding is assigned once or explicitly excluded; every connection is
assigned. Use one source owner for source pages and workspace for root
composition.

Write drafts/plan.json:

    {
      "pages": [{
        "path": "overview.md",
        "type": "Overview",
        "owner": "workspace",
        "title": "Workspace overview",
        "description": "Open first to route a task.",
        "tags": ["overview"],
        "finding_ids": ["api-request-lifecycle"],
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

Paths are lowercase portable bundle-relative Markdown paths. Include required
database pages from contract.md. Do not add tag indexes or speculative pages.

Handoff: artifact path, page count, exclusion count.
