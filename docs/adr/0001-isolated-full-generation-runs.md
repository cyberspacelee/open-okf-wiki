# Isolated full-generation runs

Every Run starts from an empty Candidate and generates a Wiki from Sources
pinned for that Run. A Workspace admits one non-terminal Run. The Published Wiki
is provenance, not generation input.

This rejects incremental refresh of `wiki/` from a prior Run so evidence
freshness does not depend on hidden history.
