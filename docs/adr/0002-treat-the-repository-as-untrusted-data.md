# Treat the repository as untrusted data

Every Repository Snapshot is mounted read-only and analyzed as data. A Wiki Run does not execute repository builds, tests, package managers, scripts, plugins, or repository-provided agent and Skill instructions, and it exposes no external network tool beyond the configured model connection; any future source execution requires a separate sandbox policy and architectural decision.
