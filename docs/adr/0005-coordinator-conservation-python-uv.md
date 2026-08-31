# Coordinator context conservation with disk-first orchestration

Status: superseded by ADR 0019

The coordinating session never reads source, draft, candidate or Wiki bodies.
Workers do content work and return bounded handoffs that name disk artifacts;
the coordinator consumes only compact status, task dispatch packets, handoffs
and validator issues. If the host cannot provide workers, the Run stops instead
of falling back to serial coordinator work.

The former Target dispatcher stored task truth under the Run directory and
returned path-only packets so compaction did not require replaying prior prose.
ADR 0019 replaced that scheduler state with derived status and fixed living
Artifacts while retaining deterministic validation.

Tooling: Python 3.12+, PEP 723 inline metadata and `uv run`. PyYAML parses
bounded YAML and rejects aliases/duplicate keys; Pydantic validates external
models; psycopg provides read-only catalog access.

Multi-source workspaces are first-class: sources register via
`okf.py source add` (link or clone), locators carry a source-name prefix.
Cross-source fan-in is a CLI Compose Gate after sharded connect and plan
tasks (ADR 0009), not a single synthesize worker.

Considered: conversation-checkpoint injection (v1) — rejected as
host-specific; JS for kernel porting — rejected once the v1 kernel measured
only ~500-800 effective lines, making rewrite cost trivial against the
Python-leaning 2026 skill ecosystem; and a single-source-only scope — rejected
because multi-repo workspaces are a primary use case and retrofitting
source prefixes into citations later would break every published locator.
