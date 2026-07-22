# Generate

Start from the empty Staging Wiki.

1. Find each repository's stated purpose, executable or library entry points, public interfaces,
   major directories, configuration, and tests that reveal intended behavior (tests remaining in
   the Snapshot are evidence, not noise). Use any run inventory only as a discovery aid. Identify
   how the repositories relate before deciding the Wiki shape.
2. Follow high-signal dependencies and call paths until the important boundaries, modules, flows,
   and domain concepts are understood. Branch according to what the repository contains rather than
   classifying the Repository Snapshot Set into a fixed project type.
3. Draft the smallest useful **concept page** set. Ensure root narrative **`overview.md`** explains
   the purpose, audience, main capabilities, and where to continue. Add other concept pages only when
   they answer a distinct reader question. Do **not** draft reserved `index.md` or `log.md`—the Run
   Boundary owns those on publish.
4. Write and cross-link the concept pages (OKF frontmatter; concept edges page-relative or wiki-root
   Concept-ID form; only link pages you write; Related lists = one link per line with `—` edge
   description; `repo:` URIs only
   under `# Citations`), then proceed to the review reference.

Generation is complete when a new reader can enter at **`overview.md`**, navigate the important
ideas through concept links, and verify material claims against each page’s `# Citations` list
without encountering padding or unexplained gaps.
