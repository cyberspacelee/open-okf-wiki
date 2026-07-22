# Architecture template

Use when readers need a system-level map. Recommended frontmatter:

```yaml
---
type: architecture
title: <architecture page title>
description: <one-line summary of the system map>
timestamp: <ISO 8601 datetime of this page edit>
---
```

Adapt or omit any prompt:

- external boundary and responsibilities
- major components and why the boundaries exist
- dependency direction and important integration points
- one Mermaid component diagram when it clarifies relationships
- links to detailed module or flow concept pages (relative `.md`); prefer a **Related pages**
  list: one target per line, each with `—` describing this architecture page’s relationship to
  that concept (dependency, composition, runtime role, …)
- material structure claims grounded under `# Citations` with `repo:` URIs

Describe evidence-backed architecture, not a generic layer taxonomy.

Do not write reserved docs `index.md` or `log.md`.
