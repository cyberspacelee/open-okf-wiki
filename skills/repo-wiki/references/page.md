# Page Write Target

Write exactly the stable page ID in this Target. Read the Composition Map,
assigned `evidence_dossier` inputs, exact dependency pages, template, scopes
and evidence seeds. Reopen Source evidence for every load-bearing claim;
dossiers and child pages are synthesis inputs, not provenance.

Start frontmatter with only writer-owned fields such as `coverage` and
`sources`. The State Gate overwrites `id`, type, title, description, tags,
diagrams, language and generated metadata from the approved Composition Map.
Review owns verified, status and stale-after fields.

Use logical links for other composed pages:

    See [request recovery][request-recovery].

Do not add a reference definition or guess the final path. Unknown IDs fail the
deterministic bind gate.

Implement each Diagram Spec exactly once with its matching `%% okf-id`, Mermaid
kind, `accTitle` and `accDescr`. Show material failure and recovery paths and
follow the fence with a cited conclusion. Locators stay outside diagrams.

Every cited locator must be inside the assigned scopes. A workspace page that
spans Sources evidences each participant. Use `coverage: partial` and a
non-empty `## Gaps` section when evidence is incomplete. Do not change page
boundaries or compensate for a composition defect in prose.

Run `complete_command`. Handoff: artifact path, gate verdict and gap count.
