# Flow template

Use for an important runtime, request, build, or data sequence. Recommended frontmatter:

```yaml
---
type: flow
title: <flow name>
description: <one-line journey summary>
timestamp: <ISO 8601 datetime of this page edit>
---
```

Prompts:

- trigger and observable outcome
- ordered path through meaningful boundaries
- state changes, branching, retries, and failure exits that matter to readers
- one Mermaid sequence or flow diagram when it is clearer than prose
- links to participating modules and concepts (relative `.md`); list multi-hop neighbors under
  **Related pages** as one link per line with `—` relationship text (role in this flow)
- material stage claims grounded under `# Citations` with `repo:` URIs

Focus on one coherent journey; split independent journeys and merge trivial ones into their module.

Do not write reserved docs `index.md` or `log.md`.
