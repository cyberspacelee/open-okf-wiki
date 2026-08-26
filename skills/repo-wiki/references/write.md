# Write

Author exactly the page named by the write target. Read contract.md, its page
plan entry, assigned findings or connections, the appropriate template, and
the frozen evidence. Reopen every cited locator.

Start frontmatter with:

    ---
    type: Domain
    title: Request lifecycle
    description: Open before changing request state or error handling.
    resource: https://host/repo/tree/<commit>/src/request
    tags: [requests, lifecycle]
    coverage: full
    sources:
      - id: transition
        resource: okf-source://api/<commit>/src/request.py#L20-L48
    ---

Omit resource when there is no canonical bound asset. The write gate replaces
type, title, description and tags from the plan; it also adds generated,
draft status, language, source author and source last_modified. Do not write
generated, verified, status or stale_after.

Source-owned pages cite only their owner. Root pages may compose sources. Each
synthesis connection in architecture links both endpoint pages. Use
root-relative Wiki links. Fill template sections with evidence or declare a
partial gap. Do not cite drafts or copy cheap source facts.

Database pages read the frozen catalog.json. data-model.md routes selected
tables. A table page has type Table, its canonical table resource and an H1
Schema table; it claims nothing about unselected tables.
