# Per-Source bounded Index and Triage replace file-count splitting

`run start` writes one versioned, 64 KiB structural Index per Git/files Pin,
then creates one `triage:<source>` Target. Triage must cover every eligible
file exactly once as `deep`, `standard` or `inventory`; configured exclusions
remain workspace policy, configured splits remain independent non-excluded
scopes, and uncertain or protected paths stay semantic. Inventory is only a
Coverage Ledger entry and creates no Finding or survey Target.

We rejected a workspace-wide triage artifact, the old 200-file splitter, and
parser/ranking infrastructure. Per-Source targets bound context and failure
blast radius; counts, entry/generated markers, test adjacency and small
samples provide enough routing signal without pretending structure proves
semantic importance. This amends ADR 0005's survey-task generation.
