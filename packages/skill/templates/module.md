# Module template

Use for a cohesive implementation area that deserves its own navigation target. Recommended
frontmatter:

```yaml
---
type: module
title: <module name>
description: <one-line responsibility summary>
timestamp: <ISO 8601 datetime of this page edit>
---
```

Prompts:

- responsibility and public surface
- key types or functions and their collaboration
- inputs, outputs, invariants, and failure behavior
- dependencies and callers that explain the boundary
- links to related flows and concepts (relative `.md`); when listing several, use a **Related
  pages** section: **one link per line**, each followed by `—` and the relationship from this
  module to that page (not a bare title dump; no multi-link bullets)
- implementation facts grounded under `# Citations` with `repo:` URIs

Merge this material into another page when the module would be thin or inseparable from a flow.

Do not write reserved docs `index.md` or `log.md`.
