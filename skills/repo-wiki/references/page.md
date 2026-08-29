# Page

Research and author exactly the page named by this Target. Read the packet's
`contract`, `template`, page metadata, `scopes`, `evidence_seeds` and exact
dependency inputs. Write Markdown to the packet's `artifact` Attempt Artifact;
never return page content in the Handoff.

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
    type: Lifecycle
    title: Request lifecycle
    description: Open before changing request state or error handling.
    tags: [requests, lifecycle]
    coverage: full
    diagrams:
      - id: request-state
        kind: state
        question: How does a request fail and recover?
    sources:
      - id: transition
        resource: API/api-core/src/main/java/com/example/Request.java#L20-L48
    ---

The packet's Page Plan entry owns type, owner, title, description, tags,
`scopes`, dependencies and Diagram Specs. The State Gate overwrites these
fields from the Plan and owns generated metadata; review owns verified, status
and stale_after.
Write none of those trust fields.

Implement every planned Diagram Spec exactly once as a `mermaid` fence. Put
`%% okf-id: <planned-id>` on its own line and use the planned kind. Add a
non-empty `accTitle` and `accDescr`; show normal and evidence-backed failure,
retry, compensation, terminal or optional paths relevant to the diagram's
question. Immediately follow the fence with a short conclusion or caption
containing a normal page footnote. Do not put Locators in the fence, use color
as the only meaning, or repeat every edge in prose.

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
type, split or Diagram Specs prevent an honest page.

Handoff: Attempt Artifact path, gate verdict, gap count.
