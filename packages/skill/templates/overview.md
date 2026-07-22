# Overview template

Write this as the root concept page **`overview.md`** (not `index.md`). Recommended frontmatter:

```yaml
---
type: overview
title: <short repository title>
description: <one-line summary of purpose and audience>
timestamp: <ISO 8601 datetime of this page edit>
---
```

Guidance prompts (adapt or omit; not a mandatory section list):

- What the repository does and for whom
- The smallest useful mental model
- Main capabilities and boundaries
- Links to other concept pages this repository actually needs (relative `.md`); for navigation
  lists use **one link per line** with `—` plus what the reader will find / how it relates
  (OpenWiki quickstart style). Do not cram several links into one bullet.
- Material claims grounded by `repo:` URIs under a final `# Citations` section

Open with the repository's value rather than its directory tree. Omit irrelevant prompts and merge
small topics into the narrative.

Do not write `index.md` or `log.md`—those reserved docs are owned by the Run Boundary.
