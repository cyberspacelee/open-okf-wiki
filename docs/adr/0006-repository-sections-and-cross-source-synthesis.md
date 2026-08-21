# Repository sections and cross-Source synthesis

Explicit Workspaces organize all repository, domain, and concept knowledge
under `repos/<scopeId>/`; Workspace root pages own only cross-Source knowledge.
Multi-Source Runs execute N Source surveys in parallel, then one read-only
cross-Source synthesis after the N handoffs complete, before any writing. This
trades workspace-global domain merging for clear repository ownership and a
stable fan-in point; implicit single-Source Workspaces keep their compact root
layout.
