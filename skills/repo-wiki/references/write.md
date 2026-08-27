# Write

Author exactly the page named by the write target, writing the Markdown
yourself to the packet's `artifact` path — never return page content in your
reply. Read contract.md, the page's plan entry, its assigned findings or
connections, the matching template in assets/templates/, and the
revision-bound evidence itself — reopen every locator you cite.

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
Use root-relative Wiki links. Fill template sections with evidence or declare
a partial gap; do not cite drafts or copy cheap source facts.

Database pages read the captured catalog.json: data-model.md routes selected
tables; a table page has type Table, its canonical table resource and an H1
Schema table, and claims nothing about unselected tables.

Handoff: artifact path and gap count.
