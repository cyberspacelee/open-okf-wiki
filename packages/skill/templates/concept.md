# Concept template

Use when repository-specific language or an invariant needs explanation. Recommended frontmatter:

```yaml
---
type: concept
title: <concept name>
description: <one-line definition for indexes>
timestamp: <ISO 8601 datetime of this page edit>
---
```

Prompts:

- concise definition and reader relevance
- where the concept enters the system
- rules, lifecycle, or invariants visible in source
- concrete examples and common confusions when source supports them
- links to modules and flows where the concept is applied (relative `.md`); multi-target lists
  use **Related pages**: one link per line + `—` how this concept relates to that page
- factual rules grounded under `# Citations` with `repo:` URIs

Prefer the repository's own stable terminology. Merge a concept into another page when it does not
support a distinct reader question.

Do not write reserved docs `index.md` or `log.md`.
