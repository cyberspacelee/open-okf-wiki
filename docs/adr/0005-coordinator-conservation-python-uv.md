# Coordinator context conservation with disk-first orchestration

The skill's orchestration model: the coordinating session never reads source
or Wiki bodies — subagents do, returning receipts of at most 10 lines while
knowledge flows through drafts on disk. Task truth lives in
`.okf-wiki/runs/<id>/state.json`, so context compaction is survivable by design rather
than detected: a re-anchor protocol (run status + reread current phase
reference) rebuilds orientation for a few hundred tokens at any moment, in any
host. Subagent tasks are self-contained (paths in, paths out, no conversation
dependency) and completion passes through the State Gate, so a subagent's
claim of success is arbitrated by the validator, not trusted.

Tooling: Python 3.12+, PEP 723 inline metadata and `uv run`. PyYAML parses
bounded YAML and rejects aliases/duplicate keys; Pydantic validates external
models; psycopg provides read-only catalog access.

Multi-source workspaces are first-class: sources register via
`okf.py source add` (link or clone), locators carry a source-name prefix, and
a single synthesize pass fans in all survey drafts before root pages are
written — the v1 fan-in gate kept, its host machinery replaced by one phase
in the state sequence.

Considered: conversation-checkpoint injection (v1) — rejected as
host-specific; JS for kernel porting — rejected once the v1 kernel measured
only ~500-800 effective lines, making rewrite cost trivial against the
Python-leaning 2026 skill ecosystem; and a single-source-only scope — rejected
because multi-repo workspaces are a primary use case and retrofitting
source prefixes into citations later would break every published locator.
