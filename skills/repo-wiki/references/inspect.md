# Inspect the workspace

You (the coordinator) do this yourself — no subagent, no deep reading. The
goal is a shape map that sizes the survey batch, not understanding.

For each source, collect only:

- top-level directory layout (`ls`, one level, two for monorepos)
- build manifests (pom.xml, build.gradle, package.json, pyproject.toml, …):
  module list, primary language
- README title block, if present — nothing deeper

Then register one inspect target per source
(`state start --phase inspect --target <source>`, then `state complete`) and
decide the survey partitioning: one target per source; split a source into
per-area targets only when it is a large monorepo (roughly, more than ~15
modules or mixed unrelated products).

Do not open source files. Anything worth knowing at file depth belongs to
survey.
