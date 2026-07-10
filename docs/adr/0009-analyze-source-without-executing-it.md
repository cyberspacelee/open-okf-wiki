# Analyze source without executing it

The Producer treats repositories as untrusted read-only Source Snapshots and performs static analysis only. It does not run builds, tests, compilers, annotation processors, package managers, repository scripts, or arbitrary shell commands; repository instructions and generated output are analyzed as data, Agents can only use allowlisted read/search tools and submit typed proposals, and publication remains a separate deterministic operation over accepted state.
