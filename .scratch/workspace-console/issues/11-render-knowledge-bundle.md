# 11 — Render and navigate the Knowledge Bundle safely

**What to build:** A knowledge consumer can read staged or published Bundle pages in a secure, navigable Markdown experience with structured metadata, citations, source inspection, and diffs, while generated content remains read-only.

**Blocked by:** 08 — Run semantic work through the selected Gateway Profile.

**Status:** ready-for-agent

- [ ] Knowledge navigation distinguishes staged and published Bundles and shows the associated Run and Source Set identities.
- [ ] The reader renders CommonMark and GFM headings, lists, tables, task lists, links, images, and fenced code.
- [ ] Syntax highlighting, Mermaid diagrams, and mathematical notation render under restrictive, deterministic security policies.
- [ ] Frontmatter is presented as structured metadata rather than executable content.
- [ ] Claim markers and citations open accepted Claim details and exact Evidence Reference excerpts.
- [ ] Internal links, outlines, backlinks, and lexical search make all reachable Bundle pages navigable.
- [ ] A source/rendered toggle shows the exact generated Markdown without allowing edits.
- [ ] Unified and split diffs compare relevant staged, published, and previous page versions.
- [ ] Raw HTML, scripts, dangerous URLs, remote iframes, MDX, and repository-provided browser code never execute.
- [ ] Oversized, malformed, non-UTF-8, broken-link, and missing-page cases fail safely with actionable presentation.
- [ ] Reader controls are keyboard accessible, preserve focus, and expose equivalent information to assistive technology.
- [ ] Security fixtures and browser tests cover Markdown fidelity, navigation, citations, backlinks, search, diff, sanitization, CSP, and offline rendering.
