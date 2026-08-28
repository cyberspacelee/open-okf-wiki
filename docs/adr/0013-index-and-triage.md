# Per-Source bounded Index and Triage replace file-count splitting

`run start` writes one versioned, 64 KiB structural Index per Git/files Pin,
then creates one `triage:<source>` Target. Triage must cover every eligible
file exactly once as `deep`, `standard` or `inventory`; configured exclusions
remain workspace policy, configured splits remain independent non-excluded
scopes, and uncertain or protected paths stay semantic. Inventory is only a
Coverage Ledger entry and creates no Finding or survey Target.

The Index collapses directory nodes that have no direct files and only one
child, while preserving the root, branches, file-bearing directories and
configured splits. This keeps Java-style package chains compact without
language-specific parsing. If the bounded Index is truncated or ambiguous,
an in-progress Triage task can page through direct children with `task ls`.
Survey does not receive the Index: the same command is bound to the Survey
task's captured Pin and scope, and source content is then inspected with
targeted host tools. Each listing is stable, non-recursive and byte-bounded.

We rejected a workspace-wide triage artifact, the old 200-file splitter, and
parser/ranking infrastructure. Per-Source targets bound context and failure
blast radius; counts, entry/generated markers, test adjacency and small
samples provide enough routing signal without pretending structure proves
semantic importance. We also rejected per-Target manifests, language-aware
package parsing, a repository query DSL, task-specific grep/cat tools and
compatibility branches. This amends ADR 0005's survey-task generation.
