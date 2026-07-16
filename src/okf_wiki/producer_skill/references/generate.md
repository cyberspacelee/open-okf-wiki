# Generate

Start from the empty Staging Wiki.

1. Find each repository's stated purpose, executable or library entry points, public interfaces,
   major directories, configuration, and tests that reveal intended behavior (tests remaining in
   the Snapshot are evidence, not noise). Use any Host inventory only as a discovery aid. Identify
   how the repositories relate before deciding the Wiki shape.
2. Follow high-signal dependencies and call paths until the important boundaries, modules, flows,
   and domain concepts are understood. Branch according to what the repository contains rather than
   classifying the Repository Snapshot Set into a fixed project type.
3. Draft the smallest useful page set. Ensure `index.md` explains the purpose, audience, main
   capabilities, and where to continue. Add other pages only when they answer a distinct reader
   question.
4. Write and cross-link the pages, then proceed to the review reference.

Generation is complete when a new reader can enter at `index.md`, navigate the important ideas, and
verify every page against its Source Citations without encountering padding or unexplained gaps.
