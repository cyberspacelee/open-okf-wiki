# 04 — Wiki Visualization generator and CLI

**What to build:** Operators can generate a deterministic, read-only static HTML Wiki Visualization (including a page link graph) from an existing Published Wiki without running the model or mutating wiki page bytes.

**Blocked by:** None — can start immediately (parallel with 01–03)

**Status:** resolved

## Comments

- 2026-07-17: Implemented in source-scope-and-wiki-visualization work.

- [x] An explicit CLI (or Host operation) accepts a Published Wiki path and writes visualization artifacts outside the semantic page set (or under a reserved non-page visualization location).
- [x] Generation is deterministic for a given generator version and wiki content; it does not call the model provider.
- [x] Link-graph nodes are published markdown pages; edges are internal links resolved with the same rules as wiki internal-link validation; external URLs and Source Citations are not edges unless they are ordinary internal page links.
- [x] Broken internal links are visible rather than silently fabricated as live nodes.
- [x] Mermaid fences in page content can render in the visualization layer; published Wiki pages still must not embed raw HTML.
- [x] Generation does not modify Published Wiki markdown page content.
- [x] Deterministic tests on a fixture Published Wiki assert graph JSON/HTML existence, node/edge shape, non-mutation of pages, and no provider calls.
