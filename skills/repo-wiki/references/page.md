# Page

Research and author exactly the page named by this Target. Read contract.md,
the packet's page metadata, `scopes` and `evidence_seeds`, exact dependency
inputs and matching template in assets/templates/. Write Markdown to the
packet's `artifact` Attempt Artifact; never return page content in the Handoff.

Use `outline` to orient inside the Page Scope declared by `scopes`, `search`
to locate behavior and pass its returned Locators directly to `read`. Expand
their line ranges to reopen planning seeds and bounded evidence windows. Seeds
route research but are not automatically claims or citations.
Read only enough files to explain knowledge that passes the Grep Test. Package
layout, symbol inventories and restated configuration do not become prose.

For a parent page, use only `dependency_page` inputs to synthesize routing and
topology, then reopen their Locators before repeating a load-bearing claim.
`previous_output` is the prior attempt for repair, not evidence. Candidate pages
and planning artifacts are never provenance.

Start frontmatter like:

    ---
    type: Domain
    title: Request lifecycle
    description: Open before changing request state or error handling.
    tags: [requests, lifecycle]
    coverage: full
    sources:
      - id: transition
        resource: API/api-core/src/main/java/com/example/Request.java#L20-L48
    ---

The packet's Page Plan entry owns type, owner, title, description, tags,
`scopes` and dependencies. The State Gate owns generated metadata;
review owns verified, status and stale_after.
Write none of those trust fields.

Every Locator must resolve inside the Page Scope. A source-owned page cites
only its owner; a workspace-owned page whose `scopes` span multiple Sources
may explain their boundary only when evidence supports every participant.
Link the relevant source-owned pages. Use root-relative Wiki links. Write
prose, headings and footnotes in the packet's `language`; keep frontmatter
field names, tags, paths and Locators ASCII.

Use `coverage: partial` and a non-empty Gaps section when the assigned scopes
cannot support complete claims. Name the missing evidence and searched scopes.
Do not expand the Page Plan, invent rationale or hide missing evidence.

Database pages read only `catalog_index` inputs and cite the canonical resources
for their scoped tables. A schema table includes a Comment column and claims
nothing about unselected tables.

Run `complete_command` from `workdir`. The State Gate validates and promotes a
successful Attempt Artifact into the Candidate, then creates its review
Target. Repair gate issues until it passes; use `task fail` when the Page Plan
itself prevents an honest page.

Handoff: Attempt Artifact path, gate verdict, gap count.
