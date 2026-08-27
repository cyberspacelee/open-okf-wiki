# Write

Author exactly the page named by the write Target, writing Markdown to the
packet's `artifact` path — never return page content in your reply. Read
contract.md, the page's plan entry, its assigned findings or connections,
the matching template in assets/templates/, and the matching Evidence Cache.
Reopen a Pin file only when the cached window is not enough to support a
load-bearing claim.

Start frontmatter like:

    ---
    type: Domain
    title: Request lifecycle
    description: Open before changing request state or error handling.
    tags: [requests, lifecycle]
    coverage: full
    sources:
      - id: transition
        resource: api/src/request.py#L20-L48
    ---

`resource` entries are plain locators (contract.md); the gate resolves them
against the run's recorded revision and fills in Git author/last_modified.
The gate also replaces type, title, description and tags from the plan and
stamps generated, status and language — do not write generated, verified,
status or stale_after.

Source-owned pages cite only their owner. Root pages may compose sources.
Each synthesis connection assigned to architecture links both endpoint pages.
Use root-relative Wiki links. Write body prose, headings and footnote text
in the packet's `language`; frontmatter field names, locators and ids stay
as the contract defines them. Fill template sections with evidence or
declare a partial gap; do not cite drafts or copy cheap source facts.

Database pages read the packet's `catalogs` paths: a per-table JSON for a
Table page, the catalog index for data-model.md. Do not open `state.json` or
the full `catalog.json`. data-model.md routes selected tables; a table page
has type Table, its canonical table resource and an H1 Schema table with a
Comment column, and claims nothing about unselected tables.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the page, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, gap count.
