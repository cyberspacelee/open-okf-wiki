# Research

Inventory the assigned Source in `.okf-wiki/task/brief.md` until Lead can name
its domains and concepts. Identify entry points, public interfaces, important
flows, state, persistence, and semantic domains. Preserve Source namespaces.
After the tree inventory, use narrow reads and greps. Cite locators; writers
reopen load-bearing ranges.

Start `.okf-wiki/task/handoff.md` with this exact YAML frontmatter shape. The
host injects Source identity onto `domains`. Default to `followups: []`. A
follow-up is a blocker that prevents taxonomy or plan: unread required scope, a
named domain or concept with no locator, a conflict that splits domain
identity, taxonomy that cannot be named, or a tool failure. Each follow-up
carries only its kind and a one-sentence question; the host supplies Source
scopes and durable identity. Kinds are `unread_scope`, `evidence_gap`,
`conflict`, `taxonomy_uncertain`, and `tool_failure`. Domain and concept ids
are lowercase ASCII slugs.

```yaml
---
followups: []
domains:
  - id: runtime
    conceptIds: [session, retry]
---
```

Then write exactly these Markdown headings:
`# Research Handoff`, `## Scope`, `## Coverage`, `## Evidence`,
`## Conflicts and alternatives`, and `## Gaps and failed reads`. Cite every
factual finding with a Markdown source link from `common.md`. Keep
source-local facts, cross-source synthesis candidates, conflicts, and minority
evidence separate. Put writer locators and optional unread files under Gaps.
Put blockers in `followups`.

After the file is complete, call `wiki_research_finish` with only
`status: complete` or `status: incomplete`. Use `complete` with `followups: []`
and nonempty `domains` once the inventory covers the assigned scope. Use
`incomplete` when a blocker remains in `followups`. If the host rejects the
file, fix every named defect in the same rewrite of `handoff.md`, then finish
again. Do not call finish again on the unchanged file. The host reads the
accepted handoff, derives follow-up work, assigns durable identities, and
persists the Task Receipt.

If context becomes tight, first preserve every verified finding and unresolved
blocker in `handoff.md`, then finish incomplete. A supplement answers only the
concrete blockers in its current `brief.md`.
